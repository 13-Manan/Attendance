# Recognition Engine

How a classroom capture becomes an **advisory** attendance suggestion, and
where every decision that could mark the wrong student present is made.

Written in Phase 5, and revised when production gained a real recogniser.
Companion documents:
[`FACE_AI_ARCHITECTURE.md`](FACE_AI_ARCHITECTURE.md) (layering and the model
boundary), [`FACE_ASSIGNMENT.md`](FACE_ASSIGNMENT.md) (one student, one face —
the assignment step in §4, and why it is greedy rather than Hungarian),
[`services/face-ai/docs/RECOGNITION.md`](../services/face-ai/docs/RECOGNITION.md)
(the other half of the pipeline: Azure detects, face-ai recognises),
[`services/face-ai/docs/CALIBRATION.md`](../services/face-ai/docs/CALIBRATION.md)
(the measurements the thresholds in §4 actually rest on),
[`services/face-ai/bench/README.md`](../services/face-ai/bench/README.md)
(the harness), and
[`services/face-ai/app/models/LICENSING.md`](../services/face-ai/app/models/LICENSING.md)
(how a backend gets cleared for production, and which one is).

> **Nothing in this document finalizes attendance.** The engine writes no
> database rows. It returns a summary that a faculty member confirms.

---

## 1. Where the code lives

| Concern | Location |
| --- | --- |
| Orchestration, scoring, assignment, policy, deduplication | `apps/web/src/modules/recognition-engine/service.ts` |
| Reading one backend's scores on the product's scale | `apps/web/src/modules/recognition-engine/calibration.ts` |
| Result and policy types | `apps/web/src/modules/recognition-engine/types.ts` |
| Server action entry point | `apps/web/src/modules/recognition-engine/actions.ts` |
| Class-scoped pgvector candidate lookup | `apps/web/src/modules/recognition-results/repository.ts` |
| AI ↔ attendance vocabulary bridge | `apps/web/src/modules/recognition-results/service.ts` |
| Detection, embedding, quality | `services/face-ai/` (`/v1/detect-embed`) |
| Wire contract | `packages/shared-types/src/face-ai-contract.ts` |

Heavy inference never runs inside Next.js. The engine is orchestration and
arithmetic; the model is a separate Python process behind one HTTP contract
(ADR-0002).

---

## 2. The pipeline

```
capture wizard (1–3 photos, browser)
   │  base64 images, never persisted
   ▼
runRecognitionAction  ── requirePermission("attendanceSession.capture")
   │                     requireSameInstitution(session)
   │                     requireCohortAccess(cohort)
   ▼
GET /v1/model-info            ← which model is running, right now, and the
   │                             calibration it publishes for its scores
   ▼
class-scoped candidate pool   ← pgvector; subject enrollment if the session
   │                             has one, else the cohort; always filtered
   │                             by modelName + modelVersion
   │
   ▼
POST /v1/detect-embed         ← ONE batched call for all 1–3 images
   │
   ├── drop faces below minDetectionConfidence  (dropReason recorded)
   │
   ▼
cosine similarity vs every candidate
   │
   ▼
calibrate onto the product's scale  ← before any threshold sees a number
   │
   ▼
best + runner-up (a different student), per face
   │
   ▼
one student per face, within each photograph   (FACE_ASSIGNMENT.md)
   │
   ▼
confidence policy → MATCHED | UNCERTAIN | UNMATCHED
   │
   ▼
cross-image deduplication by studentId (best score wins)
   │
   ▼
advisory per student → PRESENT | NEEDS_REVIEW | ABSENT
```

Four properties of that chain are load-bearing:

**Authorization happens before any I/O.** Permission, institution and cohort
checks all run before the candidate pool is loaded and before a single image
reaches the AI service. A denied caller never causes an inference.

**One batched `detect-embed` call, not one per photo.** Detector and
recogniser sessions are shared across the capture's images. Per-image calls
would re-warm the pipeline on every frame.

