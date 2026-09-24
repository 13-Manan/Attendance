"""Calibrate the quality profiles and match thresholds against the real model.

    python -m bench.calibrate_quality --model-dir models \\
        --corpus /path/outside/repo/pairs [--singles /path/outside/repo/singles] \\
        --out /tmp/calibration.json

**The corpus never enters the repository.** It is a directory of
``<id>_enroll.jpg`` / ``<id>_probe.jpg`` pairs — two different photographs of
one person — plus, optionally, a directory of single photos of other people.
Only aggregate numbers leave this script: no image, crop or embedding is
written anywhere.

Three questions, each answered with the model that is actually loaded:

1. **Where do genuine and impostor similarities fall?** Every enrol/probe pair
   of the same identity is a genuine comparison; every cross-identity pair is
   an impostor comparison. This is what ``matchThreshold`` / ``reviewThreshold``
   are validated against.

2. **How fast does a genuine match degrade as a property worsens?** Each probe
   is degraded synthetically — shrunk onto a larger canvas, blurred, darkened,
   over-exposed — then re-detected, re-measured with ``app.quality.measure``
   and re-embedded. The similarity to the *clean* enrolment template, grouped
   by the measured metric, shows where a property starts to push genuine
   matches down into the review band. That is where the profile threshold
   belongs, and it is measured in the same units the profile uses.

3. **How many genuine probes does each profile reject?** Run over the clean
   corpus, a sensible enrolment profile passes nearly every studio portrait.

What it cannot do: pose. Synthetic yaw needs a 3-D face model, and every
photo in a portrait corpus is frontal. The pose limits are therefore NOT
validated here and the report says so.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.models.opencv_provider import OpenCVFaceModelProvider
from app.quality import (
    ENROLLMENT_PROFILE,
    GROUP_PROFILE,
    FaceMeasurements,
    evaluate,
    measure,
)
from app.schemas import DEFAULT_MATCH_THRESHOLDS

#: Genuine pairs at or above this are almost certainly the same photograph
#: re-cropped rather than two photographs, and would flatter every number.
NEAR_DUPLICATE = 0.95

SIZE_LEVELS = (160, 120, 100, 80, 64, 56, 48, 40, 36, 32, 28, 24, 20, 17, 14)
BLUR_SIGMAS = (0.0, 0.6, 1.0, 1.4, 1.8, 2.2, 2.8, 3.5, 4.5)
GAINS = (0.12, 0.18, 0.25, 0.35, 0.5, 0.7, 1.0, 1.4, 1.8, 2.3, 3.0)
CANVAS = (960, 720)
_OTHER_METRICS = (
    "detection_confidence",
    "sharpness",
    "brightness",
    "underexposed_fraction",
    "overexposed_fraction",
)


@dataclass
class Face:
    measurements: FaceMeasurements
    embedding: np.ndarray


@dataclass
class Sweep:
    name: str
    metric: str
    rows: list[dict] = field(default_factory=list)


def _largest_face(provider: OpenCVFaceModelProvider, frame: np.ndarray) -> Face | None:
    detector, aligner, embedder = provider._require_loaded()
    found = detector.detect_frame(frame)
    if not found:
        return None
    face = max(found, key=lambda f: f.box.width * f.box.height)
    crop = aligner.align_frame(frame, face.box, face.landmarks)
    raw = embedder.embed_crops([crop.crop])[0]
    vector = np.asarray(provider._normalise(raw), dtype=np.float64)
    return Face(measure(face.score, face.box, face.landmarks, crop.crop), vector)


def _read(path: Path) -> np.ndarray | None:
    import cv2

    return cv2.imread(str(path), cv2.IMREAD_COLOR)


def _on_canvas(frame: np.ndarray, face_px: float, target_px: int) -> np.ndarray:
    """Scale ``frame`` so its face is ``target_px`` across, centred on a
    neutral canvas — a small face in a large photo, which is what a back row
    is, rather than a small photo."""
    import cv2

    scale = target_px / face_px
    h, w = frame.shape[:2]
    small = cv2.resize(
        frame,
        (max(1, round(w * scale)), max(1, round(h * scale))),
        interpolation=cv2.INTER_AREA,
    )
    canvas = np.full((CANVAS[1], CANVAS[0], 3), 118, dtype=np.uint8)
    sh, sw = small.shape[:2]
    sh, sw = min(sh, CANVAS[1]), min(sw, CANVAS[0])
    y0, x0 = (CANVAS[1] - sh) // 2, (CANVAS[0] - sw) // 2
    canvas[y0 : y0 + sh, x0 : x0 + sw] = small[:sh, :sw]
    return canvas


def _blur(frame: np.ndarray, sigma: float, face_px: float) -> np.ndarray:
    """Blur at a fixed face size of 112px, so sigma means the same thing on
    every image (and matches the size the embedder sees)."""
    import cv2

    base = _on_canvas(frame, face_px, 112)
    return cv2.GaussianBlur(base, (0, 0), sigma) if sigma > 0 else base


def _gain(frame: np.ndarray, gain: float) -> np.ndarray:
    return np.clip(frame.astype(np.float32) * gain, 0, 255).astype(np.uint8)


def _pct(values: list[float], q: float) -> float | None:
    return float(np.percentile(values, q)) if values else None


def _summary(values: list[float]) -> dict:
    if not values:
        return {"n": 0}
    return {
        "n": len(values),
        "min": round(min(values), 4),
        "p01": round(_pct(values, 1), 4),
        "p05": round(_pct(values, 5), 4),
        "p10": round(_pct(values, 10), 4),
        "median": round(statistics.median(values), 4),
        "p90": round(_pct(values, 90), 4),
        "p99": round(_pct(values, 99), 4),
        "max": round(max(values), 4),
    }


def _metric_value(m: FaceMeasurements, metric: str) -> float | None:
    return {
        "face_size_px": m.face_size_px,
        "sharpness": m.sharpness,
        "brightness": m.brightness,
    }[metric]


def run(args: argparse.Namespace) -> dict:
    provider = OpenCVFaceModelProvider(model_dir=args.model_dir)
    provider.load()
    thresholds = DEFAULT_MATCH_THRESHOLDS
    present, review = thresholds.match_threshold, thresholds.review_threshold

    corpus = Path(args.corpus)
    ids = sorted(p.name[: -len("_enroll.jpg")] for p in corpus.glob("*_enroll.jpg"))
    enrol: dict[str, Face] = {}
    probe: dict[str, Face] = {}
    probe_frames: dict[str, tuple[np.ndarray, float]] = {}
    undetected: list[str] = []
    for ident in ids:
        e_frame = _read(corpus / f"{ident}_enroll.jpg")
        p_frame = _read(corpus / f"{ident}_probe.jpg")
        if e_frame is None or p_frame is None:
            continue
        e, p = _largest_face(provider, e_frame), _largest_face(provider, p_frame)
        if e is None or p is None:
            undetected.append(ident)
            continue
        enrol[ident], probe[ident] = e, p
        probe_frames[ident] = (p_frame, p.measurements.face_size_px)

    genuine_all = {i: float(enrol[i].embedding @ probe[i].embedding) for i in enrol}
    duplicates = sorted(i for i, s in genuine_all.items() if s >= NEAR_DUPLICATE)
    usable = [i for i in enrol if i not in duplicates]
    genuine = [genuine_all[i] for i in usable]

    singles: list[Face] = []
    if args.singles:
        for path in sorted(Path(args.singles).glob("*.jpg")):
            frame = _read(path)
            face = _largest_face(provider, frame) if frame is not None else None
            if face is not None:
                singles.append(face)

    impostor: list[float] = []
    for i in usable:
        for j in usable:
            if i != j:
                impostor.append(float(enrol[i].embedding @ probe[j].embedding))
        for s in singles:
            impostor.append(float(enrol[i].embedding @ s.embedding))

    def rates(threshold: float) -> dict:
        return {
            "threshold": threshold,
            "genuine_at_or_above": round(np.mean([g >= threshold for g in genuine]), 4)
            if genuine
            else None,
            "impostor_at_or_above": round(
                float(np.mean([s >= threshold for s in impostor])), 6
            )
            if impostor
            else None,
        }

    grid = [round(t, 3) for t in np.arange(0.25, 0.80, 0.025)]

    # Rank-1 closed-set identification: does the probe's best-scoring enrolment
    # belong to the same person, and by what margin over the runner-up?
    rank1_hits, margins = 0, []
    for i in usable:
        scores = sorted(
            ((float(enrol[j].embedding @ probe[i].embedding), j) for j in usable),
            reverse=True,
        )
        rank1_hits += scores[0][1] == i
        if scores[0][1] == i and len(scores) > 1:
            margins.append(scores[0][0] - scores[1][0])

    def sweep(name: str, metric: str, levels, degrade) -> Sweep:
        out = Sweep(name=name, metric=metric)
        for level in levels:
            sims, metric_values, misses, profile_fail = (
                [],
                [],
                0,
                {"enrollment": 0, "group": 0},
            )
            best_impostor, rank1_wrong = [], 0
            others: dict[str, list[float]] = {k: [] for k in _OTHER_METRICS}
            for ident in usable:
                frame, face_px = probe_frames[ident]
                degraded = degrade(frame, face_px, level)
                face = _largest_face(provider, degraded)
                if face is None:
                    misses += 1
                    continue
                genuine_sim = float(enrol[ident].embedding @ face.embedding)
                sims.append(genuine_sim)
                # Does degradation make a probe look like somebody else? The
                # strongest wrong identity is what the review band must absorb.
                wrong = max(
                    float(enrol[j].embedding @ face.embedding)
                    for j in usable
                    if j != ident
                )
                best_impostor.append(wrong)
                rank1_wrong += wrong >= genuine_sim
                value = _metric_value(face.measurements, metric)
                if value is not None:
                    metric_values.append(value)
                for key in _OTHER_METRICS:
                    other = getattr(face.measurements, key)
                    if other is not None:
                        others[key].append(float(other))
                profile_fail["enrollment"] += not evaluate(
                    face.measurements, ENROLLMENT_PROFILE
                ).ok
                profile_fail["group"] += not evaluate(
                    face.measurements, GROUP_PROFILE
                ).ok
            n = len(usable)
            out.rows.append(
                {
                    "level": level,
                    "detected": n - misses,
                    "of": n,
                    "metric_median": round(statistics.median(metric_values), 2)
                    if metric_values
                    else None,
                    "sim_median": round(statistics.median(sims), 4) if sims else None,
                    "sim_p10": round(_pct(sims, 10), 4) if sims else None,
                    "at_or_above_present": round(
                        np.mean([s >= present for s in sims]), 3
                    )
                    if sims
                    else None,
                    "at_or_above_review": round(np.mean([s >= review for s in sims]), 3)
                    if sims
                    else None,
                    "best_impostor_max": round(max(best_impostor), 4)
                    if best_impostor
                    else None,
                    "best_impostor_at_or_above_review": int(
                        sum(v >= review for v in best_impostor)
                    ),
                    "rank1_wrong": rank1_wrong,
                    "medians": {
                        k: round(statistics.median(v), 4)
                        for k, v in others.items()
                        if v
                    },
                    "flagged_by_group_profile": profile_fail["group"],
                    "refused_by_enrollment_profile": profile_fail["enrollment"],
                }
            )
            print(f"  {name} {level}", file=sys.stderr)
        return out

    print("sweeps (stderr is progress only)", file=sys.stderr)
    sweeps = [
        sweep(
            "size", "face_size_px", SIZE_LEVELS, lambda f, px, lv: _on_canvas(f, px, lv)
        ),
        sweep("blur", "sharpness", BLUR_SIGMAS, lambda f, px, lv: _blur(f, lv, px)),
        sweep(
            "gain",
            "brightness",
            GAINS,
            lambda f, px, lv: _gain(_on_canvas(f, px, 112), lv),
        ),
    ]

    clean_profile = {
        profile.name: {
            "refused": sorted(
                i for i in usable if not evaluate(probe[i].measurements, profile).ok
            ),
            "reasons": {
                i: evaluate(probe[i].measurements, profile).reasons
                for i in usable
                if not evaluate(probe[i].measurements, profile).ok
            },
        }
        for profile in (ENROLLMENT_PROFILE, GROUP_PROFILE)
    }

    clean_metrics = {
        name: _summary(
            [
                v
                for v in (getattr(probe[i].measurements, name) for i in usable)
                if v is not None
            ]
        )
        for name in (
            "detection_confidence",
            "face_size_px",
            "sharpness",
            "brightness",
            "underexposed_fraction",
            "overexposed_fraction",
            "yaw_deg",
            "pitch_deg",
            "roll_deg",
        )
    }

    return {
        "model": provider.model_info().model_dump(by_alias=True, exclude={"stages"}),
        "corpus": {
            "identities": len(ids),
            "detected_both": len(enrol),
            "undetected": undetected,
            "near_duplicate_pairs_excluded": duplicates,
            "usable_genuine_pairs": len(usable),
            "singles": len(singles),
            "impostor_comparisons": len(impostor),
        },
        "thresholds_in_use": {"match": present, "review": review},
        "genuine": _summary(genuine),
        "impostor": _summary(impostor),
        "rates": [rates(t) for t in grid],
        "rank1": {
            "hits": rank1_hits,
            "of": len(usable),
            "margin": _summary(margins),
        },
        "clean_probe_metrics": clean_metrics,
        "clean_probe_profile_refusals": clean_profile,
        "sweeps": [s.__dict__ for s in sweeps],
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--model-dir", required=True)
    parser.add_argument(
        "--corpus", required=True, help="Directory of <id>_enroll/_probe.jpg pairs"
    )
    parser.add_argument("--singles", help="Directory of single photos of other people")
    parser.add_argument("--out", help="Write the JSON report here (outside the repo)")
    args = parser.parse_args(argv)
    report = run(args)
    text = json.dumps(report, indent=1, default=float)
    if args.out:
        Path(args.out).write_text(text)
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
