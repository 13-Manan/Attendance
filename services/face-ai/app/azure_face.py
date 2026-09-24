"""HTTP client for Azure AI Face (Cognitive Services Face API v1.0).

This module is the only code in the repository that talks to Azure Face, and
it runs only inside this service. apps/web never sees the endpoint or the key,
and neither does the browser. The key goes in the ``Ocp-Apim-Subscription-Key``
header and nowhere else. It is never logged or put in an exception message,
and it is never echoed back in a response.

## What is gated and what is not

Azure Face is a Limited Access service. Every subscription can call
``detect`` with the quality attributes. Anything that produces or uses a
``faceId`` needs Microsoft's separate Identification/Verification approval:
``returnFaceId=true``, PersonGroups/LargePersonGroups, Identify and Verify.
Without it those calls return 403 with inner error ``UnsupportedFeature``,
which this module turns into :class:`AzureFaceNotApprovedError`.
:meth:`AzureFaceClient.probe_identification` asks that question without
sending an image.

## Errors

Callers see a small typed hierarchy with a stable ``code``, never Azure's
message text. Azure's messages are safe, but they are not a contract, and
passing them through would turn a provider string into something apps/web
has to parse.

## Retries

A 429 is retried for every call, because a throttled request was never
processed. A 5xx or a transport failure is retried only on calls that are
safe to repeat: detect, identify, verify, reads, PUT and DELETE. Creating a
person or adding a face is never retried after an ambiguous failure. Doing so
could store a biometric template twice.
"""

from __future__ import annotations

import logging
import re
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

import httpx

logger = logging.getLogger(__name__)

API_PREFIX = "/face/v1.0"

#: Detector. detection_03 is Azure's most accurate detector for small faces
#: and the one that reports ``qualityForRecognition``, head pose, blur,
#: exposure, occlusion and mask. It rejects ``noise`` with a 400
#: BadArgument, which was checked against the live resource. See
#: docs/AZURE_FACE.md.
DETECTION_MODEL = "detection_03"
#: Recogniser. Must match the model each LargePersonGroup was created with:
#: a faceId from one recognition model cannot be identified against a group
#: built with another.
RECOGNITION_MODEL = "recognition_04"

#: Identify accepts at most ten faceIds per request.
IDENTIFY_BATCH_SIZE = 10

#: The attributes this product reads. Every one is supported by detection_03.
QUALITY_ATTRIBUTES = "qualityForRecognition,headPose,blur,exposure,occlusion,mask"

#: LargePersonGroup ids: lowercase letters, digits, '-' and '_', at most 64.
_GALLERY_ID = re.compile(r"^[a-z0-9_-]{1,64}$")

IdentificationStatus = Literal["enabled", "not_approved", "unavailable"]


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class AzureFaceError(RuntimeError):
    """Base class. ``code`` is stable and product-level. ``azure_code`` is
    Azure's own error code, which may be logged because it contains no
    image, key or face data."""

    code = "azure_face_error"

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        azure_code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.azure_code = azure_code


class AzureFaceNotConfiguredError(AzureFaceError):
    """AZURE_FACE_ENDPOINT or AZURE_FACE_KEY is missing or malformed."""

    code = "azure_face_not_configured"


class AzureFaceAuthError(AzureFaceError):
    """401, or a 403 that is not the Limited Access gate. The key is wrong,
    rotated or revoked, or the network rules exclude this caller."""

    code = "azure_face_auth_failed"


class AzureFaceNotApprovedError(AzureFaceError):
    """403 UnsupportedFeature: Microsoft has not approved Identification or
    Verification for this resource. Apply at https://aka.ms/facerecognition."""

    code = "identification_not_approved"


class AzureFaceRateLimitedError(AzureFaceError):
    code = "azure_face_rate_limited"


class AzureFaceUnavailableError(AzureFaceError):
    """A 5xx, a timeout or a network failure. Worth retrying later."""

    code = "azure_face_unavailable"


class AzureFaceBadImageError(AzureFaceError):
    """Azure refused the image itself: unreadable, too large or too small."""

    code = "azure_face_bad_image"


class AzureFaceGalleryNotReadyError(AzureFaceError):
    """The gallery has never finished training, so Identify has no model yet."""

    code = "gallery_not_ready"


class AzureFaceNotFoundError(AzureFaceError):
    code = "azure_face_not_found"