**Model identity is resolved first.** The pool query is filtered by the
running model's `modelName` and composite `modelVersion`, so templates
enrolled under a different build are never compared against the current one.

**Scores are calibrated before anything looks at them.** `/v1/model-info` is
also where the running backend declares how its raw similarities map onto the
product's scale, and that map is applied at the single point where cosines are
produced — so the thresholds, the assignment, the aggregate and the number a
teacher is shown are all the same kind of number. §4 is where that matters.

---

## 3. Class-scoped search

The candidate pool is **the class, never the institution**. A 50-student
lecture compares against 50 templates, not against 4,000.

This is a correctness requirement before it is a performance one. False
acceptance scales with pool size: at any fixed threshold, the more strangers
a face is compared against, the likelier one of them scores above it. A
campus-wide search would mark students present in lectures they have never
attended.

Scoping is enforced in the repository query, in SQL — not by filtering a
wider result set in application code, which would pull other classes' vectors
into the process in the meantime.

Two scopes exist, and the summary reports which one was used
(`candidateScope`):

| Session | Loader | Pool |
| --- | --- | --- |
| No `cohortSubjectId` (school class) | `findCandidateEmbeddingsWithVectorsForCohort` | Students with an `ACTIVE` cohort `Enrollment` |
| Has `cohortSubjectId` (college subject) | `findCandidateEmbeddingsWithVectorsForCohortSubject` | Students with a `StudentSubjectEnrollment` for that subject **and** an `ACTIVE` cohort enrollment |

The subject loader keeps the cohort-enrollment join deliberately: a student
who left the class but whose elective row was never cleaned up must not
reappear in a classroom search.

**Fallback.** Per-student subject enrollment is optional in the data model —
a non-elective subject can legitimately have no `StudentSubjectEnrollment`
rows. If the subject pool comes back empty, the engine falls back to the
cohort pool and reports `candidateScope: "cohort"`. Treating "no subject
enrollment" as "nobody to compare against" would mark an entire class absent,
which is far worse than searching a slightly wider population. The fallback
is reported, never hidden.

Templates in the pool whose `modelVersion` does not match are **not silently
dropped**. They are counted into `skippedIncompatibleCandidates` and surfaced
in the UI, because "we could not compare this student" must never render as
"this student was absent".

---

## 4. Confidence policy

### The scale these thresholds are written against

A threshold means nothing without the scale it is on, and recognisers do not
agree on one. The recogniser production runs — dlib's ResNet, behind
`azure_detection_own_recognition` — puts **most pairs of different people
above 0.85**, and a raw cosine of `0.94`, which would sail past `presentMin`
read naively, is two different people. A model trained with a margin loss puts
strangers near zero instead. Compare a raw dlib score against `0.62` directly
and every stranger in the room is marked present.

Institutions configure `presentMin` and `reviewMin` without being told which
recogniser is deployed, and they should not have to be told. So the backend
publishes a **measured map** onto the product's scale — `calibration` on
`GET /v1/model-info`: piecewise-linear knots, currently raw `0.930 → 0.45` and
raw `0.955 → 0.62`, plus a `rawAmbiguityMargin` of `0.01` — and
`recognition-engine/calibration.ts` applies it at the single point where
cosines are produced. **Every score in the rest of this document is on the
product's scale, after that map.** The raw cosine is carried alongside it, so a
result stays explainable after a recalibration and the raw margin below can be
enforced; nothing compares the raw number to `presentMin`.

Two properties make that safe to build on:

- **The map is monotone.** Its knots span raw −1 to 1 and increase strictly in
  both coordinates, so calibration can never reorder two candidates. It
  changes which side of a threshold a score falls on, never who is in front.
- **It fails closed.** A production backend that stores embeddings and
  publishes *no* calibration is **refused** rather than read raw: the run
  stops and nothing is marked. "No map" and "the identity map" are different
  claims, and guessing the second when the service meant the first is how a
  classroom gets marked present. A backend whose raw scale genuinely is the
  product's says so by publishing the identity map. Development backends
  without one are still read raw — requiring a calibration from `mock` would
  break every local checkout for no safety gained.

