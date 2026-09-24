import type {
  FaceQualityReason,
  IdentificationStatus,
  MatchStatus,
  RejectedFaceReason,
  ScoreCalibration,
} from "@attendance/shared-types";
import type { ConfidenceThresholds } from "@/modules/institutions/types";
import type { AttendanceResult } from "@/modules/recognition-results/types";

/**
 * Phase 5 recognition-engine value types.
 *
 * Kept deliberately separate from `modules/recognition-results` (which owns
 * the AI-vocabulary ↔ attendance-vocabulary bridge and the pgvector lookup)
 * so the orchestration types can evolve without churning either boundary.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The full set of tuning knobs the confidence engine applies, on top of
 * the raw `presentMin` / `reviewMin` cosine thresholds. Everything here is
 * runtime configuration — nothing is hardcoded so real-world benchmarking
 * (see services/face-ai/bench/) can adjust them without redeploying code.
 */
export interface RecognitionPolicy extends ConfidenceThresholds {
  /**
   * If the best candidate for a detected face is only this much (cosine
   * similarity) above the second-best candidate, we downgrade the face to
   * UNCERTAIN even if its top score is above `presentMin`. Two students'
   * templates being nearly indistinguishable for one face is the classic
   * near-collision that must NOT auto-mark a "confident" match.
   *
   * Default 0.05 is the plumbing default — a real deployment must tune it
   * against measured false-acceptance rates.
   */
  ambiguityMargin: number;
  /**
   * A face whose detector confidence is below this floor is treated as a
   * failed detection: it does not contribute a match and does not push a
   * student into NEEDS_REVIEW. Prevents "phantom faces" (background posters,
   * low-quality corners) from creating spurious review noise.
   */
  minDetectionConfidence: number;
  /**
   * How to read the running backend's raw similarity scores on the scale the
   * two thresholds above are written against. Supplied from
   * `GET /v1/model-info` by `runRecognitionForSession`; see
   * `recognition-engine/calibration.ts`.
   *
   * Optional because most policies are built by tests and benchmarks against
   * a backend whose raw scale IS the product's. Omitted means exactly that —
   * and a *production* backend that publishes none is refused at the
   * model-info boundary rather than quietly read raw.
   */
  calibration?: ScoreCalibration | null;
}

export const DEFAULT_AMBIGUITY_MARGIN = 0.05;
export const DEFAULT_MIN_DETECTION_CONFIDENCE = 0.5;

// ---------------------------------------------------------------------------
// Per-face result (Phase 5 spec shape)
// ---------------------------------------------------------------------------

/**
 * One row per detected face × best candidate, matching the shape called
 * for in the Phase 5 spec. `candidateStudentId` is null when no candidate
 * crossed the review floor.
 *
 * IMPORTANT: this type has NO field for the raw embedding vector — neither
 * the classroom face's embedding nor the candidate template. Structural
 * guarantee that recognition output cannot leak biometric material to a
 * browser via this shape.
 */
export interface FaceRecognitionResult {
  /** Composite id: `<sequenceNumber>:<faceId>` — stable within one run,
   * never a person identifier. */
  detectedFaceId: string;
  imageSequenceNumber: 1 | 2 | 3;
  /** Position of this face within its own image, 0-based. Carried
   * separately from `detectedFaceId` so provenance can be read without
   * parsing a composite string. */
  faceIndex: number;
  candidateStudentId: string | null;
  /**
   * Which stored template produced the winning score. Kept so an
   * AttendanceRecord can point at the exact `FaceEmbedding` behind its
   * advisory — the column has existed since the first migration and was
   * never populated, which left "why was this student marked present?"
   * answerable only down to the student, not the template.
   */
  candidateEmbeddingId: string | null;
  similarityScore: number | null;
  /**
   * The best score from a candidate belonging to a DIFFERENT student, when
   * one exists — the input to the ambiguity margin rule.
   *
   * "Different student" is the whole point. A student may hold up to
   * `MAX_SAMPLES_PER_STUDENT` templates, so their own second-best sample is
   * always a near-tie with their best; comparing against that would fire the
   * ambiguity rule on every well-enrolled student. See
   * `scoreFaceAgainstCandidates`.
   */
  runnerUpSimilarity: number | null;
  /** Who that runner-up was. Diagnostic only — never rendered to a class. */
  runnerUpStudentId: string | null;
  detectionConfidence: number;
  qualityScore: number | null;
  decision: MatchStatus;
  /** When the face was dropped before comparison (e.g. below
   * `minDetectionConfidence`). Diagnostic — the UI can group these. */
  dropReason: "low_detection_confidence" | "identification_unavailable" | null;
  /** Group-photo quality checks this face failed, as face-ai reported them.
   * A flagged face can still be matched, but never above UNCERTAIN. */
  qualityFlags: FaceQualityReason[];
  /** Shorter side of the face box in pixels, when face-ai reported it. */
  faceSize: number | null;
  /** Every rule that made this face's decision more cautious than its raw
   * similarity. Empty when the similarity was taken at face value. */
  demotions: FaceDemotion[];
  /** Another face in the SAME capture had this face's student as its own best
   * candidate above the review floor. The student was given to the stronger
   * face (this one), but one person is not in one photograph twice, so the
   * student still goes to review. */
  contested: boolean;
  /** Scored, but attributed to nobody: no enrolled student came within the
   * review floor, or every student it resembled was already claimed by a
   * stronger face in the same photo. Never assigned to a student. */
  unknown: boolean;
}

