"""Service-token authentication and request-size bounds.

Two things are being pinned here, and they pull in opposite directions:

1. With a token configured, every endpoint that touches the model refuses an
   unauthenticated caller. This is the control that still works when a
   deployment turns out to be wrong about its own network.
2. With no token configured, the service behaves exactly as it did before —
   `uvicorn app.main:app` with an empty environment is the first command in
   the README and must keep working.

A test for the second is as important as a test for the first: an auth change
that quietly broke local development would be reverted, and the control would
go with it.
"""

import base64
import logging

import pytest
from fastapi.testclient import TestClient

from app.auth import (
    MissingServiceTokenError,
    check_startup_auth,
    read_bearer_token,
    verify_service_token,
)
from app.config import Settings, get_settings, reset_model_cache
from app.main import app

TOKEN = "s3cret-service-token"


def _image(prefix: str = "face", size: int = 200) -> str:
    """A payload the mock backend accepts. Content is irrelevant to auth."""
    return base64.b64encode((prefix * size).encode()).decode()


@pytest.fixture
def secured_client(monkeypatch):
    monkeypatch.setenv("FACE_AI_AUTH_TOKEN", TOKEN)
    reset_model_cache()
    with TestClient(app) as client:
        yield client
    reset_model_cache()


@pytest.fixture
def open_client(monkeypatch):
    monkeypatch.delenv("FACE_AI_AUTH_TOKEN", raising=False)
    reset_model_cache()
    with TestClient(app) as client:
        yield client
    reset_model_cache()


# Every endpoint that can turn a photograph into, or compare it against, a
# biometric template. Listed explicitly rather than discovered from the app, so
# that adding a route without adding it here is visible in review.
GUARDED = [
    ("post", "/v1/enroll", {"imageBase64": _image()}),
    ("post", "/v1/embed", {"imageBase64": _image()}),
    ("post", "/v1/quality", {"imageBase64": _image()}),
    ("post", "/v1/detect", {"imageBase64": _image()}),
    (
        "post",
        "/v1/detect-embed",
        {
            "sessionId": "s1",
            "images": [{"sequenceNumber": 1, "imageBase64": _image()}],
        },
    ),
    (
        "post",
        "/v1/match",
        {
            "imageBase64": _image(),
            "candidates": [{"studentId": "stu-1", "embedding": [0.1] * 512}],
        },
    ),
    # Guarded too: the response names the backend, its version and its
    # licensing posture, which is deployment detail rather than a liveness
    # signal. `/v1/health` is the probe; this is not.
    ("get", "/v1/model-info", None),
]


def _call(client, method, path, body, headers=None):
    """`TestClient.get` takes no `json`, so the verb decides the call shape."""
    if method == "get":
        return client.get(path, headers=headers)
    return getattr(client, method)(path, json=body, headers=headers)


# ---------------------------------------------------------------------------
# With a token configured
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method,path,body", GUARDED)
def test_every_inference_endpoint_refuses_an_anonymous_caller(
    secured_client, method, path, body
):
    response = _call(secured_client, method, path, body)
    assert response.status_code == 401, path
    # The challenge names the scheme, so a misconfigured caller can fix itself.
    assert "Bearer" in response.headers.get("www-authenticate", "")


@pytest.mark.parametrize("method,path,body", GUARDED)
def test_the_right_token_gets_through(secured_client, method, path, body):
    response = _call(
        secured_client, method, path, body, {"Authorization": f"Bearer {TOKEN}"}
    )
    assert response.status_code == 200, f"{path}: {response.text}"


@pytest.mark.parametrize(
    "header",
    [
        "Bearer wrong-token",
        f"Bearer {TOKEN}x",
        f"Bearer {TOKEN[:-1]}",
        f"Basic {TOKEN}",
        TOKEN,
        "Bearer",
        "Bearer ",
        "",
    ],
)
def test_a_wrong_or_malformed_credential_is_refused(secured_client, header):
    # A near-miss token and a missing header get the same 401 with the same
    # body: the response must not tell a caller how close they were.
    response = secured_client.post(
        "/v1/enroll", json={"imageBase64": _image()}, headers={"Authorization": header}
    )
    assert response.status_code == 401


def test_the_scheme_is_matched_case_insensitively(secured_client):
    # RFC 7235 §2.1. A caller sending `bearer` is not an attacker.
    response = secured_client.post(
        "/v1/enroll",
        json={"imageBase64": _image()},
        headers={"Authorization": f"bearer {TOKEN}"},
    )
    assert response.status_code == 200


