"""Face quality, measured the same way whichever model is loaded.

Quality used to live inside each provider, which meant the only backend that
measured anything (opencv) measured three things — face size, whole-box blur
and whole-box brightness — and stopped at the first failure. That is not
enough to tell a teacher *what to change*, and it is not enough to decide how
far to trust a match from a classroom photo.

This module takes what every real pipeline already has — the decoded frame,
the detector's box, score and five landmarks, and the aligned crop the
embedder is about to see — and turns it into:

  * **measurements** (``FaceMeasurements``): numbers, each with a unit, none
    invented. A metric the inputs cannot support is ``None`` and is reported
    ``unavailable`` on the wire.
  * **reasons** (``evaluate``): every failed check, most actionable first, in
    the shared ``FaceQualityReason`` vocabulary.
  * **a score** in [0, 1]: the weakest check's margin, so one bad property is
    not averaged away by four good ones.

## Two profiles, because the two uses want opposite things

*Enrollment* is strict. A template is permanent and compared against every
classroom photo for the rest of the term; a mediocre one costs a little
accuracy every single day. Refusing and asking for a retake costs ten seconds.

*Group photos* are lenient. The face is whatever the camera caught; refusing
it removes information. So the group profile only *flags* a face, and the
recognition engine in apps/web uses the flags to send a match to a human
instead of suggesting it. Only a face too small to embed at all is dropped,
and the caller is told it was dropped (``rejectedFaces``).

## Where each number comes from

Every threshold below except pose was checked against SFace on the local
evaluation corpus (``bench/calibrate_quality.py``; the images are not in the
repository). Pose limits are engineering estimates: a portrait corpus has no
turned heads to measure against, and the profiles say so where they set them.
The calibration measures how far a *genuine* pair's similarity falls as each
property degrades, and places the threshold where the genuine similarity
starts to fall into the review band. The results are in
docs/FACE_RECOGNITION_CALIBRATION.md. They are properties of this embedder:
a different model must be re-calibrated, which is one more reason the
profile is data rather than code.

## What is NOT measured

Occlusion. Nothing in a five-point detector's output distinguishes a mask
from a mouth, and a number here would be invented. It stays ``unavailable``.
The detector's own confidence is the closest honest proxy — occluded faces
score lower — and it is checked, under its own name.

Pose is *estimated* from five landmarks with a simple geometric model (nose
tip ahead of the eye plane). It is good enough to tell "facing the camera"
from "turned away", and it is reported in degrees with the unit
``degrees_estimate`` so nobody mistakes it for a head-pose network.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from app.schemas import (
    BoundingBox,
    FaceLandmarks,
    FaceQualityMetric,
    FaceQualityMetrics,
    FaceQualityReason,
)

#: Side of the square the sharpness and exposure of a face are measured at.
#: Fixed so a Laplacian variance means the same thing for a 40px face and a
#: 400px one — which it does not when measured on the raw box.
MEASURE_SIZE = 112

#: Pixels at or below this luminance count as crushed shadow, at or above
#: ``_CLIPPED_HIGH`` as blown highlight.
_CLIPPED_LOW = 16
_CLIPPED_HIGH = 245

#: Geometric pose model. The nose tip sits ahead of the plane of the eyes by
#: roughly 0.45 inter-ocular distances, and ahead of the eye-to-mouth span by
#: roughly 0.39 of that span, so a yaw of θ moves the nose sideways by about
#: 0.45·tan θ inter-ocular distances. Estimates, not measurements — see the
#: module note.
#:
#: The frontal nose position (how far from the eye line toward the mouth line
#: the nose tip sits when the face is level) is 0.59: the median over 104
#: frontal studio portraits in the calibration corpus, p5-p95 0.55-0.63.
#: The SFace alignment template implies 0.495, but YuNet places its nose
#: landmark lower than that template does, and using 0.495 read every frontal
#: portrait as ~13° "looking down".
_YAW_DEPTH_RATIO = 0.45
_PITCH_DEPTH_RATIO = 0.39
_FRONTAL_NOSE_POSITION = 0.59


@dataclass(frozen=True)
class FaceMeasurements:
    detection_confidence: float
    #: Shorter side of the detector's box, in pixels of the submitted image.
    face_size_px: float
    #: Distance between the eye landmarks, in pixels. None without landmarks.
    inter_eye_px: float | None
    #: Variance of the Laplacian of the aligned face at 112x112.
    sharpness: float | None
    #: Mean luminance (0-255) of the central face region.
    brightness: float | None
    #: Fraction of the face region crushed to black / blown to white.
    underexposed_fraction: float | None
    overexposed_fraction: float | None
    yaw_deg: float | None
    pitch_deg: float | None
    roll_deg: float | None
    #: False when the landmarks are geometrically implausible for a face —
    #: eyes outside the box, mouth above the eyes. Not a visibility check: a
    #: five-point detector predicts eye positions even behind sunglasses.
    landmarks_plausible: bool | None


@dataclass(frozen=True)
class QualityProfile:
    """Where each check fails (``*_min``/``*_max``) and where it is comfortably
    passed (``*_good``). The score ramps linearly between the two."""

    name: str
    min_detection_confidence: float
    good_detection_confidence: float
    min_face_px: float
    good_face_px: float
    min_sharpness: float
    good_sharpness: float
    min_brightness: float
    max_brightness: float
    max_underexposed_fraction: float
    max_overexposed_fraction: float
    max_abs_yaw_deg: float
    max_abs_pitch_deg: float
    #: Beyond this the aligner is being asked to undo a head lying on its side.
    max_abs_roll_deg: float = 45.0


#: Enrollment: refuse anything that would make a weak permanent template.
#:
#: Each limit sits where the calibration corpus showed the genuine similarity
#: of a degraded probe still within ~2 points of the clean baseline — a
#: template is compared every day for a term, so it is held to "no measurable
#: loss", not "still matches". Numbers: docs/FACE_RECOGNITION_CALIBRATION.md.
ENROLLMENT_PROFILE = QualityProfile(
    name="enrollment",
    # Clean studio portraits scored 0.77-0.96; 0.80 refused three of them.
    min_detection_confidence=0.70,
    good_detection_confidence=0.85,
    # No measurable loss down to 48px; 64 keeps a margin and still asks for
    # a face that fills a reasonable part of a phone frame.
    min_face_px=64.0,
    good_face_px=112.0,
    # Blur sigma 1.4 at 112px (sharpness ~98) cost 2 points of "present";
    # sigma 1.8 (~58) cost 4.
    min_sharpness=90.0,
    good_sharpness=200.0,
    # Darkening to ~50 cost 4 points; over-exposure is far worse (~190 cost
    # 4, ~216 cost 36), so the upper limit is the tighter one.
    min_brightness=60.0,
    max_brightness=200.0,
    max_underexposed_fraction=0.10,
    max_overexposed_fraction=0.10,
    # NOT validated: a portrait corpus has no turned heads (observed yaw
    # -18..+18, pitch -16..+9 after recentring). Engineering estimates.
    max_abs_yaw_deg=30.0,
    max_abs_pitch_deg=25.0,
)

#: Group photos: flag, do not refuse. A flagged face is still matched, and a
#: match on it goes to a human. Each limit sits where the fraction of genuine
#: probes still reaching ``matchThreshold`` fell by roughly ten points.
GROUP_PROFILE = QualityProfile(
    name="group",
    min_detection_confidence=0.60,
    good_detection_confidence=0.80,
    # 32px: -2 points. 28px: -12. 20px: -42.
    min_face_px=30.0,
    good_face_px=48.0,
    # Sharpness ~38: -6 points. ~22: -12. ~13: -37.
    min_sharpness=20.0,
    good_sharpness=60.0,
    # Brightness ~26 (14% crushed): -6. ~17 (41% crushed): -15.
    # Brightness ~192 (18% blown): -4. ~216 (50% blown): -36.
    min_brightness=28.0,
    max_brightness=210.0,
    max_underexposed_fraction=0.30,
    max_overexposed_fraction=0.25,
    # NOT validated — see ENROLLMENT_PROFILE.
    max_abs_yaw_deg=40.0,
    max_abs_pitch_deg=35.0,
)

#: Below this a face is not embedded at all, in any profile, and is reported
#: as ``face_too_small`` so the teacher can take a closer photo. At 20px the
#: calibration corpus still matched half its genuine probes at
#: ``matchThreshold`` (always flagged, so always reviewed); below it the
#: aligned crop is mostly interpolation.
MIN_EMBEDDABLE_FACE_PX = 20.0

#: Most actionable first. "Move closer" fixes a small face that is also
#: blurry; "hold still" does not fix a face that is too small.
_REASON_ORDER: tuple[FaceQualityReason, ...] = (
    "face_too_small",
    "bad_angle",
    "too_dark",
    "too_bright",
    "blurred",
    "occluded",
    "low_quality",
)


def _mid(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    return ((a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0)


def estimate_pose(
    landmarks: FaceLandmarks,
) -> tuple[float, float, float, float, bool]:
    """``(yaw, pitch, roll, inter_eye_px, plausible)`` from five landmarks.

    Sign conventions, in the unmirrored image the camera produced:

    * yaw > 0: the nose has moved toward the image's right — the subject has
      turned toward *their own left*.
    * pitch > 0: the nose has dropped toward the mouth — looking down.
    * roll: angle of the eye line from horizontal.
    """
    re = (landmarks.right_eye.x, landmarks.right_eye.y)
    le = (landmarks.left_eye.x, landmarks.left_eye.y)
    nose = (landmarks.nose_tip.x, landmarks.nose_tip.y)
    mouth = _mid(
        (landmarks.mouth_right.x, landmarks.mouth_right.y),
        (landmarks.mouth_left.x, landmarks.mouth_left.y),
    )
    eyes = _mid(re, le)

    ex, ey = le[0] - re[0], le[1] - re[1]
    inter_eye = math.hypot(ex, ey)
    if inter_eye < 1e-6:
        return 0.0, 0.0, 0.0, 0.0, False
    # Face-aligned axes: u along the eye line, v perpendicular pointing from
    # the eyes toward the mouth. Removes roll before yaw and pitch are read.
    ux, uy = ex / inter_eye, ey / inter_eye
    vx, vy = -uy, ux
    roll = math.degrees(math.atan2(ey, ex))

    centre = _mid(eyes, mouth)
    offset_u = ((nose[0] - centre[0]) * ux + (nose[1] - centre[1]) * uy) / inter_eye
    yaw = math.degrees(math.atan2(offset_u, _YAW_DEPTH_RATIO))

    span = (mouth[0] - eyes[0]) * vx + (mouth[1] - eyes[1]) * vy
    plausible = span > 0.2 * inter_eye
    if span <= 1e-6:
        return yaw, 0.0, roll, inter_eye, False
    along = ((nose[0] - eyes[0]) * vx + (nose[1] - eyes[1]) * vy) / span
    pitch = math.degrees(math.atan2(along - _FRONTAL_NOSE_POSITION, _PITCH_DEPTH_RATIO))
    return yaw, pitch, roll, inter_eye, plausible


def _landmarks_inside(landmarks: FaceLandmarks, box: BoundingBox) -> bool:
    # A little slack: a landmark on the edge of a clipped box is fine.
    pad_x, pad_y = box.width * 0.15, box.height * 0.15
    for point in (
        landmarks.left_eye,
        landmarks.right_eye,
        landmarks.nose_tip,
        landmarks.mouth_left,
        landmarks.mouth_right,
    ):
        if not (box.x - pad_x <= point.x <= box.x + box.width + pad_x):
            return False
        if not (box.y - pad_y <= point.y <= box.y + box.height + pad_y):
            return False
    return True


def _central_region(grey: np.ndarray) -> np.ndarray:
    """The middle of the aligned face — cheeks, eyes, nose — without the
    corners, which after alignment are hair, background or padding."""
    h, w = grey.shape[:2]
    return grey[int(h * 0.2) : int(h * 0.9), int(w * 0.2) : int(w * 0.8)]


def measure(
    detection_confidence: float,
    box: BoundingBox,
    landmarks: FaceLandmarks | None,
    aligned_crop: np.ndarray | None,
) -> FaceMeasurements:
    """Every measurement the inputs support, and ``None`` for the rest."""
    import cv2

    face_px = float(min(box.width, box.height))

    sharpness = brightness = under = over = None
    if aligned_crop is not None and aligned_crop.size:
        crop = aligned_crop
        if crop.shape[0] != MEASURE_SIZE or crop.shape[1] != MEASURE_SIZE:
            crop = cv2.resize(
                crop, (MEASURE_SIZE, MEASURE_SIZE), interpolation=cv2.INTER_AREA
            )
        grey = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY) if crop.ndim == 3 else crop
        centre = _central_region(grey)
        sharpness = float(cv2.Laplacian(centre, cv2.CV_64F).var())
        brightness = float(centre.mean())
        under = float(np.mean(centre <= _CLIPPED_LOW))
        over = float(np.mean(centre >= _CLIPPED_HIGH))

    yaw = pitch = roll = inter_eye = None
    plausible: bool | None = None
    if landmarks is not None:
        yaw, pitch, roll, inter_eye, geometric = estimate_pose(landmarks)
        plausible = geometric and _landmarks_inside(landmarks, box)

    return FaceMeasurements(
        detection_confidence=float(min(max(detection_confidence, 0.0), 1.0)),
        face_size_px=face_px,
        inter_eye_px=inter_eye,
        sharpness=sharpness,
        brightness=brightness,
        underexposed_fraction=under,
        overexposed_fraction=over,
        yaw_deg=yaw,
        pitch_deg=pitch,
        roll_deg=roll,
        landmarks_plausible=plausible,
    )


def _ramp(value: float, bad: float, good: float) -> float:
    """0 at ``bad``, 1 at ``good``, linear between, clamped."""
    if good == bad:
        return 1.0 if value >= good else 0.0
    return float(min(1.0, max(0.0, (value - bad) / (good - bad))))


@dataclass(frozen=True)
class QualityVerdict:
    reasons: list[FaceQualityReason] = field(default_factory=list)
    score: float = 0.0

    @property
    def ok(self) -> bool:
        return not self.reasons

    @property
    def primary(self) -> FaceQualityReason:
        return self.reasons[0] if self.reasons else "ok"


def evaluate(m: FaceMeasurements, profile: QualityProfile) -> QualityVerdict:
    """Every failed check, most actionable first, and a score.

    The score is the smallest per-check margin, not a mean: a face that is
    sharp, well lit and frontal but twenty pixels across is a bad face.
    """
    failed: set[FaceQualityReason] = set()
    factors: list[float] = []

    factors.append(_ramp(m.face_size_px, profile.min_face_px, profile.good_face_px))
    if m.face_size_px < profile.min_face_px:
        failed.add("face_too_small")

    factors.append(
        _ramp(
            m.detection_confidence,
            profile.min_detection_confidence,
            profile.good_detection_confidence,
        )
    )
    if m.detection_confidence < profile.min_detection_confidence:
        # A weak detection is the honest proxy for "something is in the way".
        failed.add("occluded")

    if m.sharpness is not None:
        factors.append(
            _ramp(m.sharpness, profile.min_sharpness, profile.good_sharpness)
        )
        if m.sharpness < profile.min_sharpness:
            failed.add("blurred")

    if m.brightness is not None:
        if m.brightness < profile.min_brightness or (
            m.underexposed_fraction is not None
            and m.underexposed_fraction > profile.max_underexposed_fraction
        ):
            failed.add("too_dark")
        if m.brightness > profile.max_brightness or (
            m.overexposed_fraction is not None
            and m.overexposed_fraction > profile.max_overexposed_fraction
        ):
            failed.add("too_bright")
        low_margin = _ramp(
            m.brightness, profile.min_brightness, profile.min_brightness + 30
        )
        high_margin = _ramp(
            -m.brightness, -profile.max_brightness, -(profile.max_brightness - 30)
        )
        factors.append(min(low_margin, high_margin))

    if m.yaw_deg is not None and m.pitch_deg is not None:
        yaw_margin = _ramp(-abs(m.yaw_deg), -profile.max_abs_yaw_deg, 0.0)
        pitch_margin = _ramp(-abs(m.pitch_deg), -profile.max_abs_pitch_deg, 0.0)
        # Pose only has to be inside the limit; a perfectly frontal face is not
        # "better" than one turned ten degrees, so the ramp saturates early.
        factors.append(min(1.0, 2.0 * min(yaw_margin, pitch_margin)))
        if (
            abs(m.yaw_deg) > profile.max_abs_yaw_deg
            or abs(m.pitch_deg) > profile.max_abs_pitch_deg
            or (m.roll_deg is not None and abs(m.roll_deg) > profile.max_abs_roll_deg)
        ):
            failed.add("bad_angle")

    if m.landmarks_plausible is False:
        failed.add("low_quality")

    reasons = [reason for reason in _REASON_ORDER if reason in failed]
    score = 0.0 if not factors else float(min(factors))
    if reasons:
        # A face that failed a check never reports a score that reads as
        # acceptable, even if the failed check contributed no factor.
        score = min(score, 0.49)
    return QualityVerdict(reasons=reasons, score=score)


def metrics_from(m: FaceMeasurements | None) -> FaceQualityMetrics:
    """The wire representation. Unmeasured is ``unavailable``, never zero."""
    if m is None:
        return FaceQualityMetrics.all_unavailable()

    def metric(value: float | None, unit: str) -> FaceQualityMetric:
        return (
            FaceQualityMetric.measured(value, unit)
            if value is not None
            else FaceQualityMetric.unavailable()
        )

    pose_value = (
        max(abs(m.yaw_deg), abs(m.pitch_deg))
        if m.yaw_deg is not None and m.pitch_deg is not None
        else None
    )
    return FaceQualityMetrics(
        blur=metric(m.sharpness, "laplacian_variance_aligned_112"),
        brightness=metric(m.brightness, "mean_luminance_0_255"),
        faceSize=metric(m.face_size_px, "pixels"),
        pose=metric(pose_value, "degrees_estimate"),
        occlusion=FaceQualityMetric.unavailable(),
        yaw=metric(m.yaw_deg, "degrees_estimate"),
        pitch=metric(m.pitch_deg, "degrees_estimate"),
        underexposure=metric(m.underexposed_fraction, "fraction"),
        overexposure=metric(m.overexposed_fraction, "fraction"),
        detectionConfidence=metric(m.detection_confidence, "score_0_1"),
        interEyeDistance=metric(m.inter_eye_px, "pixels"),
    )