The arithmetic exists twice, in `calibration.ts` and in
`services/face-ai/app/matching.py`, with a test asserting both produce
identical floating-point values at 23 points including every knot: a
one-ulp disagreement at a knot puts a student on the other side of a
threshold.

### The knobs

Four are runtime configuration; the fifth comes from the backend, because only
the backend knows its own scale:

| Knob | Default | Source | Meaning |
| --- | --- | --- | --- |
| `presentMin` | `0.62` | `Institution.settings.confidenceThresholds` | At or above → MATCHED |
| `reviewMin` | `0.45` | `Institution.settings.confidenceThresholds` | At or above (and below `presentMin`) → UNCERTAIN |
| `ambiguityMargin` | `0.05` | engine policy / per-run override | Best must beat runner-up by this much, in calibrated points |
| `minDetectionConfidence` | `0.5` | engine policy / per-run override | Below this, the face is not scored at all |
| `calibration.rawAmbiguityMargin` | `0.01` | the running backend, via `/v1/model-info` | Best must *also* beat runner-up by this much on the backend's own raw scale |

> **`presentMin` and `reviewMin` are institution policy. The map underneath
> them is a measurement, and it is provisional.** The two thresholds are not
> changing; what was measured is what a raw score from this recogniser means
> against them. That measurement was taken on public-domain **adult**
> portraits — never on classroom photographs, never on children, and never on
> a photograph from this product's own database. An institution deploying this
> should expect to re-measure against its own population before trusting the
> present threshold unattended.
> [`CALIBRATION.md`](../services/face-ai/docs/CALIBRATION.md) states exactly
> what was and was not tested, including a section on what it does **not**
> establish. `ambiguityMargin` and `minDetectionConfidence` remain engine
> defaults that no dataset has validated.

### Classification

```
calibrated >= presentMin                     → MATCHED
reviewMin <= calibrated < presentMin         → UNCERTAIN
calibrated < reviewMin                       → UNMATCHED
```

Bounds are inclusive at the lower edge, so a threshold of `0.62` means
"0.62 counts". A raw score sitting exactly on a knot reads as exactly that
knot's calibrated value, which is what keeps that sentence true through the
map.

### The ambiguity rule

A face that scores `0.90` against Rahul and `0.88` against Priya is **not** a
confident Rahul. When best − runner-up < `ambiguityMargin`, the face is
downgraded from MATCHED to UNCERTAIN and flagged `wasAmbiguous`, even though
its top score cleared `presentMin`.

This is the near-collision case that a threshold alone cannot catch, and it
is where a single number silently becomes the wrong person. The rule only
fires where it can change an outcome: a near-tie that was already below
`presentMin` is not flagged, because it was already going to review.

**Two margins, and either one is enough to demote.** The institution's margin
is in calibrated points, which is what an administrator can reason about. The
backend's `rawAmbiguityMargin` is in raw points, because the map stretches the
top of the scale: two students `0.002` raw apart are the same face to the
recogniser however far apart their calibrated scores end up. The measurement
behind that number is blunt — in the evaluation corpus there exists a genuine
pair whose correct match beat the wrong one by two ten-thousandths — so a face
whose top two candidates are within `0.01` raw goes to a teacher regardless of
where calibration put them.

**The runner-up is always a different student.** This is load-bearing, and it
was wrong until Phase 4. A student may hold up to `MAX_SAMPLES_PER_STUDENT`
(5) enrolled templates, and the enrollment UI encourages several because
varied lighting recognises somebody more reliably. Those samples are all of
the same face, so they score within a hair of one another — and while the
scan ranked *every template* against every other, the runner-up for a
well-enrolled student was almost always their own second photograph. The
margin was tiny, the rule fired, and the student was demoted to NEEDS_REVIEW.

