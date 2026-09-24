import time

from fastapi import APIRouter, Depends

from app.config import get_model
from app.models.base import EmbeddingModel
from app.models.pipeline import PipelineTimings
from app.schemas import (
    DetectedFace,
    DetectEmbedImageSummary,
    DetectEmbedRequest,
    DetectEmbedResponse,
    PipelineTimingsWire,
    RejectedFace,
)

router = APIRouter()


@router.post("/v1/detect-embed", response_model=DetectEmbedResponse)
def detect_embed(
    request: DetectEmbedRequest,
    model: EmbeddingModel = Depends(get_model),
) -> DetectEmbedResponse:
    """Every face in every image, embedded independently.

    Faces the backend found but could not embed come back in
    ``rejectedFaces`` rather than disappearing: a face too small to identify
    is something a teacher can fix with a closer photo, but only if they are
    told. Per-stage timings are returned so latency is measurable from the
    caller's side.
    """
    started = time.perf_counter()
    faces: list[DetectedFace] = []
    rejected: list[RejectedFace] = []
    summaries: list[DetectEmbedImageSummary] = []
    totals = PipelineTimings()
    for image in request.images:
        analysis = model.analyze_image(image)
        faces.extend(analysis.faces)
        rejected.extend(analysis.rejected)
        summaries.append(analysis.summary)
        totals.add(analysis.timings)
    return DetectEmbedResponse(
        faces=faces,
        model_name=model.name,
        model_version=model.version,
        rejectedFaces=rejected,
        images=summaries,
        timings=PipelineTimingsWire(
            decodeMs=round(totals.decode_ms, 2),
            detectMs=round(totals.detect_ms, 2),
            alignMs=round(totals.align_ms, 2),
            qualityMs=round(totals.quality_ms, 2),
            embedMs=round(totals.embed_ms, 2),
            totalMs=round((time.perf_counter() - started) * 1000.0, 2),
        ),
    )
