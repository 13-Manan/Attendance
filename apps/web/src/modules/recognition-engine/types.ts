import type { MatchStatus } from "@attendance/shared-types";
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
  candidateStudentId: string | null;
  similarityScore: number | null;
  /** Second-best candidate's similarity, when it exists — used by the
   * ambiguity margin rule. Purely diagnostic on the wire. */
  runnerUpSimilarity: number | null;
  detectionConfidence: number;
  qualityScore: number | null;
  decision: MatchStatus;
  /** When the face was dropped before comparison (e.g. below
   * `minDetectionConfidence`). Diagnostic — the UI can group these. */
  dropReason: "low_detection_confidence" | null;
}

// ---------------------------------------------------------------------------
// Per-student aggregate (post-deduplication)
// ---------------------------------------------------------------------------

/**
 * One row per enrolled candidate student after cross-image deduplication.
 * "Rahul appears in image 1 and image 2 → Rahul counts once" is enforced
 * here: the highest-similarity result for each student across every image
 * becomes that student's advisory record.
 */
export interface StudentRecognitionAggregate {
  studentId: string;
  bestSimilarity: number | null;
  bestDetectionConfidence: number | null;
  bestQualityScore: number | null;
  /** Which detected face contributed the winning score, so faculty review
   * can jump to the frame. */
  bestFaceId: string | null;
  /** Attendance-vocabulary decision (PRESENT / NEEDS_REVIEW / ABSENT).
   * NEVER PRESENT if the underlying recognition status was UNCERTAIN. */
  advisoryResult: AttendanceResult;
  /** Raw AI-vocabulary status for transparency in the review UI. */
  matchStatus: MatchStatus;
  /** True when the face's top and runner-up were within the ambiguity
   * margin — the student was downgraded from MATCHED to UNCERTAIN for
   * safety, and a reviewer should look closely. */
  wasAmbiguous: boolean;
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
  perFace: FaceRecognitionResult[];
  perStudent: StudentRecognitionAggregate[];
  /** Students in the candidate pool who had no face above review threshold
   * in any image — the "absent" advisory list. */
  unmatchedStudentIds: string[];
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface CandidateTemplate {
  studentId: string;
  embedding: number[];
  modelName: string;
  modelVersion: string;
}

export interface RecognitionRunInput {
  sessionId: string;
  images: Array<{ sequenceNumber: 1 | 2 | 3; imageBase64: string }>;
}