The effect was that the better a student enrolled, the more certainly they
were sent to manual review: multi-sample enrollment made recognition worse.
A student's own templates now compete to represent that student, and only the
best score from a *different* student can be the runner-up. The rule still
catches genuine look-alikes — that case is tested with two students holding
two samples each.

### One student, one face

Scoring each face against the pool independently and giving every face its own
best match hands the same student to two faces, because two faces really can
resemble one person — siblings, cousins, or a recogniser having a bad day with
a turned head. So the faces **within one photograph** are matched to students
jointly, by `assignFacesOneToOne`: a student may be given at most one face per
image. A face that lost its top choice and took its second is recorded as
`reassigned` and can never be a confident match; a face with nothing left
above the review floor is assigned nobody and becomes an unknown face, never a
guess. Any student who was the top choice of two or more faces is `contested`
and goes to a teacher however high the winning score was.

The matching is greedy, deliberately, rather than the textbook Hungarian
assignment: a sum of similarities is not a likelihood, and maximising it can
reach its optimum by giving a face to somebody who was not its best match at
all. [`FACE_ASSIGNMENT.md`](FACE_ASSIGNMENT.md) works that through with the
example, and states what the assignment deliberately does not do.

Assignment is within one image, because "two faces in one photograph are two
different people" is only true within one photograph. Merging the evidence
across the round's photographs is §5, and it has the opposite rule.

### Low-confidence detections

A face below `minDetectionConfidence` — a poster on the back wall, a blurred
corner — is recorded with `dropReason: "low_detection_confidence"` and then
ignored. It contributes no match and, critically, **cannot push anyone into
NEEDS_REVIEW**. Phantom faces otherwise manufacture review workload out of
furniture.

### Vocabulary mapping

| AI status | Advisory result |
| --- | --- |
| `MATCHED` | `PRESENT` |
| `UNCERTAIN` | `NEEDS_REVIEW` |
| `UNMATCHED` | `ABSENT` |

`UNCERTAIN` never becomes `PRESENT`. The engine has exactly one way to
express doubt and it always routes to a human.

---

## 5. Deduplication across photos

A capture is 1–3 photos of the same room. Rahul is very likely in all of
them.

Deduplication is by `studentId` across every face of every image: each
student gets **one** row. The rule is written out below rather than left as
"whatever the code does", because "take the maximum" is not a policy — it is
the absence of one, and it silently rewards the single most over-confident
frame.

### The aggregation policy

1. **Collect every observation.** One per face that named this student, each
   carrying capture number, face index, similarity, detection confidence and
   the face-level verdict. All of them are kept — `StudentRecognitionAggregate
   .observations` — so the policy can reason about disagreement instead of
   discarding it, and so a reviewer can be told "photo 1 face 3 at 71%,
   photo 2 face 0 at 68%".
2. **Pick a representative.** Highest similarity; ties break on detection
   confidence, then on the lowest capture number. Fully deterministic: the
   same observations always produce the same register, whatever order the
   detector returned faces in.
3. **Classify** the representative's similarity — calibrated, like every
   other score in this document — through the same `presentMin` / `reviewMin`
   bands every other decision uses.
4. **Apply demotions.** Each can only make the answer more cautious:
   - `ambiguous_face` — the representative's runner-up (a different student)
     was inside the margin, either margin.
   - `duplicate_within_capture` — see §6.
   - `low_quality_face` — the winning face failed a quality check that face-ai
     reported. It is still matched; it is never matched above review.
   - `reassigned_face` — the winning face's own best candidate was somebody
     else, claimed by a stronger face, and this student was its second choice
     (§4).
5. **Never promote.** A student whose representative observation is UNCERTAIN
   stays UNCERTAIN no matter how many other captures agreed. Agreement
   between two uncertain looks is not certainty. There is no branch in
   `aggregateByStudent` that raises a status; this is structural, not a
   convention.

