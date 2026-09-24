"""Gallery routes: enrolment into, removal from and identification against a
provider-held gallery (``template_kind == "gallery"``, i.e. Azure Face).

An embedding backend answers 409 on every route here, as a gallery backend
does on the embedding routes. The caller asks ``/v1/model-info`` which kind
it is talking to and uses the matching routes.

Like every other route, these hold nothing between requests. The gallery
lives with the provider. Which person id belongs to which student lives in
apps/web.
"""

from fastapi import APIRouter, Depends

from app.config import get_model
from app.models.base import (
    FaceModelProvider,
    GalleryIdentificationProvider,
    ProviderCapabilityError,
)
from app.schemas import (
    GalleryEnrollRequest,
    GalleryEnrollResponse,
    GalleryRemoveRequest,
    GalleryRemoveResponse,
    IdentifyRequest,
    IdentifyResponse,
)

router = APIRouter()


def _gallery(model: FaceModelProvider) -> GalleryIdentificationProvider:
    if not isinstance(model, GalleryIdentificationProvider):
        raise ProviderCapabilityError(
            f"Backend '{model.name}' stores embeddings, not a gallery. Use "
            "/v1/enroll and /v1/detect-embed."
        )
    return model


@router.post("/v1/gallery/enroll", response_model=GalleryEnrollResponse)
def gallery_enroll(
    request: GalleryEnrollRequest,
    model: FaceModelProvider = Depends(get_model),
) -> GalleryEnrollResponse:
    return _gallery(model).gallery_enroll(
        request.image_base64,
        request.targets,
        request.other_person_min_confidence,
        request.own_person_min_confidence,
    )


@router.post("/v1/gallery/remove", response_model=GalleryRemoveResponse)
def gallery_remove(
    request: GalleryRemoveRequest,
    model: FaceModelProvider = Depends(get_model),
) -> GalleryRemoveResponse:
    return GalleryRemoveResponse(
        removed=_gallery(model).gallery_remove(request.removals)
    )


@router.post("/v1/identify", response_model=IdentifyResponse)
def identify(
    request: IdentifyRequest,
    model: FaceModelProvider = Depends(get_model),
) -> IdentifyResponse:
    """Every face in every image, identified against one class's gallery.

    Without identification approval this still answers: faces are detected
    and quality-checked, ``identification`` says ``not_approved`` and every
    candidate list is empty.
    """
    return _gallery(model).identify(
        request.gallery_id,
        request.images,
        request.max_candidates,
        request.confidence_threshold,
    )
