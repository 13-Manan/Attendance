"""The Azure AI Face backend, against a fake Azure.

Nothing here reaches the real service. ``FakeAzure`` is an
``httpx.MockTransport`` that answers the endpoints this product uses with the
response shapes recorded from a live Detect call (detection_03 with quality
attributes and 27-point landmarks), and keeps LargePersonGroups in memory so
enrolment and identification can be exercised end to end.

The key used here is a fixed dummy. Several tests assert it never appears in
an error message, a log line or a response body.
"""

from __future__ import annotations

import base64
import itertools
import json
import logging
from typing import Any

import cv2
import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.azure_face import (
    AzureFaceAuthError,
    AzureFaceClient,
    AzureFaceNotApprovedError,
    AzureFaceNotConfiguredError,
    AzureFaceUnavailableError,
    batched,
)
from app.config import MODEL_REGISTRY, Settings, build_provider, get_model
from app.main import app
from app.models.azure_provider import (
    AzureFaceModelProvider,
    assess_enrollment,
    landmarks_from_azure,
)
from app.models.base import ProviderCapabilityError
from app.models.opencv_provider import ImageDecodeError
from app.schemas import GalleryRemoval, GalleryTarget, SessionImageInput

ENDPOINT = "https://unit-test-face.cognitiveservices.azure.com/"
DUMMY_KEY = "dummy-key-for-unit-tests-0123456789abcdef"


# ---------------------------------------------------------------------------
# Synthetic faces and images
# ---------------------------------------------------------------------------


def face(
    who: str,
    *,
    left: int = 100,
    top: int = 100,
    size: int = 160,
    quality: str = "high",
    blur: str = "low",
    exposure: str = "goodExposure",
    yaw: float = 0.0,
    pitch: float = 0.0,
    roll: float = 0.0,
    occluded: bool = False,
    mask: str = "noMask",
) -> dict[str, Any]:
    """One Azure detect entry. ``_who`` is the fake's ground truth and is
    stripped before the entry is returned."""
    eye_y = top + size * 0.4
    return {
        "_who": who,
        "faceRectangle": {"top": top, "left": left, "width": size, "height": size},
        "faceLandmarks": {
            # Viewer's left, i.e. the subject's right eye.
            "pupilLeft": {"x": left + size * 0.3, "y": eye_y},
            "pupilRight": {"x": left + size * 0.7, "y": eye_y},
            "noseTip": {"x": left + size * 0.5, "y": top + size * 0.6},
            "mouthLeft": {"x": left + size * 0.35, "y": top + size * 0.8},
            "mouthRight": {"x": left + size * 0.65, "y": top + size * 0.8},
        },
        "faceAttributes": {
            "headPose": {"pitch": pitch, "roll": roll, "yaw": yaw},
            "blur": {"blurLevel": blur, "value": 0.1},
            "exposure": {"exposureLevel": exposure, "value": 0.5},
            "occlusion": {
                "foreheadOccluded": False,
                "eyeOccluded": occluded,
                "mouthOccluded": False,
            },
            "mask": {"type": mask, "noseAndMouthCovered": mask == "faceMask"},
            "qualityForRecognition": quality,
        },
    }


_shade = itertools.count(1)


def image() -> tuple[str, bytes]:
    """A small real PNG, unique per call so the fake can tell images apart.
    No person is depicted: the fake decides who is "in" it."""
    value = next(_shade) % 250
    pixels = np.full((48, 64, 3), value, dtype=np.uint8)
    pixels[0, 0] = (next(_shade) % 250, 7, 11)
    ok, encoded = cv2.imencode(".png", pixels)
    assert ok
    raw = encoded.tobytes()
    return base64.b64encode(raw).decode(), raw


# ---------------------------------------------------------------------------
# The fake service
# ---------------------------------------------------------------------------