Taking the maximum *across captures* is deliberate and is not a demotion
case: the photos are attempts at the same observation, not independent
evidence. The clearest look is the most informative one, averaging a sharp
frame with a motion-blurred one throws away the good measurement, and a
student is not penalised for having been mid-blink in photo 1 — rescuing them
is exactly what the second photo is for.

Consequences that are tested explicitly:

- Two images, one student → one aggregate row, not two.
- An ambiguity flag raised on the winning face is carried forward.
- Faces that matched nobody contribute no rows at all.
- `unmatchedStudentIds` is computed from the pool minus the claimed set, so
  the three advisory buckets always partition the class exactly once.

---

## 6. Conflicts

Two faces **in the same capture** can claim the same student.

A person appears once in a still photograph. Two hits therefore mean the
recogniser is confusing people, not that the student is especially present —
so the student is demoted to UNCERTAIN with `duplicate_within_capture`, and
the review board explains it in those words. Previously the higher-scoring
face simply won and the collision was visible only to somebody reading
`perFace`; a confident-looking PRESENT produced by a coin flip is
unreviewable, because nobody reviews a confident Present.

Since the one-to-one assignment landed (§4), the student cannot actually hold
two faces in one capture: the stronger face keeps them and is flagged
`contested`, and the other face is either reassigned to its next candidate or
left unknown. The demotion fires on that flag as readily as on two raw
observations, so a result assembled without the assignment — an older run, a
different path — still demotes. Neither the flag nor the count is the rule;
"two faces claimed this person" is.

The losing face keeps its own `perFace` record with its own decision and its
own demotions, so the collision is still legible rather than being tidied
away.

The *cross-capture* case is the opposite signal and is left alone: the same
student in photo 1 and photo 2 is one person photographed twice, which is the
normal and intended case.

---

## 7. Result format

Per detected face (`FaceRecognitionResult`):

```ts
{
  detectedFaceId: "2:0",        // <sequenceNumber>:<index>, never a person id
  imageSequenceNumber: 2,
  candidateStudentId: "stu-1" | null,
  similarityScore: 0.83 | null,
  runnerUpSimilarity: 0.41 | null,
  detectionConfidence: 0.97,
  qualityScore: 0.82 | null,
  decision: "MATCHED" | "UNCERTAIN" | "UNMATCHED",
  dropReason: "low_detection_confidence" | null
}
```

Per student, after deduplication (`StudentRecognitionAggregate`):

```ts
{
  studentId, bestSimilarity, bestDetectionConfidence, bestQualityScore,
  bestFaceId, advisoryResult, matchStatus, wasAmbiguous
}
```

Plus run-level provenance: `modelName`, `modelVersion`, `productionEligible`,
the `policy` actually applied, `candidateScope`, `candidatePoolSize`,
`skippedIncompatibleCandidates`, `detectedFacesTotal`, `scoredFacesTotal`,
`unmatchedStudentIds`.

Storing the policy *with* the result matters: a summary read six months later
must be interpretable without guessing which thresholds were in force. The
policy carries the backend's calibration, including its `id` (currently
`dlib-resnet-v1.azure-d03.2026-09-24`), for the same reason one step further
down — a recalibration changes what a stored score *means*, and that has to be
visible in the audit trail rather than silently rewriting history.

---

## 8. What the browser is allowed to see

**No embeddings leave the server.** Neither the classroom face vectors nor
the enrolled templates appear in the engine's output types — not filtered out
at serialization time, but structurally absent from `FaceRecognitionResult`
and `StudentRecognitionAggregate`. A future field cannot leak a vector by
accident because there is nowhere to put one.

What does reach the browser: similarity scores, detection/quality scores,
decisions, student ids the faculty member is already authorized to see, and
model provenance. Enough to review a decision; not enough to reconstruct a
biometric.

Classroom images are processed and discarded. They are not written to disk by
the engine and not retained after the run (Phase 4 capture privacy).

