"""Single-image enrollment/verification primitives.

Split from routers/process.py deliberately: `/v1/detect-embed` is the
classroom-attendance orchestration entry point (multiple images, one
response), whereas `/v1/quality`, `/v1/detect`, `/v1/embed`, `/v1/enroll`,
and `/v1/match` are single-image primitives. Both files ultimately call the
same ``FaceModelProvider`` interface, so a backend swap continues to touch
exactly one module.

Every handler here is a thin translation between the wire schema and the
provider interface. Decisions that could change an attendance outcome —
whether a capture is good enough, whether a score counts as a match — live in
the provider and in app/matching.py respectively, never inline in a route.
"""

from fastapi import APIRouter, Depends

from app.config import get_model
from app.matching import resolve_thresholds, score_candidates
from app.models.base import FaceModelProvider
from app.schemas import (
    DetectRequest,
    DetectResponse,
    EmbedRequest,
    EmbedResponse,
    EnrollAccepted,
    EnrollRejected,
    EnrollRequest,
    EnrollResponse,
    FaceModelInfo,
    MatchRequest,
    MatchResponse,
    QualityRequest,
    QualityResponse,
)

router = APIRouter()


@router.get("/v1/model-info", response_model=FaceModelInfo)
def model_info(model: FaceModelProvider = Depends(get_model)) -> FaceModelInfo:
    """Provenance of the running model.

    Exists so that "which model produced this result?" is answerable by
    asking the service, and so a deployment's licensing posture
    (``commercialUse`` / ``productionEligible``) can be asserted by a health
    check rather than trusted from a document.
    """
    return model.model_info()


@router.post("/v1/quality", response_model=QualityResponse)
def quality(
    request: QualityRequest,
    model: FaceModelProvider = Depends(get_model),
) -> QualityResponse:
    return QualityResponse(
        assessment=model.assess_quality(request.image_base64),
        modelName=model.name,
        modelVersion=model.version,
    )


@router.post("/v1/detect", response_model=DetectResponse)
def detect(
    request: DetectRequest,
    model: FaceModelProvider = Depends(get_model),
) -> DetectResponse:
    """Locate faces. Returns boxes, per-face detector confidence and — when
    the backend's detector provides them — the five landmarks that alignment
    needs, all in pixel coordinates of the submitted image."""
    result = model.detect(request.image_base64)
    return DetectResponse(
        faces=result.faces,
        faceCount=len(result.faces),
        imageWidth=result.image_width,
        imageHeight=result.image_height,
        modelName=model.name,
        modelVersion=model.version,
    )


@router.post("/v1/embed", response_model=EmbedResponse)
def embed(
    request: EmbedRequest,
    model: FaceModelProvider = Depends(get_model),
) -> EmbedResponse:
    aligned = model.align(request.image_base64, request.bounding_box, request.landmarks)
    vector = model.embed(request.image_base64, request.bounding_box, request.landmarks)
    return EmbedResponse(
        embedding=vector,
        modelName=model.name,
        modelVersion=model.version,
        embeddingDim=model.embedding_dim,
        weightsVersion=model.weights_version,
        preprocessingVersion=model.preprocessing_version,
        alignmentVersion=model.alignment_version,
        aligned=aligned.aligned,
    )


@router.post("/v1/enroll", response_model=EnrollResponse)
def enroll(
    request: EnrollRequest,
    model: FaceModelProvider = Depends(get_model),
) -> EnrollResponse:
    """Composite quality + detect + align + embed.

    The "reject and ask for recapture" quality gate lives here: if the
    assessment is anything but ``ok``, no embedding is generated and the
    rejected response has no field to put one in. That is what makes "do not
    silently enrol bad data" structural rather than a rule callers must
    remember — a caller cannot forward an embedding it was never given.

    ## Why the detector runs even though quality already passed

    Alignment needs five landmarks, and landmarks come from the detector. This
    route used to call ``align(image, None, None)`` and ``embed(image, None,
    None)``, which meant every enrolled template was built from a plain box
    crop and reported ``aligned: false`` — for any ArcFace-family recogniser,
    a materially worse embedding than the same face warped onto the template
    it was trained on. The cost of getting that wrong is invisible: nothing
    fails, the student is simply matched less reliably for as long as the
    template exists.

    So the stages run in the order ``base.py`` describes them: detect, then
    align with what the detector found, then embed the aligned crop — inside
    ``enroll_image``, so a backend can do all of it from a single decode. A backend
    whose detector yields no landmarks still works — ``aligned`` comes back
    false and says so honestly, rather than the route guaranteeing it could
    never be true.
    """
    outcome = model.enroll_image(request.image_base64)
    if outcome.assessment.reason != "ok" or outcome.embedding is None:
        return EnrollRejected(
            assessment=outcome.assessment,
            modelName=model.name,
            modelVersion=model.version,
        )
    return EnrollAccepted(
        assessment=outcome.assessment,
        embedding=outcome.embedding,
        modelName=model.name,
        modelVersion=model.version,
        embeddingDim=model.embedding_dim,
        weightsVersion=model.weights_version,
        preprocessingVersion=model.preprocessing_version,
        alignmentVersion=model.alignment_version,
        aligned=outcome.aligned,
    )


@router.post("/v1/match", response_model=MatchResponse)
def match(
    request: MatchRequest,
    model: FaceModelProvider = Depends(get_model),
) -> MatchResponse:
    """Score a probe image against a caller-supplied candidate list.

    Candidates arrive in the request body and are never read from a database
    here — the service holds no credentials and does no lookups (ADR-0002).
    That is also what enforces class-scoped search: apps/web decides which
    cohort's students are in scope, and this service physically cannot reach
    anyone it was not handed.

    The response carries a normalised status next to every raw score, so no
    caller has to re-derive what a float means, and a below-threshold score
    can never be mistaken for a confident identification.
    """
    thresholds = resolve_thresholds(request.thresholds)
    probe = model.embed(request.image_base64, None, None)
    scores, skipped = score_candidates(
        probe,
        request.candidates,
        thresholds,
        model.embedding_dim,
        calibration=model.calibration(),
    )
    best = scores[0] if scores else None
    return MatchResponse(
        bestMatch=best,
        status=best.status if best else "UNMATCHED",
        scores=scores,
        thresholdsUsed=thresholds,
        modelName=model.name,
        modelVersion=model.version,
        skippedIncompatibleCandidates=skipped,
    )