class AzureFaceRequestError(AzureFaceError):
    """Any other 4xx. A bug in this client, not a condition to handle."""

    code = "azure_face_request_rejected"


_BAD_IMAGE_CODES = {
    "InvalidImage",
    "InvalidImageSize",
    "InvalidURL",
    "InvalidImageFormat",
}
_NOT_TRAINED_CODES = {
    "LargePersonGroupNotTrained",
    "PersonGroupNotTrained",
    "LargePersonGroupTrainingNotFinished",
    "PersonGroupTrainingNotFinished",
    "UnspecifiedTrainingNotFinished",
}


def validate_gallery_id(gallery_id: str) -> str:
    if not _GALLERY_ID.match(gallery_id):
        raise ValueError(
            "galleryId must be 1-64 characters of lowercase letters, digits, "
            "'-' or '_'."
        )
    return gallery_id


def _error_codes(response: httpx.Response) -> tuple[str | None, str | None]:
    try:
        body = response.json()
    except ValueError:
        return None, None
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return None, None
    inner = error.get("innererror")
    inner_code = inner.get("code") if isinstance(inner, dict) else None
    return error.get("code"), inner_code


def _raise_for(response: httpx.Response, operation: str) -> None:
    """Map a non-success response onto the typed hierarchy. Messages name the
    operation and the Azure code, and nothing else."""
    status = response.status_code
    code, inner = _error_codes(response)
    label = f"Azure Face {operation} failed: HTTP {status}" + (
        f" {code}" if code else ""
    )
    if status == 401:
        raise AzureFaceAuthError(label, status=status, azure_code=code)
    if status == 403:
        if inner == "UnsupportedFeature" or code == "UnsupportedFeature":
            raise AzureFaceNotApprovedError(
                "Azure Face Identification/Verification is not approved for this "
                "resource (403 UnsupportedFeature). Apply at "
                "https://aka.ms/facerecognition.",
                status=status,
                azure_code=inner or code,
            )
        raise AzureFaceAuthError(label, status=status, azure_code=code)
    if status == 429:
        raise AzureFaceRateLimitedError(label, status=status, azure_code=code)
    if status >= 500:
        raise AzureFaceUnavailableError(label, status=status, azure_code=code)
    if code in _NOT_TRAINED_CODES:
        raise AzureFaceGalleryNotReadyError(label, status=status, azure_code=code)
    if status == 404:
        raise AzureFaceNotFoundError(label, status=status, azure_code=code)
    if code in _BAD_IMAGE_CODES:
        raise AzureFaceBadImageError(label, status=status, azure_code=code)
    raise AzureFaceRequestError(label, status=status, azure_code=code)


# ---------------------------------------------------------------------------
# Client
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IdentifyCandidate:
    person_id: str
    confidence: float