def test_health_stays_open_so_orchestrators_can_probe_it(secured_client):
    response = secured_client.get("/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_authentication_is_checked_before_the_body_is_processed(secured_client):
    # An anonymous caller with a malformed body gets 401, not 422. Otherwise
    # the validation errors themselves become an unauthenticated API.
    response = secured_client.post("/v1/enroll", json={"nonsense": True})
    assert response.status_code == 401


# ---------------------------------------------------------------------------
# With no token configured — the development path must not have changed
# ---------------------------------------------------------------------------


def test_with_no_token_configured_the_service_behaves_exactly_as_before(open_client):
    response = open_client.post("/v1/enroll", json={"imageBase64": _image()})
    assert response.status_code == 200


def test_an_unnecessary_token_is_ignored_rather_than_rejected(open_client):
    response = open_client.post(
        "/v1/enroll",
        json={"imageBase64": _image()},
        headers={"Authorization": "Bearer anything-at-all"},
    )
    assert response.status_code == 200


# ---------------------------------------------------------------------------
# The pure helpers
# ---------------------------------------------------------------------------


def test_verify_service_token_is_total():
    assert verify_service_token(None, None) is True
    assert verify_service_token("anything", None) is True
    assert verify_service_token(None, TOKEN) is False
    assert verify_service_token("", TOKEN) is False
    assert verify_service_token(TOKEN, TOKEN) is True
    assert verify_service_token(TOKEN + " ", TOKEN) is False


def test_read_bearer_token_treats_a_non_bearer_scheme_as_absent():
    class _Request:
        def __init__(self, value):
            self.headers = {"authorization": value} if value is not None else {}

    assert read_bearer_token(_Request(None)) is None
    assert read_bearer_token(_Request("")) is None
    assert read_bearer_token(_Request("Basic abc")) is None
    assert read_bearer_token(_Request("Bearer   ")) is None
    assert read_bearer_token(_Request("Bearer abc")) == "abc"
    assert read_bearer_token(_Request("  Bearer   abc  ")) == "abc"


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------


def test_startup_refuses_to_boot_when_auth_is_required_but_unconfigured():
    settings = Settings(face_ai_auth_token=None, face_ai_require_auth=True)
    with pytest.raises(MissingServiceTokenError) as excinfo:
        check_startup_auth(settings)
    # The error has to say what to do, not just that something is wrong.
    assert "FACE_AI_AUTH_TOKEN" in str(excinfo.value)


def test_startup_warns_loudly_when_running_unauthenticated(caplog):
    settings = Settings(face_ai_auth_token=None, face_ai_require_auth=False)
    with caplog.at_level(logging.WARNING):
        check_startup_auth(settings)
    assert "UNAUTHENTICATED" in caplog.text


def test_startup_is_silent_once_a_token_is_configured(caplog):
    settings = Settings(face_ai_auth_token=TOKEN, face_ai_require_auth=True)
    with caplog.at_level(logging.WARNING):
        check_startup_auth(settings)
    assert caplog.text == ""


def test_a_configured_token_is_never_logged(caplog):
    settings = Settings(face_ai_auth_token=None, face_ai_require_auth=False)
    with caplog.at_level(logging.WARNING):
        check_startup_auth(settings)
    assert TOKEN not in caplog.text


# ---------------------------------------------------------------------------
# Request bounds — the other half of "do not trust the caller"
# ---------------------------------------------------------------------------


def test_an_oversized_image_is_refused_by_this_service_not_only_by_its_caller(
    open_client,
):
    settings = get_settings()
    oversized = "A" * (settings.face_ai_max_image_base64_chars + 1)
    response = open_client.post("/v1/enroll", json={"imageBase64": oversized})
    assert response.status_code == 422


def test_too_many_images_in_one_request_is_refused(open_client):
    settings = get_settings()
    images = [
        {"sequenceNumber": n + 1, "imageBase64": _image()}
        for n in range(settings.face_ai_max_images_per_request + 1)
    ]
    response = open_client.post(
        "/v1/detect-embed", json={"sessionId": "s1", "images": images}
    )
    assert response.status_code == 422


def test_an_unbounded_candidate_list_is_refused(open_client):
    settings = get_settings()
    candidates = [
        {"studentId": f"stu-{n}", "embedding": [0.1] * 512}
        for n in range(settings.face_ai_max_match_candidates + 1)
    ]
    response = open_client.post(
        "/v1/match", json={"imageBase64": _image(), "candidates": candidates}
    )
    assert response.status_code == 422


def test_a_request_at_the_limit_is_still_accepted(open_client):
    settings = get_settings()
    images = [
        {"sequenceNumber": n + 1, "imageBase64": _image()}
        for n in range(settings.face_ai_max_images_per_request)
    ]
    response = open_client.post(
        "/v1/detect-embed", json={"sessionId": "s1", "images": images}
    )
    assert response.status_code == 200
