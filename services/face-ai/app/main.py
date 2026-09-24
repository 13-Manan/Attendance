import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from app.auth import check_startup_auth, require_service_auth
from app.azure_face import (
    AzureFaceAuthError,
    AzureFaceBadImageError,
    AzureFaceError,
    AzureFaceGalleryNotReadyError,
    AzureFaceNotApprovedError,
    AzureFaceNotFoundError,
)
from app.config import get_model, get_settings
from app.models.base import ProviderCapabilityError
from app.models.opencv_provider import ImageDecodeError
from app.routers import enrollment, gallery, health, process

logger = logging.getLogger(__name__)


def configure_logging(level: str) -> None:
    """Give this service's own log records somewhere to go.

    Without this they go nowhere. Python's root logger has no handler by
    default, and the handler of last resort only emits WARNING and above — so
    every ``logger.info`` in this service, including the line that records
    which model was loaded, was written and discarded. A deployment's most
    basic question ("which recogniser is this container actually running?")
    had no answer in the logs, and the runbook told operators to look for a
    line that could not appear.

    gunicorn and uvicorn configure their *own* loggers rather than the root,
    which is why running under either did not fix this.

    A handler is added only when the root has none. Seizing logging from
    something that already configured it — a platform agent, a test harness,
    an operator debugging a container — would be the kind of helpfulness that
    loses records. The level is set either way, because a root that has a
    handler but sits at WARNING drops the same lines for a different reason.

    Nothing logged by this service contains a key, an image or a vector; the
    tests assert that separately.
    """
    root = logging.getLogger()
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(
            logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
        )
        root.addHandler(handler)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Load the model once, at startup.

    Loading lazily on the first request would mean an unreadable weights file,
    an unavailable execution provider or a backend barred by the licensing
    guard all surfacing as a 500 on somebody's enrolment attempt, several
    minutes after a deploy looked successful. Doing it here makes those
    failures fail the container, which is what an orchestrator can act on.

    It also moves the one-off cost of building an inference session out of
    the request path entirely.
    """
    settings = get_settings()
    configure_logging(settings.face_ai_log_level)
    # Before the model, on purpose: a deployment that demands authentication
    # and has no secret should never reach the point of loading weights and
    # binding a port. It must fail while an orchestrator still calls it a
    # failed start rather than a running service.
    check_startup_auth(settings)
    provider = get_model()
    info = provider.model_info()
    logger.info(
        "face-ai model loaded: backend=%s version=%s runtime=%s "
        "commercial_use=%s production_eligible=%s",
        settings.face_model_backend,
        info.model_version,
        info.runtime,
        info.commercial_use,
        info.production_eligible,
    )
    if not info.production_eligible:
        # Loud on every boot, on purpose. A stub or a research-only model
        # running unnoticed in an environment that people believe is doing
        # real recognition is the failure mode worth shouting about.
        logger.warning(
            "face-ai backend '%s' is NOT cleared for production use (%s). "
            "Real face recognition must not be relied upon in this "
            "deployment. See services/face-ai/app/models/LICENSING.md.",
            settings.face_model_backend,
            info.commercial_use,
        )
    try:
        yield
    finally:
        provider.unload()


app = FastAPI(
    title="Attendance Face AI Service",
    description=(
        "Isolated, stateless face detection/alignment/embedding service. "
        "Never touches Postgres or runs similarity search — see ADR-0002."
    ),
    version="0.1.0",
    lifespan=lifespan,
)

# `/v1/health` stays open: it is a liveness probe, it is what docker-compose
# and the README curl, and it discloses only the model name and embedding
# dimension. Everything that touches an image — or names the licensing posture
# of the weights — is behind the shared service token.
#
# The dependency is attached to the router rather than to each handler so that
# an endpoint added to these routers later is guarded by default. Protection
# nobody has to remember to add is the only kind that survives a busy week.
app.include_router(health.router)
app.include_router(process.router, dependencies=[Depends(require_service_auth)])
app.include_router(enrollment.router, dependencies=[Depends(require_service_auth)])
app.include_router(gallery.router, dependencies=[Depends(require_service_auth)])


@app.exception_handler(ImageDecodeError)
async def handle_image_decode_error(_request: Request, error: ImageDecodeError):
    """An undecodable image is the caller's problem, not an outage.

    Without this it is a 500, and a 500 is a specific claim: *this service is
    broken, retrying may help*. apps/web believes it — `analyzeCaptureImage`
    maps a non-2xx to "the face service is temporarily unavailable, try again",
    so a teacher whose capture is malformed is told to retry something that
    will fail identically every time, and an on-call engineer is paged for a
    service that is working correctly.

    This only became reachable with the real backend: the mock never decoded
    an image, so nothing could fail to decode. The body carries no image data
    and no embedding — only the reason.
    """
    return JSONResponse(status_code=400, content={"detail": str(error)})


@app.exception_handler(ProviderCapabilityError)
async def handle_capability_error(_request: Request, error: ProviderCapabilityError):
    """The request was sent to the wrong kind of backend. Not an outage."""
    return JSONResponse(
        status_code=409,
        content={"detail": "unsupported_by_backend", "message": str(error)},
    )


@app.exception_handler(AzureFaceError)
async def handle_azure_face_error(_request: Request, error: AzureFaceError):
    """Azure Face failures, as a stable code the caller can branch on.

    The body is the code only. It never carries the Azure response body, the
    endpoint or the key. The log line has the code and Azure's own error code
    and nothing else.
    """
    if isinstance(error, AzureFaceNotApprovedError | AzureFaceGalleryNotReadyError):
        status = 409
    elif isinstance(error, AzureFaceBadImageError):
        status = 400
    elif isinstance(error, AzureFaceNotFoundError):
        status = 404
    elif isinstance(error, AzureFaceAuthError):
        # Our credential, not the caller's. A gateway failure, not a 401.
        status = 502
    else:
        status = 503
    logger.warning(
        "azure-face request failed: code=%s azure_code=%s status=%s",
        error.code,
        error.azure_code,
        error.status,
    )
    return JSONResponse(status_code=status, content={"detail": error.code})
