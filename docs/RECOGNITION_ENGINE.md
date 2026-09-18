# Recognition Engine

How a classroom capture becomes an **advisory** attendance suggestion, and
where every decision that could mark the wrong student present is made.

Written in Phase 5. Companion documents:
[`FACE_AI_ARCHITECTURE.md`](FACE_AI_ARCHITECTURE.md) (layering and the model
boundary), [`services/face-ai/bench/README.md`](../services/face-ai/bench/README.md)
(how thresholds are meant to be chosen), and
[`services/face-ai/app/models/LICENSING.md`](../services/face-ai/app/models/LICENSING.md)
(why no model here is production-cleared yet).

> **Nothing in this document finalizes attendance.** The engine writes no
> database rows. It returns a summary that a faculty member confirms.

---

## 1. Where the code lives

| Concern | Location |
| --- | --- |
| Orchestration, scoring, policy, deduplication | `apps/web/src/modules/recognition-engine/service.ts` |
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
GET /v1/model-info            ← which model is running, right now
   │
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
cosine similarity vs every candidate → best + runner-up
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

Three properties of that chain are load-bearing:

**Authorization happens before any I/O.** Permission, institution and cohort
checks all run before the candidate pool is loaded and before a single image
reaches the AI service. A denied caller never causes an inference.

**One batched `detect-embed` call, not one per photo.** Detector and
recogniser sessions are shared across the capture's images. Per-image calls
would re-warm the pipeline on every frame.

**Model identity is resolved first.** The pool query is filtered by the
running model's `modelName` and composite `modelVersion`, so templates
enrolled under a different build are never compared against the current one.

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

Four knobs, all runtime configuration:

| Knob | Default | Source | Meaning |
| --- | --- | --- | --- |
| `presentMin` | `0.62` | `Institution.settings.confidenceThresholds` | At or above → MATCHED |
| `reviewMin` | `0.45` | `Institution.settings.confidenceThresholds` | At or above (and below `presentMin`) → UNCERTAIN |
| `ambiguityMargin` | `0.05` | engine policy / per-run override | Best must beat runner-up by this much |
| `minDetectionConfidence` | `0.5` | engine policy / per-run override | Below this, the face is not scored at all |

> **These defaults are plumbing, not findings.** No dataset has validated
> them. They exist so the pipeline runs end to end; a deployment must replace
> them with values measured by
> [the benchmark harness](../services/face-ai/bench/README.md).

### Classification

```
similarity >= presentMin                     → MATCHED
reviewMin <= similarity < presentMin         → UNCERTAIN
similarity < reviewMin                       → UNMATCHED
```

Bounds are inclusive at the lower edge, so a threshold of `0.62` means
"0.62 counts".

### The ambiguity rule

A face that scores `0.90` against Rahul and `0.88` against Priya is **not** a
confident Rahul. When best − runner-up < `ambiguityMargin`, the face is
downgraded from MATCHED to UNCERTAIN and flagged `wasAmbiguous`, even though
its top score cleared `presentMin`.

This is the near-collision case that a threshold alone cannot catch, and it
is where a single number silently becomes the wrong person. The rule only
fires where it can change an outcome: a near-tie that was already below
`presentMin` is not flagged, because it was already going to review.

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
student gets **one** row, at their **best** similarity, with `bestFaceId`
recording which frame produced it (`<sequenceNumber>:<faceIndex>`, e.g.
`2:0`) so review can jump straight to the winning frame. Ties break on
detection confidence.

Best-score-wins is the right rule because the photos are attempts at the same
observation, not independent evidence: the clearest look at a student is the
most informative one, and averaging a clear frame with a motion-blurred one
throws away the good measurement. It is also conservative in the direction
that matters — a student is not penalised for having been mid-blink in photo
1.

Consequences that are tested explicitly:

- Two images, one student → one aggregate row, not two.
- An ambiguity flag raised on any contributing face is carried forward.
- Faces that matched nobody contribute no rows at all.
- `unmatchedStudentIds` is computed from the pool minus the claimed set, so
  the three advisory buckets always partition the class exactly once.

---

## 6. Conflicts

Two faces in the same capture can claim the same student — a real
possibility with twins, siblings, or simply a hard frame.

The engine does not arbitrate. The higher-scoring face wins the student's
single row, and if the two faces were within the ambiguity margin of one
another's candidates, the student carries `wasAmbiguous` into review. The
losing face keeps its own `perFace` record with its own decision, so the
reviewer can see that two faces competed rather than being shown a tidy
answer that hides the collision.

Choosing blindly is the failure mode being avoided: a confident-looking
PRESENT produced by a coin flip is unreviewable, because nobody reviews a
confident Present.

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
must be interpretable without guessing which thresholds were in force.

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
| Engine unit tests | `npm test --workspace=web` | Cosine math, threshold bands, ambiguity, dedup, class scope, multi-image aggregation, leak check |
| face-ai unit tests | `pytest` in `services/face-ai` | Provider contract, matching, routes, benchmark harness |
| Integration | `./scripts/integration-test.sh` | Real HTTP against a live FastAPI process |
| Benchmark | `python -m bench` | Accuracy and threshold selection on a real dataset |

The integration script boots `services/face-ai` on port 8099 with the `mock`
backend, waits for `/v1/health`, and runs the web suite with
`FACE_AI_INTEGRATION=1`. Those tests skip by default so `npm test` stays
hermetic — no Python, no network.

What integration tests prove against the mock backend: the contract version
matches, embeddings are 512-d and unit length, `modelVersion` is composite,
faces carry their image's `sequenceNumber`, the same image embeds
deterministically across calls, a student in two photos is counted once, the
search stays class-scoped, and the summary carries no biometric material.

What they do **not** prove: that anybody is recognised correctly. The mock is
a hash stub. Accuracy is the benchmark's job, and the benchmark has not been
run against a real dataset.

---

## 11. Status and limitations

- **No production-cleared model exists in this repo.** `mock` is a hash stub;
  `onnx` is a scaffold with no weights and `commercialUse: "unclear"`. The
  service refuses to start with `FACE_AI_REQUIRE_PRODUCTION_MODEL=true` on
  either.
- **Thresholds are unvalidated defaults.** See §4.
- **No accuracy claim is supported by evidence.** No benchmark run against
  real classroom data exists.
- **Attendance is never finalized by the engine.** Writing `AttendanceRecord`
  rows from an advisory summary is a later phase.
- Occlusion, extreme angles and back-row distance are known-hard and
  unmeasured here; the benchmark manifest has slots for exactly those
  conditions.

**License verification required before production deployment.**