A regression test asserts that a serialized run summary contains neither the
string `embedding` nor any component of a fixture vector.

---

## 9. Failure behaviour

| Failure | Behaviour |
| --- | --- |
| Session missing | `session_not_found` before any AI call |
| Caller lacks permission / wrong institution / no cohort access | Throws before pool load and before any image is sent |
| face-ai unreachable or returns non-2xx | Error propagates; the capture wizard shows it and falls back to roll-call |
| Malformed request rejected by face-ai | Surfaces as an error — never as "no faces detected" |
| An Azure outage behind the production backend | face-ai answers `503`; it propagates as an error and never as "no faces found" |
| A production embedding backend publishes no calibration, or an unusable one | `FaceCalibrationError` before any score is read; the run stops and nobody is marked (§4) |
| Zero candidates in the pool | Runs, returns no matches, `candidatePoolSize: 0` |
| Corrupt/zero-length template | Scores 0 rather than `NaN`; one bad row cannot fail the class |
| Dimension mismatch | Candidate skipped and counted, not scored as 0 |

The capture wizard treats recognition as **fail-soft**: a recognition error
never blocks the session summary, because the photos were still taken and the
faculty member must still be able to finish by roll-call.

---

## 10. Testing

| Suite | Command | Covers |
| --- | --- | --- |
| Engine unit tests | `npm test --workspace=web` | Cosine math, threshold bands, ambiguity, multi-template ranking, aggregation policy, class scope, multi-image dedup, leak check |
| Camera unit tests | `npm test --workspace=web` | State machine, failure classification, capture geometry, frame validation, source contract — no webcam |
| Classroom scenarios | `npm test --workspace=web` | The phase's enumerated scenario list end to end, against fixtures |
| face-ai unit tests | `pytest` in `services/face-ai` | Provider contract, matching, routes, benchmark harness |
| Integration | `./scripts/integration-test.sh` | Real HTTP against a live FastAPI process |
| Benchmark | `python -m bench` | Accuracy and threshold selection on a real dataset |

The integration script boots `services/face-ai` on port 8099 with the `mock`
backend, waits for `/v1/health`, and runs the web suite with
`FACE_AI_INTEGRATION=1`. Those tests skip by default so `npm test` stays
hermetic — no Python, no network.

What integration tests prove against the mock backend: the contract version
matches, embeddings are 128-d and unit length, `modelVersion` is composite,
faces carry their image's `sequenceNumber`, the same image embeds
deterministically across calls, a student in two photos is counted once, the
search stays class-scoped, and the summary carries no biometric material.

What they do **not** prove: that anybody is recognised correctly. The mock is
a hash stub. Whether the production recogniser separates one person from
another was measured separately, outside this repository, on public-domain
adult portraits —
[`CALIBRATION.md`](../services/face-ai/docs/CALIBRATION.md) — and that
evaluation is what the calibration knots come from. It is **not** a classroom
benchmark: no classroom photograph and no child's photograph has been measured
against this pipeline.

---

## 11. Status and limitations

- **A production-cleared recogniser now runs.**
  `azure_detection_own_recognition`: Azure AI Face for detection and landmarks
  only, and dlib's `dlib_face_recognition_resnet_model_v1` in face-ai's own
  process for the part that decides who somebody is. The weights are public
  domain, SHA-256 pinned and verified at startup, so it reports
  `commercialUse: "permitted"` and `productionEligible: true`. Nothing in it
  waits on Microsoft's Limited Access approval, because Identify is never
  called. One licence question — about half the weights' training images came
  from two non-commercially licensed research corpora — is **referred to legal
  review and open**; see
  [`MODEL_LICENSES.md`](../services/face-ai/docs/MODEL_LICENSES.md). `opencv`
  is still `unclear` and still refused in production; `mock` remains a hash
  stub; `onnx` remains a weightless scaffold.
