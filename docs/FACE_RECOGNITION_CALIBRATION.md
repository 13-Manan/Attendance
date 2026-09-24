# Face recognition — threshold and quality calibration

What the thresholds are, which model they were measured against, how, and
what the measurement does not cover. Read this before changing
`presentMin` / `reviewMin`, `DEFAULT_MATCH_THRESHOLDS`, `SAME_TEMPLATE_SIMILARITY`
or either quality profile in `services/face-ai/app/quality.py`.

**This is a technical calibration, not a production approval.** The model it
was measured on (YuNet + SFace, backend `opencv`) is **not production-approved**:
its training-data provenance is unresolved. See
[`services/face-ai/app/models/LICENSING.md`](../services/face-ai/app/models/LICENSING.md).
Production still runs `mock`, which recognises nobody.

---

## 1. Model under test

| | |
| --- | --- |
| Backend | `opencv` — YuNet 2023mar (detector) + SFace 2021dec (recogniser) |
| `modelVersion` | `yunet-2023mar+sface-2021dec+pp1` |
| Embedding | 128-d, L2-normalised; cosine similarity = dot product |
| Weights | SHA-256 pinned in `app/models/model_files.py` |
| `productionEligible` | `false` (`commercialUse: "unclear"`) |

Thresholds are **model-specific**. A different recogniser — or the same one
with different preprocessing — puts genuine and impostor scores somewhere else,
and every number below has to be re-measured before it is trusted.

## 2. Corpus

Official portraits of members of the US Congress, taken from Wikimedia Commons
and filtered to files whose licence metadata says **public domain** (works of
the US federal government). Two different photographs per identity, usually
from different terms — so years apart, different lighting, different
photographer.

| | |
| --- | --- |
| Identities (enrol/probe pairs) | 61 |
| Additional single-photo identities (impostors only) | 90 files, 89 with a detectable face |
| Genuine comparisons | 61 |
| Impostor comparisons | 9,089 (61 × 60 cross-pairs + 61 × 89 singles) |
| Near-duplicate pairs excluded (≥ 0.95) | 0 |

**The corpus never enters the repository.** It lives outside the tree
(`/tmp/faceqa/…` on the machine that ran it), and the harness writes only
aggregate numbers — no image, crop or embedding. Tests that need it are
skipped unless `FACE_QA_CORPUS` points at it.

## 3. Match thresholds

Harness: `python -m bench.calibrate_quality --model-dir models --corpus <pairs> --singles <singles> --out <json>`.

| Cosine similarity | Genuine (n = 61) | Impostor (n = 9,089) |
| --- | --- | --- |
| min | 0.562 | −0.211 |
| p01 | 0.574 | −0.094 |
| p05 | 0.635 | −0.035 |
| median | 0.778 | 0.109 |
| p99 | 0.879 | 0.313 |
| max | 0.879 | **0.422** |

| Threshold | Genuine at or above | Impostor at or above |
| --- | --- | --- |
| 0.40 | 100% | 0.044% (4) |
| 0.425 | 100% | 0 |
| **0.45 (`reviewMin`)** | **100%** | **0** |
| 0.55 | 100% | 0 |
| 0.60 | 96.7% | 0 |
| **0.62 (`presentMin`)** | **96.7%** | **0** |
| 0.65 | 93.4% | 0 |

Rank-1 closed-set identification: **61 / 61**, with the smallest winning margin
over the runner-up **0.283** (median 0.486). The `ambiguityMargin` of 0.05
therefore fires only on genuinely close calls, not on ordinary ones.

**Decision: keep `presentMin = 0.62`, `reviewMin = 0.45`.**

- `presentMin` 0.62 sits ~0.20 above the highest impostor score measured on
  clean photos, and ~0.16 above the highest measured under any degradation
  (§5). The two genuine pairs below it (0.562, 0.574) land in review, not
  absent.
- `reviewMin` 0.45 keeps every genuine pair in scope. **The margin below it is
  thin**: the worst clean impostor is 0.422, and two degraded impostors reached
  0.454 and 0.459 (§5). That is acceptable only because review is a request
  for a person to decide — a face in the review band never becomes PRESENT on
  its own — but it means "Needs review" will occasionally name a stranger's
  face as a possible match. That is the band doing its job, not a defect.

Statistical honesty: zero failures in 9,089 impostor comparisons bounds the
per-comparison false-review rate at about 0.033% (rule of three, 95%). A
40-student class compares each unknown face against 40 templates, so on this
evidence an unknown face reaches "Needs review" at most ~1.3% of the time
— and reached "Present" in no comparison observed.

