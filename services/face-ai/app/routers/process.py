from fastapi import APIRouter, Depends

from app.config import get_model
from app.models.base import EmbeddingModel
from app.schemas import DetectEmbedRequest, DetectEmbedResponse

router = APIRouter()


@router.post("/v1/detect-embed", response_model=DetectEmbedResponse)
def detect_embed(
    request: DetectEmbedRequest,
    model: EmbeddingModel = Depends(get_model),
) -> DetectEmbedResponse:
    faces = [face for image in request.images for face in model.detect_and_embed(image)]
    return DetectEmbedResponse(
        faces=faces,
        model_name=model.name,
        model_version=model.version,
    )