class FakeAzure:
    def __init__(self, *, approved: bool = True) -> None:
        self.approved = approved
        self.key = DUMMY_KEY
        self.faces_by_image: dict[bytes, list[dict[str, Any]]] = {}
        self.face_ids: dict[str, str] = {}
        self.galleries: dict[str, dict[str, Any]] = {}
        #: who -> {other who: confidence}. Identify reports these as well.
        self.lookalikes: dict[str, dict[str, float]] = {}
        self.requests: list[httpx.Request] = []
        #: (method, path suffix) -> statuses to answer before behaving.
        self.fail: dict[tuple[str, str], list[int]] = {}
        self._ids = itertools.count(1)

    def put(self, raw: bytes, *faces: dict[str, Any]) -> None:
        self.faces_by_image[raw] = list(faces)

    # -- helpers --------------------------------------------------------------

    def _next(self, prefix: str) -> str:
        return f"{prefix}{next(self._ids):04d}"

    @staticmethod
    def _error(status: int, code: str, inner: str | None = None) -> httpx.Response:
        body: dict[str, Any] = {"error": {"code": code, "message": "fake"}}
        if inner:
            body["error"]["innererror"] = {"code": inner, "message": "fake"}
        return httpx.Response(status, json=body)

    def _not_approved(self) -> httpx.Response:
        return self._error(403, "InvalidRequest", "UnsupportedFeature")

    def persons_matching(self, gallery_id: str, who: str) -> list[tuple[str, float]]:
        gallery = self.galleries[gallery_id]
        out = []
        for person_id, person in gallery["persons"].items():
            whos = set(person["faces"].values())
            if not whos:
                continue
            if who in whos:
                out.append((person_id, 0.92))
                continue
            best = max(
                (self.lookalikes.get(who, {}).get(w, 0.0) for w in whos), default=0.0
            )
            if best:
                out.append((person_id, best))
        return sorted(out, key=lambda p: -p[1])

    # -- transport ----------------------------------------------------------------

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if request.headers.get("Ocp-Apim-Subscription-Key") != self.key:
            return self._error(401, "401", None)
        path = request.url.path.removeprefix("/face/v1.0")
        for (method, suffix), queue in self.fail.items():
            if request.method == method and path.endswith(suffix) and queue:
                status = queue.pop(0)
                return self._error(status, "InternalServerError")
        return self._route(request, path)

    def _route(self, request: httpx.Request, path: str) -> httpx.Response:
        method = request.method
        parts = [p for p in path.split("/") if p]
        if path == "/detect":
            wants_id = request.url.params.get("returnFaceId") == "true"
            if wants_id and not self.approved:
                return self._not_approved()
            out = []
            for entry in self.faces_by_image.get(request.content, []):
                entry = {k: v for k, v in entry.items() if k != "_who"}
                if wants_id:
                    face_id = self._next("face-")
                    self.face_ids[face_id] = self.faces_by_image[request.content][
                        len(out)
                    ]["_who"]
                    entry["faceId"] = face_id
                out.append(entry)
            return httpx.Response(200, json=out)

        if not self.approved:
            return self._not_approved()

        if path == "/largepersongroups" and method == "GET":
            return httpx.Response(200, json=[])
        if path == "/identify":
            return self._identify(request)
        if path == "/verify":
            return self._verify(request)
        if parts[0] != "largepersongroups":
            return self._error(404, "NotFound")
        gallery_id = parts[1]
        gallery = self.galleries.get(gallery_id)
        if len(parts) == 2:
            if method == "PUT":
                self.galleries[gallery_id] = {"persons": {}, "trained": False}
                return httpx.Response(200)
            if gallery is None:
                return self._error(404, "LargePersonGroupNotFound")
            return httpx.Response(200, json={"largePersonGroupId": gallery_id})
        if gallery is None:
            return self._error(404, "LargePersonGroupNotFound")
        if parts[2] == "train":
            gallery["trained"] = True
            return httpx.Response(202)
        if parts[2] == "training":
            status = "succeeded" if gallery["trained"] else "notstarted"
            return httpx.Response(200, json={"status": status})
        if parts[2] == "persons":
            if len(parts) == 3 and method == "POST":
                person_id = self._next("person-")
                gallery["persons"][person_id] = {"faces": {}}
                return httpx.Response(200, json={"personId": person_id})
            person = gallery["persons"].get(parts[3])
            if person is None:
                return self._error(404, "PersonNotFound")
            if len(parts) == 4 and method == "DELETE":
                del gallery["persons"][parts[3]]
                return httpx.Response(200)
            if len(parts) == 5 and method == "POST":
                entries = self.faces_by_image.get(request.content, [])
                target = request.url.params["targetFace"]
                chosen = next(
                    e
                    for e in entries
                    if "{left},{top},{width},{height}".format(**e["faceRectangle"])
                    == target
                )
                persisted = self._next("pf-")
                person["faces"][persisted] = chosen["_who"]
                return httpx.Response(200, json={"persistedFaceId": persisted})
            if len(parts) == 6 and method == "DELETE":
                if person["faces"].pop(parts[5], None) is None:
                    return self._error(404, "PersistedFaceNotFound")
                return httpx.Response(200)
        return self._error(404, "NotFound")

    def _identify(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert len(body["faceIds"]) <= 10, "Azure caps Identify at 10 faces"
        gallery_id = body["largePersonGroupId"]
        gallery = self.galleries.get(gallery_id)
        if gallery is None:
            return self._error(404, "LargePersonGroupNotFound")
        if not gallery["trained"]:
            return self._error(409, "LargePersonGroupNotTrained")
        out = []
        for face_id in body["faceIds"]:
            who = self.face_ids[face_id]
            matches = [
                {"personId": pid, "confidence": conf}
                for pid, conf in self.persons_matching(gallery_id, who)
                if conf >= body["confidenceThreshold"]
            ][: body["maxNumOfCandidatesReturned"]]
            out.append({"faceId": face_id, "candidates": matches})
        return httpx.Response(200, json=out)

    def _verify(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        who = self.face_ids[body["faceId"]]
        gallery = self.galleries[body["largePersonGroupId"]]
        person = gallery["persons"].get(body["personId"])
        if person is None:
            return self._error(404, "PersonNotFound")
        confidence = 0.9 if who in set(person["faces"].values()) else 0.1
        return httpx.Response(
            200, json={"isIdentical": confidence >= 0.5, "confidence": confidence}
        )

    # -- inspection -----------------------------------------------------------

    def calls(self, method: str, path: str) -> list[httpx.Request]:
        return [
            r
            for r in self.requests
            if r.method == method and r.url.path.removeprefix("/face/v1.0") == path
        ]


def make_client(fake: FakeAzure, **kwargs: Any) -> AzureFaceClient:
    return AzureFaceClient(
        ENDPOINT,
        DUMMY_KEY,
        transport=httpx.MockTransport(fake.handler),
        sleep=lambda _s: None,
        **kwargs,
    )


def make_provider(fake: FakeAzure) -> AzureFaceModelProvider:
    provider = AzureFaceModelProvider(
        ENDPOINT, DUMMY_KEY, client_factory=lambda: make_client(fake)
    )
    provider.load()
    return provider


GALLERY = "att-cohort1"


# ---------------------------------------------------------------------------
# Configuration and credentials
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("endpoint,key", [(None, DUMMY_KEY), (ENDPOINT, None)])
def test_the_backend_refuses_to_start_without_both_settings(endpoint, key):
    provider = AzureFaceModelProvider(endpoint, key)
    with pytest.raises(AzureFaceNotConfiguredError) as excinfo:
        provider.load()
    assert DUMMY_KEY not in str(excinfo.value)


def test_a_plain_http_endpoint_is_refused():
    with pytest.raises(AzureFaceNotConfiguredError):
        AzureFaceClient("http://example.test/", DUMMY_KEY)


def test_settings_keep_the_key_out_of_their_repr(monkeypatch):
    monkeypatch.setenv("AZURE_FACE_KEY", DUMMY_KEY)
    settings = Settings()
    assert DUMMY_KEY not in repr(settings)
    assert settings.azure_face_key.get_secret_value() == DUMMY_KEY


def test_build_provider_wires_the_azure_settings(monkeypatch):
    monkeypatch.setenv("AZURE_FACE_ENDPOINT", ENDPOINT)
    monkeypatch.setenv("AZURE_FACE_KEY", DUMMY_KEY)
    settings = Settings(
        face_model_backend="azure", face_ai_require_production_model=True
    )
    provider = build_provider(settings)
    assert isinstance(provider, AzureFaceModelProvider)
    assert MODEL_REGISTRY["azure"].commercial_use == "permitted"


def test_the_key_travels_only_in_the_subscription_header():
    fake = FakeAzure()
    make_client(fake).probe_identification()
    request = fake.requests[0]
    assert request.headers["Ocp-Apim-Subscription-Key"] == DUMMY_KEY
    assert DUMMY_KEY not in str(request.url)


def test_a_wrong_key_fails_startup_without_echoing_it(caplog):
    fake = FakeAzure()
    fake.key = "the-real-one"
    provider = AzureFaceModelProvider(
        ENDPOINT, DUMMY_KEY, client_factory=lambda: make_client(fake)
    )
    with caplog.at_level(logging.DEBUG), pytest.raises(AzureFaceAuthError) as excinfo:
        provider.load()
    assert DUMMY_KEY not in str(excinfo.value)
    assert DUMMY_KEY not in caplog.text


def test_an_unreachable_azure_does_not_fail_startup():
    def down(_request):
        raise httpx.ConnectError("unreachable")

    provider = AzureFaceModelProvider(
        ENDPOINT,
        DUMMY_KEY,
        client_factory=lambda: AzureFaceClient(
            ENDPOINT,
            DUMMY_KEY,
            transport=httpx.MockTransport(down),
            sleep=lambda _s: None,
        ),
    )
    provider.load()
    assert provider.identification_status() == "unavailable"


# ---------------------------------------------------------------------------
# Transport behaviour
# ---------------------------------------------------------------------------


def test_limited_access_gate_is_reported_as_not_approved():
    fake = FakeAzure(approved=False)
    assert make_client(fake).probe_identification() == "not_approved"
    with pytest.raises(AzureFaceNotApprovedError) as excinfo:
        make_client(fake).ensure_gallery(GALLERY)
    assert "aka.ms/facerecognition" in str(excinfo.value)


def test_rate_limiting_is_retried():
    fake = FakeAzure()
    fake.fail[("GET", "/largepersongroups")] = [429]
    assert make_client(fake).probe_identification() == "enabled"
    assert len(fake.requests) == 2


def test_server_errors_are_retried_only_for_idempotent_calls():
    fake = FakeAzure()
    fake.galleries[GALLERY] = {"persons": {}, "trained": False}
    fake.fail[("POST", "/persons")] = [503]
    with pytest.raises(AzureFaceUnavailableError):
        make_client(fake).create_person(GALLERY, "student1")
    # One attempt: retrying a create could leave two persons behind.
    assert len(fake.calls("POST", f"/largepersongroups/{GALLERY}/persons")) == 1

    fake.fail[("GET", f"/largepersongroups/{GALLERY}")] = [500, 502]
    assert make_client(fake).ensure_gallery(GALLERY) is False


def test_a_timeout_becomes_unavailable_after_the_retries():
    attempts = []

    def slow(request):
        attempts.append(request)
        raise httpx.ReadTimeout("slow", request=request)

    client = AzureFaceClient(
        ENDPOINT,
        DUMMY_KEY,
        transport=httpx.MockTransport(slow),
        sleep=lambda _s: None,
        max_retries=2,
    )
    _, raw = image()
    with pytest.raises(AzureFaceUnavailableError) as excinfo:
        client.detect(raw, return_face_id=False)
    assert len(attempts) == 3
    assert DUMMY_KEY not in str(excinfo.value)


def test_batching_splits_34_into_10_10_10_4():
    assert [len(b) for b in batched([str(i) for i in range(34)], 10)] == [10, 10, 10, 4]
    assert batched([], 10) == []


def test_identify_merges_every_batch_into_one_answer():
    fake = FakeAzure()
    fake.galleries[GALLERY] = {"persons": {}, "trained": True}
    face_ids = [f"face-x{i}" for i in range(34)]
    for face_id in face_ids:
        fake.face_ids[face_id] = "nobody"
    result = make_client(fake).identify(
        face_ids, GALLERY, max_candidates=3, confidence_threshold=0.5
    )
    sizes = [len(json.loads(r.content)["faceIds"]) for r in fake.requests]
    assert sizes == [10, 10, 10, 4]
    assert set(result) == set(face_ids)


# ---------------------------------------------------------------------------
# Mapping Azure's response
# ---------------------------------------------------------------------------


def test_landmarks_follow_the_contract_convention():
    entry = face("a", left=0, size=100)
    marks = landmarks_from_azure(entry)
    # rightEye is the subject's right eye, which is on the viewer's left.
    assert marks.right_eye.x < marks.left_eye.x
    assert marks.right_eye.x == entry["faceLandmarks"]["pupilLeft"]["x"]
    assert marks.mouth_right.x == entry["faceLandmarks"]["mouthLeft"]["x"]
    assert landmarks_from_azure({"faceLandmarks": {"pupilLeft": {}}}) is None


@pytest.mark.parametrize(
    "faces,expected",
    [
        ([], "no_face"),
        ([face("a"), face("b", left=400)], "multiple_faces"),
        ([face("a", size=80)], "face_too_small"),
        ([face("a", quality="medium")], "low_quality"),
        ([face("a", blur="medium")], "blurred"),
        ([face("a", exposure="underExposure")], "too_dark"),
        ([face("a", exposure="overExposure")], "too_bright"),
        ([face("a", yaw=40.0)], "bad_angle"),
        ([face("a", roll=35.0)], "bad_angle"),
        ([face("a", occluded=True)], "occluded"),
        ([face("a", mask="faceMask")], "occluded"),
        ([face("a")], "ok"),
    ],
)
def test_enrolment_quality_gates(faces, expected):
    assessment = assess_enrollment(faces)
    assert assessment.reason == expected
    if expected == "ok":
        assert assessment.reasons == []
        assert assessment.metrics.face_size.value == 160.0


def test_every_failed_check_is_reported():
    assessment = assess_enrollment([face("a", size=60, blur="high", quality="low")])
    assert assessment.reasons == ["face_too_small", "blurred", "low_quality"]


# ---------------------------------------------------------------------------
# Provider: identity, detection and the embedding routes
# ---------------------------------------------------------------------------


def test_model_info_describes_a_gallery_backend():
    provider = make_provider(FakeAzure(approved=False))
    info = provider.model_info()
    assert info.model_name == "azure-face"
    assert info.template_kind == "gallery"
    assert info.identification == "not_approved"
    assert info.production_eligible is True
    assert DUMMY_KEY not in info.model_dump_json()
    assert "cognitiveservices" not in info.model_dump_json()


def test_approval_is_picked_up_without_a_restart():
    fake = FakeAzure(approved=False)
    now = [0.0]
    provider = AzureFaceModelProvider(
        ENDPOINT,
        DUMMY_KEY,
        client_factory=lambda: make_client(fake),
        clock=lambda: now[0],
    )
    provider.load()
    assert provider.identification_status() == "not_approved"
    fake.approved = True
    assert provider.identification_status() == "not_approved"  # cached
    now[0] += AzureFaceModelProvider.PROBE_TTL_S + 1
    assert provider.identification_status() == "enabled"


def test_detect_uses_azure_and_never_asks_for_a_face_id():
    fake = FakeAzure(approved=False)
    provider = make_provider(fake)
    b64, raw = image()
    fake.put(raw, face("a"), face("b", left=400))
    result = provider.detect(b64)
    assert len(result.faces) == 2
    assert (result.image_width, result.image_height) == (64, 48)
    detect = fake.calls("POST", "/detect")[0]
    assert detect.url.params["returnFaceId"] == "false"
    assert detect.url.params["detectionModel"] == "detection_03"


def test_an_undecodable_image_never_leaves_the_process():
    fake = FakeAzure()
    provider = make_provider(fake)
    with pytest.raises(ImageDecodeError):
        provider.assess_quality(base64.b64encode(b"not an image").decode())
    assert fake.calls("POST", "/detect") == []


def test_the_embedding_routes_refuse_rather_than_pretend():
    provider = make_provider(FakeAzure())
    b64, _ = image()
    for call in (
        lambda: provider.embed(b64),
        lambda: provider.enroll_image(b64),
        lambda: provider.analyze_image(
            SessionImageInput(sequenceNumber=1, imageBase64=b64)
        ),
        lambda: provider.detect_and_embed(
            SessionImageInput(sequenceNumber=1, imageBase64=b64)
        ),
        lambda: provider.compare_embeddings([1.0], [1.0]),
    ):
        with pytest.raises(ProviderCapabilityError):
            call()


# ---------------------------------------------------------------------------
# Provider: gallery enrolment
# ---------------------------------------------------------------------------


def target(person_id: str | None = None, gallery: str = GALLERY) -> GalleryTarget:
    return GalleryTarget(galleryId=gallery, personId=person_id, personName="stu_1")


def enroll(provider, fake, who, *, targets=None, **face_kw):
    b64, raw = image()
    fake.put(raw, face(who, **face_kw))
    return provider.gallery_enroll(b64, targets or [target()], 0.7, 0.5)


def test_enrolment_needs_identification_approval():
    fake = FakeAzure(approved=False)
    provider = make_provider(fake)
    b64, _ = image()
    with pytest.raises(AzureFaceNotApprovedError):
        provider.gallery_enroll(b64, [target()], 0.7, 0.5)
    # Decided before any image was sent anywhere.
    assert fake.calls("POST", "/detect") == []


def test_a_first_sample_creates_the_person_and_trains():
    fake = FakeAzure()
    provider = make_provider(fake)
    response = enroll(provider, fake, "alice")
    assert response.outcome == "accepted"
    [placement] = response.placements
    assert placement.person_created is True
    assert fake.galleries[GALLERY]["persons"][placement.person_id]["faces"] == {
        placement.persisted_face_id: "alice"
    }
    assert fake.galleries[GALLERY]["trained"] is True
    # The person name stored in Azure is the opaque id, never a real name.
    create = fake.calls("POST", f"/largepersongroups/{GALLERY}/persons")[0]
    assert b"stu_1" in create.content


def test_a_further_sample_verifies_and_reuses_the_person():
    fake = FakeAzure()
    provider = make_provider(fake)
    first = enroll(provider, fake, "alice").placements[0]
    second = enroll(provider, fake, "alice", targets=[target(first.person_id)])
    assert second.outcome == "accepted"
    assert second.placements[0].person_id == first.person_id
    assert second.placements[0].person_created is False
    assert second.own_confidence == 0.9
    assert len(fake.galleries[GALLERY]["persons"]) == 1


def test_a_face_already_enrolled_as_someone_else_is_refused():
    fake = FakeAzure()
    provider = make_provider(fake)
    alice = enroll(provider, fake, "alice").placements[0]
    response = enroll(provider, fake, "alice")  # submitted for a new student
    assert response.outcome == "collision"
    assert response.collision.person_id == alice.person_id
    assert len(fake.galleries[GALLERY]["persons"]) == 1


def test_a_sample_that_does_not_match_the_students_own_person_is_refused():
    fake = FakeAzure()
    provider = make_provider(fake)
    alice = enroll(provider, fake, "alice").placements[0]
    response = enroll(provider, fake, "bob", targets=[target(alice.person_id)])
    assert response.outcome == "own_mismatch"
    assert response.own_confidence == 0.1
    person = fake.galleries[GALLERY]["persons"][alice.person_id]
    assert len(person["faces"]) == 1


def test_a_poor_sample_writes_nothing():
    fake = FakeAzure()
    provider = make_provider(fake)
    response = enroll(provider, fake, "alice", blur="high")
    assert response.outcome == "rejected"
    assert response.assessment.reason == "blurred"
    assert GALLERY not in fake.galleries


def test_a_failed_write_is_rolled_back_across_galleries():
    fake = FakeAzure()
    provider = make_provider(fake)
    other = "att-cohort2"
    # The first add succeeds and the second fails.
    original = fake._route
    adds = []

    def flaky(request, path):
        if path.endswith("/persistedfaces") and request.method == "POST":
            adds.append(path)
            if len(adds) == 2:
                return fake._error(500, "InternalServerError")
        return original(request, path)

    fake._route = flaky
    with pytest.raises(AzureFaceUnavailableError):
        enroll(provider, fake, "alice", targets=[target(), target(gallery=other)])
    for gallery_id in (GALLERY, other):
        assert fake.galleries[gallery_id]["persons"] == {}, gallery_id


def test_removal_deletes_faces_and_retrains():
    fake = FakeAzure()
    provider = make_provider(fake)
    placement = enroll(provider, fake, "alice").placements[0]
    removed = provider.gallery_remove(
        [
            GalleryRemoval(
                galleryId=GALLERY,
                personId=placement.person_id,
                persistedFaceId=placement.persisted_face_id,
            )
        ]
    )
    assert removed == 1
    assert fake.galleries[GALLERY]["persons"][placement.person_id]["faces"] == {}


# ---------------------------------------------------------------------------
# Provider: group identification
# ---------------------------------------------------------------------------


def seed(fake: FakeAzure, provider, *names: str) -> dict[str, str]:
    """Enrol each name once and return name -> personId."""
    people = {}
    for name in names:
        people[name] = enroll(provider, fake, name).placements[0].person_id
    return people


def session(*images: tuple[str, bytes]) -> list[SessionImageInput]:
    return [
        SessionImageInput(sequenceNumber=i + 1, imageBase64=b64)
        for i, (b64, _) in enumerate(images)
    ]


def test_a_group_photo_identifies_each_enrolled_face():
    fake = FakeAzure()
    provider = make_provider(fake)
    people = seed(fake, provider, "alice", "bob")
    photo = image()
    fake.put(
        photo[1],
        face("alice", left=10, size=60),
        face("bob", left=100, size=60),
        face("stranger", left=200, size=60),
    )
    response = provider.identify(GALLERY, session(photo), 5, 0.5)
    assert response.identification == "enabled"
    assert response.gallery_ready is True
    assert response.identify_batches == 1
    got = [[c.person_id for c in f.candidates] for f in response.faces]
    assert got == [[people["alice"]], [people["bob"]], []]
    assert response.images[0].detected_faces == 3


def test_a_lookalike_comes_back_as_a_second_candidate():
    fake = FakeAzure()
    provider = make_provider(fake)
    people = seed(fake, provider, "alice", "twin")
    fake.lookalikes["alice"] = {"twin": 0.88}
    photo = image()
    fake.put(photo[1], face("alice", size=60))
    [only] = provider.identify(GALLERY, session(photo), 5, 0.5).faces
    assert [c.person_id for c in only.candidates] == [people["alice"], people["twin"]]
    assert only.candidates[0].confidence > only.candidates[1].confidence


def test_low_quality_and_tiny_faces_are_reported_not_identified():
    fake = FakeAzure()
    provider = make_provider(fake)
    seed(fake, provider, "alice")
    photo = image()
    fake.put(
        photo[1],
        face("alice", left=0, size=60, quality="low"),
        face("alice", left=100, size=16),
        face("alice", left=200, size=60, quality="medium", yaw=50.0),
    )
    response = provider.identify(GALLERY, session(photo), 5, 0.5)
    assert sorted(r.reason for r in response.rejected_faces) == [
        "face_too_small",
        "low_quality",
    ]
    [kept] = response.faces
    assert "bad_angle" in kept.quality_flags
    identify = fake.calls("POST", "/identify")
    assert len(json.loads(identify[-1].content)["faceIds"]) == 1


def test_a_class_of_34_is_identified_in_four_batches_across_captures():
    fake = FakeAzure()
    provider = make_provider(fake)
    names = [f"s{i:02d}" for i in range(34)]
    people = seed(fake, provider, *names)
    first, second = image(), image()
    fake.put(
        first[1], *[face(n, left=i * 50, size=48) for i, n in enumerate(names[:20])]
    )
    fake.put(
        second[1], *[face(n, left=i * 50, size=48) for i, n in enumerate(names[20:])]
    )
    before = len(fake.calls("POST", "/identify"))
    response = provider.identify(GALLERY, session(first, second), 5, 0.5)
    batches = fake.calls("POST", "/identify")[before:]
    assert [len(json.loads(b.content)["faceIds"]) for b in batches] == [10, 10, 10, 4]
    assert response.identify_batches == 4
    assert len(response.faces) == 34
    assert {f.candidates[0].person_id for f in response.faces} == set(people.values())
    assert [f.sequence_number for f in response.faces].count(2) == 14


def test_a_class_with_no_gallery_yet_reports_faces_and_nobody():
    fake = FakeAzure()
    provider = make_provider(fake)
    photo = image()
    fake.put(photo[1], face("alice", size=60))
    response = provider.identify(GALLERY, session(photo), 5, 0.5)
    assert response.gallery_ready is False
    assert [f.candidates for f in response.faces] == [[]]


def test_an_untrained_gallery_reports_faces_and_nobody():
    fake = FakeAzure()
    provider = make_provider(fake)
    fake.galleries[GALLERY] = {"persons": {}, "trained": False}
    photo = image()
    fake.put(photo[1], face("alice", size=60))
    response = provider.identify(GALLERY, session(photo), 5, 0.5)
    assert response.gallery_ready is False


def test_without_approval_identify_degrades_to_detection_only():
    fake = FakeAzure(approved=False)
    provider = make_provider(fake)
    photo = image()
    fake.put(photo[1], face("alice", size=60), face("bob", left=300, size=60))
    response = provider.identify(GALLERY, session(photo), 5, 0.5)
    assert response.identification == "not_approved"
    assert len(response.faces) == 2
    assert all(f.candidates == [] for f in response.faces)
    assert response.identify_batches == 0
    assert all(
        r.url.params.get("returnFaceId") == "false"
        for r in fake.calls("POST", "/detect")
    )


def test_approval_withdrawn_mid_request_degrades_instead_of_failing():
    fake = FakeAzure()
    provider = make_provider(fake)
    fake.approved = False  # the cached status still says enabled
    photo = image()
    fake.put(photo[1], face("alice", size=60))
    response = provider.identify(GALLERY, session(photo), 5, 0.5)
    assert response.identification == "not_approved"
    assert len(response.faces) == 1


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@pytest.fixture
def azure_client():
    fake = FakeAzure()
    provider = make_provider(fake)
    app.dependency_overrides[get_model] = lambda: provider
    try:
        with TestClient(app) as client:
            yield client, fake, provider
    finally:
        app.dependency_overrides.pop(get_model, None)


def test_gallery_routes_refuse_an_embedding_backend():
    with TestClient(app) as client:  # the default mock backend
        b64, _ = image()
        response = client.post(
            "/v1/identify",
            json={
                "galleryId": GALLERY,
                "sessionId": "s1",
                "images": [{"sequenceNumber": 1, "imageBase64": b64}],
            },
        )
    assert response.status_code == 409
    assert response.json()["detail"] == "unsupported_by_backend"


def test_embedding_routes_refuse_the_azure_backend(azure_client):
    client, _, _ = azure_client
    b64, _ = image()
    response = client.post(
        "/v1/detect-embed",
        json={"sessionId": "s1", "images": [{"sequenceNumber": 1, "imageBase64": b64}]},
    )
    assert response.status_code == 409


def test_identify_route_round_trips(azure_client):
    client, fake, provider = azure_client
    people = seed(fake, provider, "alice")
    b64, raw = image()
    fake.put(raw, face("alice", size=60))
    response = client.post(
        "/v1/identify",
        json={
            "galleryId": GALLERY,
            "sessionId": "s1",
            "images": [{"sequenceNumber": 1, "imageBase64": b64}],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["faces"][0]["candidates"][0]["personId"] == people["alice"]
    assert "embedding" not in body["faces"][0]
    assert DUMMY_KEY not in response.text


def test_an_azure_failure_is_a_bare_code(azure_client, caplog):
    client, fake, _ = azure_client
    fake.approved = False
    fake.key = "rotated"
    b64, _ = image()
    with caplog.at_level(logging.DEBUG):
        response = client.post("/v1/quality", json={"imageBase64": b64})
    assert response.status_code == 502
    assert response.json() == {"detail": "azure_face_auth_failed"}
    assert DUMMY_KEY not in caplog.text


def test_enrolment_without_approval_is_a_409(azure_client):
    client, fake, provider = azure_client
    fake.approved = False
    provider._record("not_approved")
    b64, _ = image()
    response = client.post(
        "/v1/gallery/enroll",
        json={
            "imageBase64": b64,
            "targets": [{"galleryId": GALLERY, "personName": "stu_1"}],
        },
    )
    assert response.status_code == 409
    assert response.json() == {"detail": "identification_not_approved"}


def test_a_gallery_id_outside_the_pattern_is_refused(azure_client):
    client, _, _ = azure_client
    b64, _ = image()
    response = client.post(
        "/v1/identify",
        json={
            "galleryId": "Has Spaces",
            "sessionId": "s1",
            "images": [{"sequenceNumber": 1, "imageBase64": b64}],
        },
    )
    assert response.status_code == 422