## 4. Enrolment collision and same-template checks

- `SAME_TEMPLATE_SIMILARITY = 0.99` (`face-enrollment/policy.ts`): the highest
  similarity between two *different* photographs of the same person was 0.879,
  and no pair reached the 0.95 near-duplicate line. 0.99 therefore only catches
  the same capture submitted twice.
- `classifyEnrollmentCollision` refuses a sample that scores ≥ `reviewMin`
  against another student. With the worst clean impostor at 0.422, that
  produced no false refusal on this corpus; the thin margin above means a rare
  false refusal ("Could not be saved") is possible. It fails safe: nobody is
  enrolled as someone else, and the person retakes the sample.

## 5. Quality profiles

Each clean probe was degraded synthetically, re-detected, re-measured with
`app.quality.measure`, and compared to the clean enrolment template.

**Face size** (face rescaled onto a larger canvas):

| Face px | Present | Review or better | Worst impostor | Rank-1 wrong |
| --- | --- | --- | --- | --- |
| 64 | 95.1% | 100% | 0.394 | 0 |
| 40 | 93.4% | 100% | 0.401 | 0 |
| 32 | 90.2% | 100% | 0.429 | 0 |
| **28** | 82.0% | 95.1% | 0.397 | 0 |
| 20 | 54.1% | 91.8% | 0.395 | 0 |
| 17 | 31.1% | 83.6% | 0.391 | 1 |
| 14 | 5.2% | 58.6% | 0.332 | 4 (3 undetected) |

`GROUP_PROFILE.min_face_px = 30` sits just above where "present" recall
drops ten points; `ENROLLMENT_PROFILE.min_face_px = 64` keeps a wide margin.
Faces under 30 px are still matched but flagged, and the review board shows
"Face too small".

**Blur** (Gaussian, sigma scaled to face size): sharpness ~20 (sigma 2.8)
still kept 98.4% in review and 82% present — `GROUP_PROFILE.min_sharpness = 20`.
Enrolment requires 90 (−3 points of present at ~91).

**Exposure**: under-exposure is forgiving (brightness ~26: 88.5% present,
100% review); over-exposure is not (~216: 57.4% present; ~233: 31.1%).
Group limits 28–210, enrolment 60–200.

On the clean corpus, neither profile refused any of the 61 probes.

## 6. What this calibration does not cover

1. **Pose.** Every portrait is frontal. The yaw estimator read −18° to +16° on
   photos that were all meant to be frontal, so pose limits are engineering
   estimates, and the guided enrolment steps ("slightly to the left") are
   prompts, not checks.
2. **Children.** The corpus is adults. Faces change quickly between 5 and 18;
   genuine similarity after a year of growth is unmeasured, so is the rate of
   templates going stale. Re-enrolment cadence is a product decision this
   data cannot make.
3. **Look-alikes within a class.** Siblings, twins and cousins in one class
   are the realistic impostor, and none are in this corpus. The ambiguity
   margin and the review band are the mitigation; their effectiveness on
   relatives is unmeasured.
4. **Demographics.** The corpus is not representative of any school's
   population. No fairness claim is made in either direction.
5. **Real classroom photos.** Group-photo tests compose portraits onto a
   canvas: the compute is real, the scene (occlusion, motion, uneven light,
   heads behind heads) is not.
6. **Scale of the sample.** 61 genuine pairs cannot measure a false-rejection
   rate below a few percent, nor a false-acceptance rate below ~1 in 3,000.

Before production, re-run §3–§5 on a consented, representative corpus with a
disjoint enrolment/test split — ideally photos from the deployment's own
cameras — and keep this document's decision only if the numbers hold.

## 7. Reproducing

```sh
cd services/face-ai
python scripts/fetch_models.py                        # pinned, SHA-verified weights
python -m bench.calibrate_quality --model-dir models \
    --corpus /path/outside/repo/pairs --singles /path/outside/repo/singles \
    --out /path/outside/repo/calibration.json
FACE_QA_CORPUS=/path/outside/repo/pairs pytest tests/test_group_photo_corpus.py
python -m bench.group_perf --model-dir models --corpus /path/outside/repo/pairs \
    --out /path/outside/repo/gperf
```

Run on 2026-09-24, macOS arm64, Python 3.11.16, OpenCV 4.14.0.
