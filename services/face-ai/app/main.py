import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse

from app.auth import check_startup_auth, require_service_auth
from app.config import get_model, get_settings
from app.models.opencv_provider import ImageDecodeError
from app.routers import enrollment, health, process

logger = logging.getLogger(__name__)


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
