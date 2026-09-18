import type { AttendanceMode, ConfidenceThresholds } from "@/modules/institutions/types";
import type { AttendanceSession, SessionStatus } from "@/modules/sessions/types";

/**
 * Product-level cap on classroom captures per session — Phase 4 spec:
 * "1 photo if sufficient, 2 photos if needed, 3 photos maximum". Exceeded
 * captures are rejected on the server so an out-of-date client cannot smuggle
 * a fourth image past the intent.
 */
export const MAX_CAPTURES_PER_SESSION = 3;

/**
 * The wire shape the capture wizard needs to render its "pick a class" step.
 * Includes the institution's attendance mode so the client knows whether to
 * ask for a subject next (COLLEGE / SUBJECT_WISE) or move straight to the
 * camera (SCHOOL / DAILY).
 */
export interface CapturableCohort {
  id: string;
  name: string;
  termLabel: string | null;
  attendanceMode: AttendanceMode;
}

export interface CapturableCohortSubject {
  id: string;
  subjectCode: string;
  subjectName: string;
}

/** Result of "Start Attendance" — either a newly-created session or the
 * existing open session for today being resumed. */
export interface StartCaptureSessionResult {
  session: AttendanceSession;
  resumed: boolean;
  attendanceMode: AttendanceMode;
  confidenceThresholds: ConfidenceThresholds;
  cohortName: string;
  subjectName: string | null;
  enrolledStudentCount: number;
}

/**
 * Per-image analysis result. Never carries the raw image bytes or the
 * embedding vectors back to the client — the client only needs the counts
 * and provenance to render the review screen.
 */
export interface CaptureImageAnalysis {
  sequenceNumber: 1 | 2 | 3;
  faceCount: number;
  averageDetectionConfidence: number | null;
  averageQualityScore: number | null;
  modelName: string;
  modelVersion: string;
  /** True when the loaded backend is licence-cleared for production
   * recognition (echoed from face-ai). Phase 4 shows an advisory banner
   * when this is false so faculty cannot mistake the preview for a real
   * attendance mark. */
  productionEligible: boolean;
  /** Coarse quality label the UI shows next to the thumbnail. */
  qualityLabel: "good" | "acceptable" | "poor" | "no_faces";
  qualityHint: string;
}

export type CaptureFailureReason =
  | "no_session"
  | "session_locked"
  | "session_forbidden"
  | "capture_limit_reached"
  | "sequence_conflict"
  | "empty_image"
  | "service_unavailable"
  | "service_timeout";

export interface CaptureImageFailure {
  ok: false;
  reason: CaptureFailureReason;
  message: string;
  /** Present when the failure is retryable (network blip, timeout). */
  retryable: boolean;
}

export type CaptureImageResult =
  | ({ ok: true } & CaptureImageAnalysis)
  | CaptureImageFailure;

/**
 * Summary the wizard shows on the "review" step after the user has captured
 * up to three images. No AttendanceRecord rows are written in Phase 4 —
 * the recognition pipeline is still stubbed (see FACE_AI_ARCHITECTURE.md);
 * this shape is what the wizard hands back to the review UI.
 */
export interface CaptureSessionSummary {
  sessionId: string;
  captureCount: number;
  totalFacesDetected: number;
  modelName: string;
  modelVersion: string;
  productionEligible: boolean;
  status: SessionStatus;
  enrolledStudentCount: number;
  /** True when at least one capture produced faces the detector was happy
   * with. Used to enable/disable the "prepare review" button. */
  hasUsableCaptures: boolean;
}
