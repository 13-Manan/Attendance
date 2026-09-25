# Face recognition benchmark

A repeatable process for answering two questions that code review cannot:

1. **What thresholds should this deployment use?**
2. **How wrong is the system at those thresholds, and wrong in which direction?**

> **This is the accuracy harness, and it needs a licensed model and a
> consented dataset — neither of which exists yet.** The *performance*
> half lives next door in [`perf.py`](#performance-benchmark-perfpy) and
> needs neither; it has been run, and its results are in
> [`docs/BENCHMARKS.md`](../../../docs/BENCHMARKS.md).

The Phase 5 requirement is explicit: threshold values must be determined
through real-world benchmarking, not chosen because they look reasonable. The
values currently shipped in `apps/web` (`presentMin 0.62`, `reviewMin 0.45`)
are **plumbing defaults that no dataset has validated**. Until this harness
has been run against real classroom captures with a real licence-cleared
model, the system has not been benchmarked.

> The goal is **not** 100% recognition. It is to minimise errors and route
> uncertainty to a human. A configuration with 88% accuracy and 0% false
> acceptance is better than one with 96% accuracy that silently marks four
> absent students present.

---

## Why raw scores are stored separately

`runner.py` records similarities, detection counts and timings. It makes no
present/absent decisions, because those depend on thresholds — and choosing
thresholds is the point of the exercise.

That split is what makes the process cheap to iterate:

```
manifest.json ──(inference, minutes/hours)──> raw.json ──(analysis, ms)──> report.md
                                                 │
                                                 └──> re-analyse at 200 other thresholds
```

Re-running the analysis costs milliseconds and zero GPU time. Never re-run
inference to try a different threshold.

---

## 1. Build a dataset

Create a directory with a `manifest.json` and the images it references.

```
my-benchmark/
  manifest.json
  enroll/
    s001-a.jpg     # enrolment photos — the gallery
    s001-b.jpg
  captures/
    lect-01-1.jpg  # classroom photos — the probes
    lect-01-2.jpg
```

```json
{
  "datasetId": "autumn-2026-pilot",
  "description": "3 classrooms, 2 cameras, morning and evening sessions",
  "notes": "Consent obtained under <reference>; images retained until <date>.",
  "cohorts": [
    {
      "cohortId": "cse-3a",
      "label": "CSE 3A (50 students)",
      "students": [
        { "studentId": "s001", "enrollmentImages": ["enroll/s001-a.jpg", "enroll/s001-b.jpg"] }
      ]
    }
  ],
  "captures": [
    {
      "captureId": "cse-3a-mon-0900",
      "cohortId": "cse-3a",
      "conditions": {
        "distance": "far",
        "lighting": "dim",
        "eyewear": "some",
        "occlusion": "partial",
        "angle": "slight",
        "camera": "logitech-c920"
      },
      "images": [
        { "sequenceNumber": 1, "path": "captures/lect-01-1.jpg", "visibleStudentIds": ["s001", "s002"] },
        { "sequenceNumber": 2, "path": "captures/lect-01-2.jpg", "visibleStudentIds": ["s001", "s003"] }
      ]
    }
  ]
}
```

### Rules that make the numbers mean something

- **Enrolment images must never also be capture images.** Otherwise the
  benchmark measures memorisation, not recognition. The harness cannot detect
  this for you.
- **`visibleStudentIds` is per image, and means *actually visible*.** A
  student sitting behind someone else is not visible; counting them as a
  missed detection punishes the detector for physics.
- The capture-level truth (who should be marked present) is the **union**
  across images — that is what exercises the multi-photo deduplication
  requirement.
- `visibleStudentIds` may only name students enrolled in that cohort. The
  harness rejects anything else: a class-scoped search cannot be expected to
  find someone outside the class.
- Conditions are a **closed vocabulary** (`distance`, `lighting`, `eyewear`,
  `occlusion`, `angle`) plus a free-text `camera`. Free-text conditions would
  split "dim", "low-light" and "Dim" into three buckets of four samples each.

### Required coverage

The spec asks for these axes. The harness reports what you did **not** cover
rather than refusing to run, and the gap list is printed at the top of every
report so a partial dataset cannot be quoted as a complete one.

| Axis | Required |
| --- | --- |
| Cohort size | ~10, ~20, ~50, ~100 students (±20% tolerance) |
| Distance | near, mid, far |
| Lighting | bright, normal, dim, backlit, mixed |
| Eyewear | none, some, all |
| Occlusion | none, partial, heavy |
| Angle | frontal, slight, side |
| Camera | at least 2 distinct devices |
| Multi-photo | at least one capture using 2–3 images |

Check coverage before you spend a day shooting:

```bash
python -m bench --manifest my-benchmark/manifest.json --out /tmp/x --check-coverage-only
```

Exit code is non-zero while gaps remain.

---

## 2. Run it

```bash
cd services/face-ai
source .venv/bin/activate

# In-process: fastest, excludes HTTP from latency. Use for threshold work.
python -m bench \
  --manifest my-benchmark/manifest.json \
  --out runs/2026-09-15-pilot \
  --sweep --max-false-acceptance 0.005
```

Against a running service — the only mode whose latency numbers reflect what
a faculty member actually waits for:

```bash
FACE_MODEL_BACKEND=onnx FACE_MODEL_DIR=/models uvicorn app.main:app --port 8000 &
python -m bench --manifest my-benchmark/manifest.json --out runs/2026-09-15-http --http http://localhost:8000
```

Re-analyse an existing run at different thresholds — no model needed:

```bash
python -m bench --analyze runs/2026-09-15-pilot/raw.json --out runs/2026-09-15-strict \
  --present-min 0.78 --review-min 0.55
```

### Outputs

| File | Purpose |
| --- | --- |
| `raw.json` | Every similarity, detection and timing. Commit this. |
| `report.json` | Metrics + sweep, for dashboards and regression comparison. |
| `report.md` | The human-readable report, caveats first. |

---

## 3. Read the metrics

"Accuracy" means five different things in face recognition, so this harness
states its definitions:

| Metric | Definition | Why it matters |
| --- | --- | --- |
| **Detection rate** | detected face instances / expected face instances | Isolates the detector. A low number here means no threshold will save you. |
| **Accuracy** | correct decisions / **decided** students | Students routed to review are excluded from the denominator — deferring under uncertainty is designed behaviour, not an error. |
| **False acceptance** | absent students marked PRESENT / absent students | **The number that matters most.** Proxy attendance. Unrecoverable, because nobody reviews a confident Present. |
| **False rejection** | present students marked ABSENT / present students | Costly but self-correcting: the student complains. |
| **Review rate** | students routed to NEEDS_REVIEW | Not an error — a workload. Reviewing 60% of a class saves nobody any time. |
| **p50 / p95 latency** | per capture, wall clock | p95 is what the progress UI must survive. |

A metric shows `n/a` rather than `0.0%` when there was nothing to measure. A
0% false-acceptance rate computed over zero absent students is an absent
measurement, not a reassuring result.

**Always read the per-condition table, never just the overall row.** "94%
overall" routinely hides "61% in the back row under dim light", and the back
row is where attendance disputes come from.

---

## 4. Choose thresholds

`--sweep` re-scores the run across a grid of `presentMin` × `reviewMin` and
prints every operating point. `--max-false-acceptance` then picks the best
point **within a stated budget**:

- Among points meeting the budget, prefer the lowest false rejection, then
  the lowest review rate — fewest students wronged first, least faculty work
  second.
- If **no** point meets the budget, the report says so explicitly. That is
  the finding, not a harness failure: at this dataset and this model there is
  no setting safe to deploy.

There is no default budget worth trusting. `0.01` is a placeholder; the
institution (and its regulator) owns this number.

Apply the chosen point as **configuration, not code**:

```jsonc
// Institution.settings
{ "confidenceThresholds": { "presentMin": 0.78, "reviewMin": 0.55 } }
```

`ambiguityMargin` and `minDetectionConfidence` are engine-level policy
(`apps/web/src/modules/recognition-engine/types.ts`) and are swept as fixed
values here; vary them across runs if the sweep suggests the ambiguity rule is
firing too often or too rarely.

---

## 5. Record the result

A benchmark that is not written down was not repeatable. For each run, commit
`raw.json` and `report.md` under `runs/<date>-<label>/` and record:

- model name, version, **weights source and licence**
- dataset id, how many students, how many captures, consent basis
- the chosen operating point and the false-acceptance budget it was chosen
  against
- coverage gaps that remained

---

## Privacy

Benchmark datasets are biometric data about identifiable people.

- Obtain and record explicit consent before collecting classroom images.
- Keep dataset directories **out of the repository**. Commit reports and
  `raw.json` (similarity scores, not images or embeddings); never commit the
  images themselves.
- `raw.json` contains no face embeddings and no images — only scores keyed by
  student id — but it is still linkable data. Treat it accordingly.
- Delete source images on the schedule you promised participants, and put
  that date in the manifest `notes`.

---

## Performance benchmark (`perf.py`)

A separate tool for a separate question. `runner.py` asks *how often is it
right*; `perf.py` asks *how long does it take*. The second question does not
need a licensed model, because serialisation, request validation, transfer
and the candidate scan cost what they cost regardless of what is behind them.

```bash
cd services/face-ai

# In-process candidate scan only — no service required.
.venv/bin/python -m bench.perf --out bench/results

# Including the HTTP paths, against a running service.
FACE_AI_AUTH_TOKEN=<token> FACE_AI_REQUIRE_AUTH=true \
  .venv/bin/python -m uvicorn app.main:app --port 8099 &
.venv/bin/python -m bench.perf --http http://127.0.0.1:8099 \
  --token <token> --out bench/results
```

It measures three things: `score_candidates` at 10–5,000 candidates,
`POST /v1/detect-embed` with 1–3 classroom-sized images, and `POST /v1/match`
at cohort sizes 10/20/50/100. Output is `bench/results/perf.json`.

**Every number it produces is a floor, not a total.** With the `mock` backend
the per-face compute is a hash, so the timings capture overhead only — the
figure a real model's inference time is *added to*. The JSON carries that
disclaimer in a `disclaimer` field so it travels with the data. Quoting these
as recognition latency would be wrong.

---

## Current status

**Real-model calibration (2026-09-24):** `bench/calibrate_quality.py` was run
against the `opencv` backend (YuNet + SFace) on 61 public-domain adult portrait
pairs plus 89 single portraits, kept outside the repository. Results and
limits: [`docs/FACE_RECOGNITION_CALIBRATION.md`](../../../docs/FACE_RECOGNITION_CALIBRATION.md).
That model is **not production-approved**; the calibration does not change
that. The manifest-driven accuracy harness (`python -m bench`) still has no
consented classroom dataset to run on.

**Enrolment sharpness (2026-09-25):** `bench/calibrate_enrollment_sharpness.py`
calibrates the blur threshold the production backend
(`azure_detection_own_recognition`) enrols against, through the production
measure and the production recogniser, on 346 portraits kept outside the
repository with their Azure detections recorded alongside. Its criterion —
refuse 95% of captures blurred by 1.5 recogniser pixels, the first level that
measurably costs a template — gave 0.6525; the threshold is 0.65. Results and
limits: [`../docs/CALIBRATION.md`](../docs/CALIBRATION.md#enrolment-sharpness).

The mock backend is a deterministic hash stub: running the harness against it
produces ~100% false rejection, which is the correct result for a stub and
proves only that the harness works. See
[`../app/models/LICENSING.md`](../app/models/LICENSING.md).

**License verification required before production deployment.**