/**
 * Why one face's decision was made more cautious.
 *
 *  - `ambiguous`   — a different student scored within the ambiguity margin.
 *  - `low_quality` — face-ai flagged the face (too small, blurred, dark,
 *                    turned away…). A poor face can resemble anybody.
 *  - `reassigned`  — the face's best candidate was claimed by a stronger face
 *                    in the same photo, so it was given its next-best free
 *                    candidate. A second choice is never a confident one.
 */
export type FaceDemotion = "ambiguous" | "low_quality" | "reassigned";

// ---------------------------------------------------------------------------
// Per-observation provenance
// ---------------------------------------------------------------------------

/**
 * One detected face that named a given student as its best candidate.
 *
 * A student can be observed several times in one run — once per capture, and
 * (wrongly) more than once within a single capture. Keeping every observation
 * rather than only the winner is what lets the aggregation policy below reason
 * about *disagreement* instead of silently taking a maximum, and what lets a
 * reviewer be told "photo 2, second face, 71%" rather than just "71%".
 */
export interface StudentObservation {
  captureNumber: 1 | 2 | 3;
  faceIndex: number;
  detectedFaceId: string;
  similarity: number;
  detectionConfidence: number;
  qualityScore: number | null;
  /** Face-level decision before aggregation. */
  matchStatus: MatchStatus;
  /** True when this face's runner-up (a different student) was inside the
   * ambiguity margin. */
  wasAmbiguous: boolean;
  candidateEmbeddingId: string | null;
  /** Face-level demotions carried from `FaceRecognitionResult`. */
  demotions: FaceDemotion[];
  qualityFlags: FaceQualityReason[];
  faceSize: number | null;
  /** See `FaceRecognitionResult.contested`. */
  contested: boolean;
}

// ---------------------------------------------------------------------------
// Per-student aggregate (post-deduplication)
// ---------------------------------------------------------------------------

/**
 * Why an aggregate ended up more cautious than its best observation was.
 *
 * Every value here describes a *demotion*. There is deliberately no code for
 * a promotion, because the aggregation policy has none: no combination of
 * observations can lift a student above what their own best face earned.
 */
export type AggregationDowngrade =
  /** The winning face's runner-up (a different student) was inside the
   * ambiguity margin. */
  | "ambiguous_face"
  /** Two or more distinct faces in the SAME capture both named this student.
   * One person is not in one photograph twice; that is the detector or the
   * recogniser confusing people, and it must not read as confident presence. */
  | "duplicate_within_capture"
  /** The winning face failed a quality check. */
  | "low_quality_face"
  /** The winning face's own best candidate was somebody else, claimed by a
   * stronger face; this student was its second choice. */
  | "reassigned_face";

/**
 * One row per enrolled candidate student after cross-image deduplication.
 * "Rahul appears in image 1 and image 2 → Rahul counts once" is enforced
 * here.
 *
 * ## The aggregation policy, in full
 *
 * Deliberately written down rather than left as whatever the code happens to
 * do, because "pick the highest score" is not a policy — it is the absence of
 * one, and it silently rewards the single most over-confident frame.
 *
 *  1. **Representative observation.** Among this student's observations, take
 *     the highest similarity. Ties break on detection confidence, then on the
 *     lowest capture number — so the result is a deterministic function of the
 *     observations, not of the order they arrived in.
 *  2. **Classify** that representative's raw similarity through the same
 *     `presentMin` / `reviewMin` bands every other decision uses.
 *  3. **Apply demotions** (`AggregationDowngrade`). Each can only make the
 *     outcome more cautious.
 *  4. **Never promote.** A student whose representative observation is
 *     UNCERTAIN stays UNCERTAIN no matter how many other captures agreed —
 *     agreement between two uncertain looks is not certainty.
 *
 * Taking the maximum across *captures* is intentional and is not a demotion
 * case: a student obscured in photo 1 and clearly visible in photo 2 is
 * present, and the second photo exists precisely to rescue them. Repetition
 * within a *single* capture is the opposite signal, and rule 3 handles it.
 */
