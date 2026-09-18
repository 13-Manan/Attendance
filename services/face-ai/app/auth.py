"""Service-to-service authentication for the inference endpoints.

## Why this exists

Every endpoint in this service used to be open. ADR-0002 describes it as
private — "never internet-facing" — and the FastAPI description still says so,
but that sentence describes a network the code cannot see. A process does not
know whether the port it bound is behind a firewall, on a shared Docker
network, on a laptop joined to a café Wi-Fi, or published by a
`docker-compose` line somebody added in a hurry. If reachability is the only
control, then the first deployment mistake is also a biometric breach.

What is at stake is specific: ``POST /v1/enroll`` takes a photograph and
returns the 512-float template that identifies that person — the same value
apps/web stores against a student and matches against in class. Anybody who
can reach the port can mint a template from a stranger's photo, or run a
photo against ``/v1/match`` to ask "is this person in this list". Neither
requires a database, a session, or any part of apps/web.

So the credential check lives here, in the service that holds the model.

## What it is, and what it deliberately is not

A single shared secret, presented as ``Authorization: Bearer <token>``,
compared in constant time. It answers exactly one question: *is the caller
apps/web?* It carries no identity, no institution and no scopes, because
there is nothing here to scope — this service holds no data, performs no
lookups, and can only act on what the caller hands it (ADR-0002). Per-tenant
credentials would be ceremony around a service that cannot tell tenants
apart.

It is not a substitute for network isolation; it is the control that still
works when the isolation turns out to be imaginary.

## Why unset is permitted

`uvicorn app.main:app --reload --port 8000` is the first command in the
README and it has to keep working. With no token configured the service logs
a warning on every boot and accepts anonymous calls, exactly as it did
before. `FACE_AI_REQUIRE_AUTH=true` turns that into a refusal to start, and
any environment holding real faces is expected to set it — the same shape as
`FACE_AI_REQUIRE_PRODUCTION_MODEL`, which already refuses to start on
unlicensed weights.
"""

import hmac
import logging

from fastapi import Depends, HTTPException, Request, status

from app.config import Settings, get_settings

logger = logging.getLogger(__name__)

_BEARER_PREFIX = "bearer "


class MissingServiceTokenError(RuntimeError):
    """Raised at startup when a deployment demands authentication but no
    shared secret was configured."""


def read_bearer_token(request: Request) -> str | None:
    """Extracts the credential from an ``Authorization`` header.

    The scheme is matched case-insensitively per RFC 7235 §2.1. Anything that
    is not a bearer token — ``Basic``, a bare token with no scheme, an empty
    value — reads as absent rather than as a malformed-credential error, so a
    caller that sends the wrong thing gets the same 401 as one that sends
    nothing and learns nothing extra from the difference.
    """
    header = request.headers.get("authorization")
    if not header:
        return None
    stripped = header.strip()
    if not stripped.lower().startswith(_BEARER_PREFIX):
        return None
    token = stripped[len(_BEARER_PREFIX) :].strip()
    return token or None


def verify_service_token(presented: str | None, expected: str | None) -> bool:
    """Constant-time comparison of a presented credential against the secret.

    ``expected`` of None means no token is configured, which this function
    reports as authorized — the "development, warned about at boot" mode.
    Concentrating that decision in one pure function is what lets a test
    assert it rather than infer it from the absence of a 401.

    ``hmac.compare_digest`` rather than ``==`` because a short-circuiting
    comparison leaks the length of the common prefix through timing, and the
    secret it is protecting is reusable forever.
    """
    if expected is None:
        return True
    if presented is None:
        return False
    return hmac.compare_digest(presented.encode("utf-8"), expected.encode("utf-8"))


def require_service_auth(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> None:
    """FastAPI dependency guarding every inference endpoint.

    Applied at the router level in ``app.main`` rather than per handler: a new
    endpoint added to a guarded router is protected by default, whereas a
    per-handler decorator is protection somebody has to remember.

    ``/v1/health`` is deliberately *not* guarded — it is a liveness probe for
    orchestrators and reveals only the model name and embedding dimension,
    which is the same information ``docker-compose`` and the README already
    curl. ``/v1/model-info`` is guarded, because its licensing posture is
    deployment detail.
    """
    if verify_service_token(read_bearer_token(request), settings.face_ai_auth_token):
        return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=(
            "A valid service token is required. "
            "Send `Authorization: Bearer <token>`."
        ),
        headers={"WWW-Authenticate": 'Bearer realm="face-ai", error="invalid_token"'},
    )


def check_startup_auth(settings: Settings) -> None:
    """Called from the lifespan handler. Fails the boot, or warns loudly."""
    if settings.face_ai_auth_token:
        return
    if settings.face_ai_require_auth:
        raise MissingServiceTokenError(
            "FACE_AI_REQUIRE_AUTH is set but FACE_AI_AUTH_TOKEN is empty. "
            "This service turns photographs into biometric templates and "
            "refuses to serve them to unauthenticated callers. Generate a "
            "secret (`openssl rand -base64 32`), set FACE_AI_AUTH_TOKEN here "
            "and FACE_AI_SERVICE_TOKEN in apps/web, and restart."
        )
    logger.warning(
        "face-ai is accepting UNAUTHENTICATED requests: FACE_AI_AUTH_TOKEN is "
        "not set. Every caller that can reach this port can turn a photograph "
        "into a biometric template via /v1/enroll. Acceptable for local "
        "development only — set FACE_AI_AUTH_TOKEN, and FACE_AI_REQUIRE_AUTH "
        "to make this a startup failure, in any environment holding real faces."
    )