- **Embeddings are 128-d**, SFace's native width since Phase 5 and the dlib
  recogniser's width as well. Any template enrolled before that migration is a
  different width and is skipped and counted rather than compared — see §3.
  Templates are additionally filtered by `modelVersion`, now
  `dlib-models-2a61575+pp1+al1.detection_03`, so a template written by an
  earlier build is counted as incompatible rather than compared.
- **The thresholds are institution policy; the calibration under them is
  provisional.** It was measured on public-domain adult portraits, not on
  classroom photographs and not on children. `ambiguityMargin` and
  `minDetectionConfidence` are still unvalidated engine defaults. See §4.
- **No accuracy claim is supported by classroom evidence.** What exists is an
  evaluation on adult portraits with synthetic degradation, whose own document
  lists at length what it does not establish. No benchmark run against real
  classroom data exists, and none against children.
- **Attendance is never finalized by the engine.** It returns an advisory
  summary and writes nothing; `modules/attendance-review` turns that into a
  register, and only a faculty member closes one.
- **Camera hardware is not covered by any automated test.** The browser path
  calls `navigator.mediaDevices.getUserMedia` and is exercised only by hand.
  Everything around it — states, failures, lifecycle, payload bounds — runs
  against `fixtureCameraSource`, which proves the software and says nothing
  about a lens. See §12.
- Occlusion, extreme angles and back-row distance are known-hard. Occlusion
  and small faces were measured synthetically for the production recogniser
  and the result is the intended shape — as conditions worsen the system stops
  claiming rather than starts guessing, and at 36 pixels nothing is
  auto-marked present at all — but that is portraits degraded in software, not
  a back row. See
  [`CALIBRATION.md`](../services/face-ai/docs/CALIBRATION.md).

**The recogniser's licence is verified and recorded
([`LICENSING.md`](../services/face-ai/app/models/LICENSING.md)); the question
of whether two non-commercially licensed training corpora reach the trained
weights is referred to legal review and is not settled.**

---

## 12. The camera

The classroom camera lives in three files, split so that the only part that
cannot be tested is as small as possible:

| File | Role | Tested |
| --- | --- | --- |
| `modules/attendance-capture/camera.ts` | State machine, failure classification, capture geometry, frame validation. Pure, DOM-free. | Fully |
| `modules/attendance-capture/camera-source.ts` | `CameraSource`: the one place `getUserMedia` is called, plus a deterministic fixture. | Fixture fully; browser path not at all |
| `modules/attendance-capture/use-classroom-camera.ts` | Binds the two to React: stream handle, `<video>` ref, lifecycle effects. | Through the state machine |

`browserCameraSource` is the production implementation and is what every
deployed build uses. The seam exists so the wizard, the contracts and the
lifecycle guarantees can be asserted in CI, where no webcam exists; it does
not replace, weaken or route around the real capture path.

`fixtureCameraSource` is reachable only when `NEXT_PUBLIC_ENABLE_FIXTURE_
CAMERA=true`, which no deployment sets — the deploy workflow passes no such
build argument, so a production bundle has `false` compiled in and the
fixture is unreachable from it. When it *is* on, the capture page renders a
banner saying so.

### Lifecycle guarantees

The stream is released on unmount, on tab-hidden (`visibilitychange`), when
the wizard leaves the camera step, and when an `open()` resolves after the
user already pressed stop — the race a slow permission prompt creates. Two
concurrent `getUserMedia` calls are prevented in two places: the reducer
ignores a second `start` from `starting`/`ready`/`capturing`, and an
`openingRef` guard covers the async half.

### Capture geometry

Classroom captures cap at **1920px** on the long edge at **JPEG q0.82**,
against enrollment's 1280px at q0.92. The subject is different: an enrollment
photograph is one face filling the frame, a classroom photograph is thirty
faces across a room, and at 1280 the back row lands at roughly forty pixels —
at or below what a detector will find. Capping at all matters because a 4K
webcam otherwise hands over a frame several times the payload bound.