export interface StudentRecognitionAggregate {
  studentId: string;
  bestSimilarity: number | null;
  bestDetectionConfidence: number | null;
  bestQualityScore: number | null;
  /** Which detected face contributed the winning score, so faculty review
   * can jump to the frame. */
  bestFaceId: string | null;
  /** The `FaceEmbedding` behind the winning score. */
  bestEmbeddingId: string | null;
  /** Quality flags on the winning face — "Face too small" is read from here. */
  bestQualityFlags: FaceQualityReason[];
  /** Attendance-vocabulary decision (PRESENT / NEEDS_REVIEW / ABSENT).
   * NEVER PRESENT if the underlying recognition status was UNCERTAIN. */
  advisoryResult: AttendanceResult;
  /** Raw AI-vocabulary status for transparency in the review UI. */
  matchStatus: MatchStatus;
  /** True when the face's top and runner-up were within the ambiguity
   * margin — the student was downgraded from MATCHED to UNCERTAIN for
   * safety, and a reviewer should look closely. */
  wasAmbiguous: boolean;
  /** Every demotion rule that fired, in the order of the policy above.
   * Empty when the representative observation was taken at face value. */
  downgrades: AggregationDowngrade[];
  /**
   * Every face that named this student, newest capture last. The provenance
   * the Phase 4 spec asks to preserve: capture number, face index,
   * similarity, confidence classification — with model version and timestamp
   * carried once on the run summary rather than repeated per row.
   */
  observations: StudentObservation[];
}

// ---------------------------------------------------------------------------
// Run summary
// ---------------------------------------------------------------------------

export interface RecognitionRunSummary {
  sessionId: string;
  cohortId: string;
  /**
   * Which enrolled population was actually searched. `"cohortSubject"` means
   * the session's subject had per-student (elective) enrollment and only
   * those students were compared; `"cohort"` means the whole class was.
   *
   * Reported rather than inferred: a reviewer reading "no match" needs to
   * know whether the student was even in the search space.
   */
  candidateScope: "cohort" | "cohortSubject";
  /** Distinct students with a template for the running model — not the
   * template count, which runs up to five per student. */
  candidatePoolSize: number;
  /** How many candidate embeddings were skipped because their `modelVersion`
   * did not match the running model. Surfaced rather than swallowed so
   * "could not compare this student" cannot silently become "absent". */
  skippedIncompatibleCandidates: number;
  /** Total faces the detector returned across all images. */
  detectedFacesTotal: number;
  /** Faces the pipeline actually scored (i.e. above min detection). */
  scoredFacesTotal: number;
  modelName: string;
  modelVersion: string;
  /** Echo of what face-ai said — false means the loaded backend is a stub
   * or a research-only model, and the review UI must warn accordingly. */
  productionEligible: boolean;
  policy: RecognitionPolicy;
  /** When the run completed (ISO-8601). Part of the provenance stored with
   * the register — carried once here rather than on every observation. */
  completedAt: string;
  /** Wall-clock milliseconds the face-ai round trip took. Logged, and shown
   * to nobody: it is an operational number, not an attendance one. */
  durationMs: number;
  perFace: FaceRecognitionResult[];
  perStudent: StudentRecognitionAggregate[];
  /** Students in the candidate pool who had no face above review threshold
   * in any image — the "absent" advisory list. */
  unmatchedStudentIds: string[];
  /** Faces face-ai detected but could not embed, by reason. Counts only. */
  rejectedFaces: Partial<Record<RejectedFaceReason, number>>;
  /** Scored faces carrying at least one quality flag, by flag. A face with two
   * flags counts under both. */
  flaggedFaces: Partial<Record<FaceQualityReason, number>>;
  /** Distinct unknown people across every capture in this run: unknown faces
   * in different photos that resemble each other above `presentMin` are
   * counted once. In memory only — nothing about an unknown face is stored. */
  unknownFacesTotal: number;
  /** True when a closer or clearer photo would plausibly change the result:
   * some faces were too small to embed or were flagged too small. */
  recommendRetake: boolean;
  /** "gallery" when a provider-held gallery (Azure AI Face) named the
   * candidates; absent or "embedding" for the vector path. */
  templateKind?: "embedding" | "gallery";
  /** Gallery runs: whether the provider allowed identification. Anything
   * but "enabled" means detection only — the face counts are real, nobody
   * was compared, and every student is left for the teacher. */
  identification?: IdentificationStatus;
  /** Gallery runs: false when the class gallery had nobody in it yet. */
  galleryReady?: boolean;
  /** Gallery runs: the students the class gallery could actually name.
   * A student with an active sample who is not in this class's gallery
   * (joined the class after enrolling) was never searchable, and must not
   * be told apart from one who was searched and not found. */
  comparableStudentIds?: string[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CandidateTemplate {
  /** The `FaceEmbedding` row id. Carried so a match can name the template it
   * came from, not merely the student. */
  embeddingId: string;
  studentId: string;
  embedding: number[];
  modelName: string;
  modelVersion: string;
}

export interface RecognitionRunInput {
  sessionId: string;
  images: Array<{ sequenceNumber: 1 | 2 | 3; imageBase64: string }>;
}
