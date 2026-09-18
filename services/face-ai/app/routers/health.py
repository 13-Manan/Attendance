from fastapi import APIRouter, Depends

from app.config import get_model
from app.models.base import EmbeddingModel
from app.schemas import HealthResponse

router = APIRouter()


@router.get("/v1/health", response_model=HealthResponse)
def health(model: EmbeddingModel = Depends(get_model)) -> HealthResponse:
    return HealthResponse(
        model_name=model.name,
        model_version=model.version,
        embedding_dim=model.embedding_dim,
    )