class AzureFaceClient:
    """Thin, typed wrapper over the endpoints this product uses.

    ``transport`` and ``sleep`` exist for tests: every unit test in this
    repository runs against an ``httpx.MockTransport`` and never touches the
    real service.
    """

    def __init__(
        self,
        endpoint: str,
        key: str,
        *,
        timeout_s: float = 15.0,
        max_retries: int = 2,
        transport: httpx.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not endpoint or not key:
            raise AzureFaceNotConfiguredError(
                "AZURE_FACE_ENDPOINT and AZURE_FACE_KEY must both be set."
            )
        if not endpoint.startswith("https://"):
            raise AzureFaceNotConfiguredError(
                "AZURE_FACE_ENDPOINT must be an https:// URL."
            )
        self._max_retries = max(0, max_retries)
        self._sleep = sleep
        self._http = httpx.Client(
            base_url=endpoint.rstrip("/") + API_PREFIX,
            headers={"Ocp-Apim-Subscription-Key": key},
            timeout=httpx.Timeout(timeout_s, connect=min(5.0, timeout_s)),
            transport=transport,
        )

    def close(self) -> None:
        self._http.close()

    # -- transport ----------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        operation: str,
        *,
        idempotent: bool,
        params: dict[str, Any] | None = None,
        json: Any = None,
        content: bytes | None = None,
    ) -> httpx.Response:
        headers = (
            {"Content-Type": "application/octet-stream"}
            if content is not None
            else None
        )
        attempt = 0
        while True:
            try:
                response = self._http.request(
                    method,
                    path,
                    params=params,
                    json=json,
                    content=content,
                    headers=headers,
                )
            except httpx.TimeoutException as error:
                if idempotent and attempt < self._max_retries:
                    attempt += 1
                    self._sleep(0.5 * attempt)
                    continue
                raise AzureFaceUnavailableError(
                    f"Azure Face {operation} timed out."
                ) from error
            except httpx.TransportError as error:
                if idempotent and attempt < self._max_retries:
                    attempt += 1
                    self._sleep(0.5 * attempt)
                    continue
                raise AzureFaceUnavailableError(
                    f"Azure Face {operation} could not reach the service."
                ) from error

            if response.is_success:
                return response
            retryable = response.status_code == 429 or (
                idempotent and response.status_code >= 500
            )
            if retryable and attempt < self._max_retries:
                attempt += 1
                self._sleep(_retry_after(response, attempt))
                continue
            _raise_for(response, operation)

    # -- detection ----------------------------------------------------------

    def detect(self, image: bytes, *, return_face_id: bool) -> list[dict[str, Any]]:
        """Every face in ``image`` with the quality attributes and 27-point
        landmarks. ``return_face_id=True`` needs Identification approval."""
        response = self._request(
            "POST",
            "/detect",
            "detect",
            idempotent=True,
            params={
                "detectionModel": DETECTION_MODEL,
                "recognitionModel": RECOGNITION_MODEL,
                "returnFaceId": "true" if return_face_id else "false",
                "returnFaceLandmarks": "true",
                "returnFaceAttributes": QUALITY_ATTRIBUTES,
                "returnRecognitionModel": "false",
                # The shortest Azure accepts. A faceId is only used within
                # the request that created it, so Azure need not cache it
                # for the 24-hour default.
                "faceIdTimeToLive": 60,
            },
            content=image,
        )
        faces = response.json()
        if not isinstance(faces, list):
            raise AzureFaceRequestError(
                "Azure Face detect returned an unexpected body."
            )
        return faces

    # -- capability ---------------------------------------------------------

    def probe_identification(self) -> IdentificationStatus:
        """Is Identification approved for this resource?

        Listing LargePersonGroups is gated behind the same approval as
        Identify and needs no image. So this is how to ask without sending
        anybody's face anywhere. A bad key raises; an unreachable service
        reports ``unavailable``.
        """
        try:
            self._request(
                "GET",
                "/largepersongroups",
                "capability probe",
                idempotent=True,
                params={"top": 1},
            )
        except AzureFaceNotApprovedError:
            return "not_approved"
        except (AzureFaceUnavailableError, AzureFaceRateLimitedError):
            return "unavailable"
        return "enabled"

    # -- galleries (LargePersonGroups) ---------------------------------------

    def ensure_gallery(self, gallery_id: str) -> bool:
        """Create the gallery if it does not exist. True if it was created."""
        validate_gallery_id(gallery_id)
        try:
            self._request(
                "GET",
                f"/largepersongroups/{gallery_id}",
                "gallery read",
                idempotent=True,
            )
            return False
        except AzureFaceNotFoundError:
            pass
        self._request(
            "PUT",
            f"/largepersongroups/{gallery_id}",
            "gallery create",
            idempotent=True,
            # The name is the id: Azure requires one, and nothing about a
            # class belongs in a third-party store that does not need it.
            json={"name": gallery_id, "recognitionModel": RECOGNITION_MODEL},
        )
        return True

    def gallery_trained(self, gallery_id: str) -> bool:
        """Has this gallery ever completed training? Identify needs that."""
        try:
            response = self._request(
                "GET",
                f"/largepersongroups/{validate_gallery_id(gallery_id)}/training",
                "training status",
                idempotent=True,
            )
        except (AzureFaceNotFoundError, AzureFaceGalleryNotReadyError):
            return False
        body = response.json()
        # "running" after an earlier success still identifies against the
        # previous model, but the status alone cannot tell us there was one,
        # so only a completed training counts.
        return body.get("status") == "succeeded"

    def train(self, gallery_id: str) -> None:
        self._request(
            "POST",
            f"/largepersongroups/{validate_gallery_id(gallery_id)}/train",
            "train",
            idempotent=True,
        )

    def create_person(self, gallery_id: str, name: str) -> str:
        response = self._request(
            "POST",
            f"/largepersongroups/{validate_gallery_id(gallery_id)}/persons",
            "person create",
            idempotent=False,
            json={"name": name[:128]},
        )
        return str(response.json()["personId"])

    def add_face(
        self,
        gallery_id: str,
        person_id: str,
        image: bytes,
        target: tuple[int, int, int, int],
    ) -> str:
        """Add exactly the face at ``target`` (left, top, width, height).

        Pinning the rectangle means the stored face is the one that passed
        the quality gate, and never another face Azure finds in the image.
        """
        left, top, width, height = target
        response = self._request(
            "POST",
            f"/largepersongroups/{validate_gallery_id(gallery_id)}/persons/{person_id}/persistedfaces",
            "face add",
            idempotent=False,
            params={
                "detectionModel": DETECTION_MODEL,
                "targetFace": f"{left},{top},{width},{height}",
            },
            content=image,
        )
        return str(response.json()["persistedFaceId"])

    def delete_face(
        self, gallery_id: str, person_id: str, persisted_face_id: str
    ) -> None:
        try:
            self._request(
                "DELETE",
                f"/largepersongroups/{validate_gallery_id(gallery_id)}/persons/{person_id}"
                f"/persistedfaces/{persisted_face_id}",
                "face delete",
                idempotent=True,
            )
        except AzureFaceNotFoundError:
            return

    def delete_person(self, gallery_id: str, person_id: str) -> None:
        try:
            self._request(
                "DELETE",
                f"/largepersongroups/{validate_gallery_id(gallery_id)}/persons/{person_id}",
                "person delete",
                idempotent=True,
            )
        except AzureFaceNotFoundError:
            return

    # -- recognition --------------------------------------------------------

    def verify(self, face_id: str, gallery_id: str, person_id: str) -> float:
        """Confidence that ``face_id`` is ``person_id``. Needs no training."""
        response = self._request(
            "POST",
            "/verify",
            "verify",
            idempotent=True,
            json={
                "faceId": face_id,
                "personId": person_id,
                "largePersonGroupId": validate_gallery_id(gallery_id),
            },
        )
        return float(response.json().get("confidence", 0.0))

    def identify(
        self,
        face_ids: Sequence[str],
        gallery_id: str,
        *,
        max_candidates: int,
        confidence_threshold: float,
    ) -> dict[str, list[IdentifyCandidate]]:
        """Identify any number of faces against one gallery.

        Azure caps a request at ten faceIds, so a larger list is split into
        consecutive batches and the answers are merged into one mapping. For
        example, 34 faces become 10 + 10 + 10 + 4. Every faceId in the input
        is present in the result, with an empty list when nobody matched.
        """
        validate_gallery_id(gallery_id)
        result: dict[str, list[IdentifyCandidate]] = {fid: [] for fid in face_ids}
        for batch in batched(face_ids, IDENTIFY_BATCH_SIZE):
            response = self._request(
                "POST",
                "/identify",
                "identify",
                idempotent=True,
                json={
                    "faceIds": list(batch),
                    "largePersonGroupId": gallery_id,
                    "maxNumOfCandidatesReturned": max(1, min(100, max_candidates)),
                    "confidenceThreshold": max(0.0, min(1.0, confidence_threshold)),
                },
            )
            for entry in response.json():
                face_id = entry.get("faceId")
                if face_id not in result:
                    continue
                result[face_id] = [
                    IdentifyCandidate(
                        str(c["personId"]), float(c.get("confidence", 0.0))
                    )
                    for c in entry.get("candidates", [])
                ]
        return result


def batched(items: Iterable[str], size: int) -> list[list[str]]:
    """Consecutive chunks of at most ``size``, in input order."""
    chunk: list[str] = []
    out: list[list[str]] = []
    for item in items:
        chunk.append(item)
        if len(chunk) == size:
            out.append(chunk)
            chunk = []
    if chunk:
        out.append(chunk)
    return out


def _retry_after(response: httpx.Response, attempt: int) -> float:
    """Honour Retry-After, but never sleep long enough to stall a request a
    teacher is waiting on."""
    header = response.headers.get("Retry-After")
    try:
        seconds = float(header) if header is not None else 0.5 * attempt
    except ValueError:
        seconds = 0.5 * attempt
    return max(0.0, min(seconds, 3.0))
