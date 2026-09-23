import { recordAuditLog as defaultRecordAuditLog } from "@/modules/audit/service";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import { hasPermission, requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { getCohortById, listCohortsByInstitution, listCohortsForFaculty } from "@/modules/cohorts/repository";
import type { Cohort } from "@/modules/cohorts/types";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAttendanceMode, resolveConfidenceThresholds } from "@/modules/institutions/service";
import type { Institution } from "@/modules/institutions/types";
import { prisma } from "@/lib/prisma";
import {
  createAttendanceSessionForRequest,
  canTransitionSessionStatus,
} from "@/modules/sessions/service";
import {
  findExistingDailySession as findExistingDailySessionRepo,
  getSessionById,
} from "@/modules/sessions/repository";
import type { AttendanceSession, SessionStatus } from "@/modules/sessions/types";
import { getCohortSubjectById, listCohortSubjectsByCohort } from "@/modules/subjects/repository";
import type {
  CaptureImageAnalysis,
  CaptureImageResult,
  CaptureSessionSummary,
  CapturableCohort,
  CapturableCohortSubject,
  StartCaptureSessionResult,
} from "./types";
import type { DetectRequest, DetectResponse } from "@attendance/shared-types";
import { requireCohortSubjectAccess } from "@/modules/authorization/cohort-access";
import { mergeSessionMetadata } from "@/modules/attendance-review/repository";

/**
 * Type of the injected face-ai client. The concrete import happens lazily
 * inside `analyzeCaptureImage` so that env-validation (which runs at
 * `@/lib/env` import time) does not fire during unit tests that never touch
 * the HTTP client.
 *
 * `/v1/detect` rather than `/v1/detect-embed`, deliberately. The per-capture
 * check answers one question — "did this photograph catch any faces, and are
 * they sharp enough to be worth keeping?" — which the detector alone settles.
 * Running the recognition model as well would generate an embedding for every
 * face in the room, immediately discard it, and then generate it again during
 * the authoritative pass. That is the expensive half of the pipeline done
 * twice, and it means biometric vectors being produced for a frame the teacher
 * is about to retake.
 */
type FaceDetectFn = (req: DetectRequest) => Promise<DetectResponse>;

/**
 * Phase 4 classroom capture — the faculty-facing "start attendance" flow.
 *
 * Distinct from `modules/attendance` (which owns the faculty-correction
 * mutation) and from `modules/sessions` (which owns the session lifecycle
 * primitives). This module orchestrates the two around the face-ai service
 * for the wizard UI, and is the ONLY place that ever forwards a classroom
 * image to face-ai.
 *
 * Privacy: classroom image bytes never touch Postgres. `SessionImage` rows
 * are deliberately not written — the recognition preview runs in-memory
 * against a temporary base64 payload and the payload is discarded once
 * face-ai returns. Persistent classroom-image retention is a product policy
 * decision documented in FACE_AI_ARCHITECTURE.md §7 and is not enabled by
 * default in Phase 4.
 */

// ---------------------------------------------------------------------------
// Cohort discovery
// ---------------------------------------------------------------------------

export interface ListCapturableCohortsDeps {
  listCohortsForFaculty?: (userId: string) => Promise<Cohort[]>;
  listCohortsByInstitution?: (institutionId: string) => Promise<Cohort[]>;
  getInstitutionById?: (id: string) => Promise<Institution | null>;
}

/**
 * Cohorts the caller may start an attendance session in. `cohort.manage`
 * holders (admins) see every cohort in their institution — everyone else
 * sees only cohorts they are linked to as faculty. Cross-institution
 * cohorts are never returned regardless of role.
 */
export async function listCapturableCohortsForActor(
  actor: SessionUser,
  deps: ListCapturableCohortsDeps = {},
): Promise<CapturableCohort[]> {
  requirePermission(actor, "attendanceSession.create");

  const forFaculty = deps.listCohortsForFaculty ?? listCohortsForFaculty;
  const byInstitution = deps.listCohortsByInstitution ?? listCohortsByInstitution;
  const getInstitution = deps.getInstitutionById ?? getInstitutionById;

  const cohorts = hasPermission(actor, "cohort.manage")
    ? actor.institutionId
      ? await byInstitution(actor.institutionId)
      : []
    : await forFaculty(actor.userId);

  // Filter down to the actor's own institution — a stale faculty link across
  // institutions must never leak a cohort into this list.
  const scoped = cohorts.filter((c) =>
    actor.institutionId ? c.institutionId === actor.institutionId : false,
  );
  if (scoped.length === 0) return [];

  // All cohorts in one institution share one attendance mode, so we resolve
  // it once rather than per row.
  const institutionId = scoped[0].institutionId;
  const institution = await getInstitution(institutionId);
  if (!institution) return [];
  const mode = resolveAttendanceMode(institution);

  return scoped.map((c) => ({
    id: c.id,
    name: c.name,
    termLabel: c.termLabel ?? null,
    attendanceMode: mode,
  }));
}

// ---------------------------------------------------------------------------
// Subject listing (COLLEGE / SUBJECT_WISE mode)
// ---------------------------------------------------------------------------

export interface ListCohortSubjectsForCaptureDeps {
  getCohortById?: (id: string) => Promise<Cohort | null>;
  listCohortSubjectsByCohort?: (cohortId: string) => Promise<
    Array<{ id: string; cohortId: string; subjectId: string; facultyId: string | null }>
  >;
  getSubjectsByIds?: (ids: string[]) => Promise<Array<{ id: string; code: string; name: string }>>;
  requireCohortAccess?: (u: SessionUser, cohortId: string) => Promise<void>;
}

export async function listCohortSubjectsForCapture(
  actor: SessionUser,
  cohortId: string,
  deps: ListCohortSubjectsForCaptureDeps = {},
): Promise<CapturableCohortSubject[]> {
  requirePermission(actor, "attendanceSession.create");

  const getCohort = deps.getCohortById ?? getCohortById;
  const cohort = await getCohort(cohortId);
  if (!cohort) throw new Error("cohort_not_found");
  requireSameInstitution(actor, cohort.institutionId);

  const checkAccess = deps.requireCohortAccess ?? requireCohortAccess;
  await checkAccess(actor, cohortId);

  const listSubjects = deps.listCohortSubjectsByCohort ?? listCohortSubjectsByCohort;
  const links = await listSubjects(cohortId);
  if (links.length === 0) return [];

  const getSubjects =
    deps.getSubjectsByIds ??
    (async (ids: string[]) =>
      prisma.subject.findMany({
        where: { id: { in: ids } },
        select: { id: true, code: true, name: true },
      }));
  const subjects = await getSubjects(links.map((l) => l.subjectId));
  const byId = new Map(subjects.map((s) => [s.id, s]));

  return links
    .map((l): CapturableCohortSubject | null => {
      const s = byId.get(l.subjectId);
      if (!s) return null;
      return { id: l.id, subjectCode: s.code, subjectName: s.name };
    })
    .filter((v): v is CapturableCohortSubject => v !== null);
}

// ---------------------------------------------------------------------------
// Start / resume an attendance session
// ---------------------------------------------------------------------------

export interface StartCaptureSessionInput {
  cohortId: string;
  cohortSubjectId?: string | null;
}

export interface StartCaptureSessionDeps {
  getCohortById?: (id: string) => Promise<Cohort | null>;
  getInstitutionById?: (id: string) => Promise<Institution | null>;
  createAttendanceSession?: typeof createAttendanceSessionForRequest;
  findExistingDailySession?: (
    cohortId: string,
    sessionDate: Date,
  ) => Promise<AttendanceSession | null>;
  transitionSessionStatus?: (
    sessionId: string,
    from: SessionStatus,
    to: SessionStatus,
  ) => Promise<AttendanceSession>;
  requireCohortAccess?: (u: SessionUser, cohortId: string) => Promise<void>;
  countEnrolledStudents?: (cohortId: string) => Promise<number>;
  getCohortSubjectById?: (id: string) => Promise<
    { id: string; cohortId: string; subjectId: string } | null
  >;
  getSubjectById?: (id: string) => Promise<{ id: string; name: string } | null>;
  recordAuditLog?: (input: RecordAuditLogInput) => Promise<void>;
  now?: () => Date;
}

async function transitionSessionStatusDefault(
  sessionId: string,
  from: SessionStatus,
  to: SessionStatus,
): Promise<AttendanceSession> {
  // Guarded update: only advance if the row is still in `from`. Two devices
  // racing to click "Start" cannot both succeed, and a stale client cannot
  // force a status backwards.
  const result = await prisma.attendanceSession.updateMany({
    where: { id: sessionId, status: from },
    data: { status: to },
  });
  if (result.count === 0) throw new Error("session_status_conflict");
  const row = await prisma.attendanceSession.findUniqueOrThrow({ where: { id: sessionId } });
  return row;
}

/**
 * Idempotent "Start Attendance" — creates a new session if none exists for
 * today (DAILY mode) or the (cohort, subject) pair (SUBJECT_WISE), or
 * resumes the existing one otherwise. Resumption is Phase 4 UX: refreshing
 * the browser mid-capture must not create a duplicate session.
 */
export async function startOrResumeCaptureSession(
  actor: SessionUser,
  input: StartCaptureSessionInput,
  deps: StartCaptureSessionDeps = {},
): Promise<StartCaptureSessionResult> {
  requirePermission(actor, "attendanceSession.create");
  requirePermission(actor, "attendanceSession.capture");

  const getCohort = deps.getCohortById ?? getCohortById;
  const cohort = await getCohort(input.cohortId);
  if (!cohort) throw new Error("cohort_not_found");
  requireSameInstitution(actor, cohort.institutionId);

  const getInstitution = deps.getInstitutionById ?? getInstitutionById;
  const institution = await getInstitution(cohort.institutionId);
  if (!institution) throw new Error("institution_not_found");
  const mode = resolveAttendanceMode(institution);
  const thresholds = resolveConfidenceThresholds(institution);

  const now = deps.now ? deps.now() : new Date();
  const findExisting = deps.findExistingDailySession ?? findExistingDailySessionRepo;
  const createSession = deps.createAttendanceSession ?? createAttendanceSessionForRequest;
  const transition = deps.transitionSessionStatus ?? transitionSessionStatusDefault;
  const countStudents =
    deps.countEnrolledStudents ??
    (async (cohortId: string) =>
      prisma.enrollment.count({ where: { cohortId, status: "ACTIVE" } }));

  let session: AttendanceSession;
  let resumed = false;

  if (mode === "DAILY") {
    // A DAILY session is unique-per-day per cohort — the same invariant the
    // sessions service enforces. Look before we leap so a resume is quiet.
    const existing = await findExisting(input.cohortId, now);
    if (existing) {
      requireSameInstitution(actor, existing.institutionId);
      // Faculty ownership guard: even in resume, the caller must still be
      // linked to this cohort (or hold cohort.manage).
      const checkAccess = deps.requireCohortAccess ?? requireCohortAccess;
      await checkAccess(actor, existing.cohortId);
      session = existing;
      resumed = true;
    } else {
      session = await createSession(actor, {
        cohortId: input.cohortId,
        sessionDate: now,
        cohortSubjectId: null,
      });
    }
  } else {
    if (!input.cohortSubjectId) throw new Error("subject_wise_mode_requires_subject");
    // SUBJECT_WISE resume: a session is looked up by (cohort, subject,
    // today). Multiple lectures for the same subject in one day would need
    // a policy decision — not addressed in Phase 4; we treat "today's"
    // lecture as unique.
    const dayStart = new Date(now);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);
    const existing = await prisma.attendanceSession.findFirst({
      where: {
        cohortId: input.cohortId,
        cohortSubjectId: input.cohortSubjectId,
        sessionDate: { gte: dayStart, lt: dayEnd },
        // A discarded lecture holds no register; see findExistingDailySession.
        status: { not: "CANCELLED" },
      },
    });
    if (existing) {
      requireSameInstitution(actor, existing.institutionId);
      session = existing;
      resumed = true;
    } else {
      session = await createSession(actor, {
        cohortId: input.cohortId,
        sessionDate: now,
        cohortSubjectId: input.cohortSubjectId,
      });
    }
  }

  // Advance OPEN → CAPTURING so a stopped-halfway resume presents in the
  // right state. Skip the transition if we are already at or past CAPTURING
  // (a completed session must not be forced back into capture).
  if (session.status === "OPEN" && canTransitionSessionStatus("OPEN", "CAPTURING")) {
    session = await transition(session.id, "OPEN", "CAPTURING");
  } else if (session.status === "FINALIZED" || session.status === "CANCELLED") {
    throw new Error(`session_locked:${session.status}`);
  }

  // Subject label (best-effort, for the UI header).
  let subjectName: string | null = null;
  if (session.cohortSubjectId) {
    const getCS = deps.getCohortSubjectById ?? getCohortSubjectById;
    const cs = await getCS(session.cohortSubjectId);
    if (cs) {
      const getSubject =
        deps.getSubjectById ??
        (async (id: string) =>
          prisma.subject.findUnique({ where: { id }, select: { id: true, name: true } }));
      const s = await getSubject(cs.subjectId);
      subjectName = s?.name ?? null;
    }
  }

  const enrolledStudentCount = await countStudents(input.cohortId);

  const auditFn = deps.recordAuditLog ?? ((i: RecordAuditLogInput) => defaultRecordAuditLog(i));
  await auditFn({
    action: resumed ? "attendance_capture.resumed" : "attendance_capture.started",
    entityType: "AttendanceSession",
    entityId: session.id,
    institutionId: session.institutionId,
    actorUserId: actor.userId,
    afterJson: {
      cohortId: session.cohortId,
      cohortSubjectId: session.cohortSubjectId,
      status: session.status,
      attendanceMode: mode,
    },
  });

  return {
    session,
    resumed,
    attendanceMode: mode,
    confidenceThresholds: thresholds,
    cohortName: cohort.name,
    subjectName,
    enrolledStudentCount,
  };
}

// ---------------------------------------------------------------------------
// Per-image analysis (calls face-ai)
// ---------------------------------------------------------------------------

export interface AnalyzeCaptureImageInput {
  sessionId: string;
  sequenceNumber: 1 | 2 | 3;
  imageBase64: string;
}

export interface AnalyzeCaptureImageDeps {
  getSessionById?: (id: string) => Promise<AttendanceSession | null>;
  requireCohortAccess?: (u: SessionUser, cohortId: string) => Promise<void>;
  requireCohortSubjectAccess?: (u: SessionUser, cohortSubjectId: string) => Promise<void>;
  faceDetect?: FaceDetectFn;
  /**
   * Timeout for the face-ai round trip, in ms. face-ai processing is
   * bounded (mock is instant; a real backend must respect this), but the
   * network in between is not — a long stall must surface as
   * "service_timeout" so the wizard can offer a retake rather than
   * appearing frozen.
   */
  detectTimeoutMs?: number;
  /** Injected model-info reader so a test can force productionEligible to
   * a known value without spinning up face-ai. Optional. */
  fetchModelInfo?: () => Promise<{ productionEligible: boolean }>;
  /** Records the accepted capture on the session, so the summary is built
   * from what the server saw rather than from what the browser reports. */
  recordCaptureAnalysis?: (
    sessionId: string,
    analysis: CaptureImageAnalysis,
  ) => Promise<void>;
}

function classifyCaptureQuality(
  faceCount: number,
  averageDetectionConfidence: number | null,
): { qualityLabel: CaptureImageAnalysis["qualityLabel"]; qualityHint: string } {
  if (faceCount === 0) {
    return {
      qualityLabel: "no_faces",
      qualityHint:
        "No faces detected. Move the camera closer or brighten the room, then retake.",
    };
  }
  const conf = averageDetectionConfidence ?? 0;
  if (conf >= 0.85) {
    return {
      qualityLabel: "good",
      qualityHint: `Detected ${faceCount} face${faceCount === 1 ? "" : "s"} at high confidence.`,
    };
  }
  if (conf >= 0.65) {
    return {
      qualityLabel: "acceptable",
      qualityHint: `Detected ${faceCount} face${faceCount === 1 ? "" : "s"}. Consider an extra angle if some students appear blurred or partially covered.`,
    };
  }
  return {
    qualityLabel: "poor",
    qualityHint: `Only ${faceCount} face${faceCount === 1 ? "" : "s"} detected at low confidence. Retake with more light or a closer angle.`,
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("face_ai_timeout")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The per-capture quality gate: one classroom photograph through face-ai's
 * `/v1/detect`, returning counts and a verdict the wizard shows beside the
 * thumbnail.
 *
 * Detection only. No embedding is generated here — so nothing biometric is
 * derived from a frame the teacher may be about to retake, and the recognition
 * model is not run twice over the same room. The authoritative pass that does
 * produce embeddings is `runRecognitionForSession`, once, over the final set.
 *
 * There is no capture counter in the input. There used to be: the browser sent
 * `acceptedSoFar` and the server enforced the three-capture cap against it,
 * which made a product rule depend on a number the client chose. The cap is
 * structural instead — `sequenceNumber` is 1, 2 or 3, so a session cannot hold
 * a fourth distinct capture, and re-analysing a sequence is a retake rather
 * than an addition.
 */
export async function analyzeCaptureImage(
  actor: SessionUser,
  input: AnalyzeCaptureImageInput,
  deps: AnalyzeCaptureImageDeps = {},
): Promise<CaptureImageResult> {
  requirePermission(actor, "attendanceSession.capture");

  if (input.imageBase64.length < 64) {
    return {
      ok: false,
      reason: "empty_image",
      message: "The captured image looks empty. Retake the photo and try again.",
      retryable: true,
    };
  }

  const getSession = deps.getSessionById ?? getSessionById;
  const session = await getSession(input.sessionId);
  if (!session) {
    return {
      ok: false,
      reason: "no_session",
      message: "This attendance session no longer exists. Start a new session to continue.",
      retryable: false,
    };
  }
  try {
    requireSameInstitution(actor, session.institutionId);
    const checkAccess = deps.requireCohortAccess ?? requireCohortAccess;
    await checkAccess(actor, session.cohortId);
    // Same rule as session creation and recognition: a subject register
    // belongs to whoever teaches that subject, not to everyone who teaches
    // the class.
    if (session.cohortSubjectId) {
      const checkSubject = deps.requireCohortSubjectAccess ?? requireCohortSubjectAccess;
      await checkSubject(actor, session.cohortSubjectId);
    }
  } catch (e) {
    if (e instanceof ForbiddenError) {
      return {
        ok: false,
        reason: "session_forbidden",
        message: "You do not have access to this session's class.",
        retryable: false,
      };
    }
    throw e;
  }

  if (session.status !== "CAPTURING") {
    return {
      ok: false,
      reason: "session_locked",
      message: `This session is ${session.status.toLowerCase()} and can no longer accept captures.`,
      retryable: false,
    };
  }

  const detect: FaceDetectFn =
    deps.faceDetect ??
    (async (req) => {
      // Lazy import — keeps `@/lib/env` (which validates process.env at
      // module load) out of the import graph of pure unit tests, matching
      // the pattern used by face-enrollment/service.ts.
      const { faceDetect } = await import("@/lib/face-ai-client");
      return faceDetect(req);
    });
  const timeoutMs = deps.detectTimeoutMs ?? 30_000;

  let response: DetectResponse;
  try {
    response = await withTimeout(detect({ imageBase64: input.imageBase64 }), timeoutMs);
  } catch (e) {
    const message = e instanceof Error ? e.message : "unknown";
    if (message === "face_ai_timeout") {
      return {
        ok: false,
        reason: "service_timeout",
        message: "Face detection took too long to respond. Try again.",
        retryable: true,
      };
    }
    return {
      ok: false,
      reason: "service_unavailable",
      message: "The face service is temporarily unavailable. Try again in a moment.",
      retryable: true,
    };
  }

  const faces = response.faces;
  const faceCount = faces.length;
  const averageDetectionConfidence =
    faceCount > 0
      ? faces.reduce((s, f) => s + (f.detectionConfidence ?? 0), 0) / faceCount
      : null;
  // `/v1/detect` reports detector confidence but no per-face quality score —
  // quality is a property of a crop the recogniser prepares. Reported as null
  // rather than invented, and the authoritative run fills it in later.
  const averageQualityScore = null;
  const quality = classifyCaptureQuality(faceCount, averageDetectionConfidence);

  // productionEligible lives in `/v1/model-info`; a real integration would
  // cache it. Defaults to false — matching the ONNX scaffold / mock backends
  // the service ships with — unless a caller overrides it.
  const productionEligible = deps.fetchModelInfo
    ? (await deps.fetchModelInfo()).productionEligible
    : false;

  const analysis: CaptureImageAnalysis = {
    sequenceNumber: input.sequenceNumber,
    faceCount,
    averageDetectionConfidence,
    averageQualityScore,
    imageWidth: response.imageWidth,
    imageHeight: response.imageHeight,
    modelName: response.modelName,
    modelVersion: response.modelVersion,
    productionEligible,
    qualityLabel: quality.qualityLabel,
    qualityHint: quality.qualityHint,
  };

  // Kept on the session so `summarizeCaptureSession` can report what the
  // server actually saw. Re-analysing the same sequence overwrites, which is
  // exactly what a retake should do.
  const record = deps.recordCaptureAnalysis ?? recordCaptureAnalysisDefault;
  await record(session.id, analysis);

  return { ok: true, ...analysis };
}

/**
 * Where the per-capture verdicts live between the capture step and the summary
 * step.
 *
 * `AttendanceSession.metadata` rather than a new column or a `SessionImage`
 * row: this is a handful of counts with the lifetime of one wizard session,
 * the JSON column already carries the review phase's own bucket, and a schema
 * change for it would not earn its migration. Note what is *not* stored — no
 * image bytes, no embeddings, no bounding boxes. Just how many faces the
 * detector found and how sure it was.
 */
export const CAPTURE_METADATA_KEY = "capture";

export interface StoredCaptureMetadata {
  analyses: CaptureImageAnalysis[];
  lastCaptureAt: string;
}

export function readStoredCaptureMetadata(metadata: unknown): StoredCaptureMetadata | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const bucket = (metadata as Record<string, unknown>)[CAPTURE_METADATA_KEY];
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return null;
  const analyses = (bucket as { analyses?: unknown }).analyses;
  if (!Array.isArray(analyses)) return null;
  return {
    analyses: analyses as CaptureImageAnalysis[],
    lastCaptureAt: String((bucket as { lastCaptureAt?: unknown }).lastCaptureAt ?? ""),
  };
}

/**
 * Merges one capture's verdict into the session, replacing any previous
 * verdict for the same sequence number.
 *
 * Read-modify-write on a JSON column is not atomic, and two captures written
 * at the same instant could lose one. That is acceptable here and nowhere
 * else: the worst case is a thumbnail's face count missing from the summary,
 * the register itself is built from the recognition run rather than from this,
 * and a single teacher's wizard does not press capture twice at once.
 */
async function recordCaptureAnalysisDefault(
  sessionId: string,
  analysis: CaptureImageAnalysis,
): Promise<void> {
  const row = await prisma.attendanceSession.findUnique({
    where: { id: sessionId },
    select: { metadata: true },
  });
  const existing = readStoredCaptureMetadata(row?.metadata)?.analyses ?? [];
  const analyses = [
    ...existing.filter((a) => a.sequenceNumber !== analysis.sequenceNumber),
    analysis,
  ].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  await mergeSessionMetadata(sessionId, {
    [CAPTURE_METADATA_KEY]: {
      analyses,
      lastCaptureAt: new Date().toISOString(),
    } satisfies StoredCaptureMetadata,
  });
}

// ---------------------------------------------------------------------------
// Session summary (review step) and cancellation
// ---------------------------------------------------------------------------

export interface SummarizeCaptureSessionInput {
  sessionId: string;
}

/**
 * What the wizard's summary step reports, built entirely from server-side
 * state.
 *
 * This used to take an `analyses` array from the browser and echo it back as
 * though it were a finding. It was not: a client could report three good
 * captures and forty detected faces without ever opening a camera, and the
 * summary screen would say so. The verdicts are now read from the session,
 * where `analyzeCaptureImage` put them after seeing the images itself.
 */
export async function summarizeCaptureSession(
  actor: SessionUser,
  input: SummarizeCaptureSessionInput,
  deps: {
    getSessionById?: (id: string) => Promise<AttendanceSession | null>;
    countEnrolledStudents?: (cohortId: string) => Promise<number>;
    requireCohortAccess?: (u: SessionUser, cohortId: string) => Promise<void>;
    loadCaptureAnalyses?: (sessionId: string) => Promise<CaptureImageAnalysis[]>;
  } = {},
): Promise<CaptureSessionSummary> {
  requirePermission(actor, "attendanceSession.capture");

  const getSession = deps.getSessionById ?? getSessionById;
  const session = await getSession(input.sessionId);
  if (!session) throw new Error("session_not_found");
  requireSameInstitution(actor, session.institutionId);
  const checkAccess = deps.requireCohortAccess ?? requireCohortAccess;
  await checkAccess(actor, session.cohortId);

  const countStudents =
    deps.countEnrolledStudents ??
    (async (cohortId: string) =>
      prisma.enrollment.count({ where: { cohortId, status: "ACTIVE" } }));
  const enrolledStudentCount = await countStudents(session.cohortId);

  const loadAnalyses =
    deps.loadCaptureAnalyses ??
    (async (sessionId: string) => {
      const row = await prisma.attendanceSession.findUnique({
        where: { id: sessionId },
        select: { metadata: true },
      });
      return readStoredCaptureMetadata(row?.metadata)?.analyses ?? [];
    });
  const analyses = await loadAnalyses(session.id);

  const totalFacesDetected = analyses.reduce((s, a) => s + a.faceCount, 0);
  const hasUsableCaptures = analyses.some(
    (a) => a.qualityLabel === "good" || a.qualityLabel === "acceptable",
  );
  // `every` over an empty list is true, which would claim a licence-cleared
  // backend for a session that ran no captures at all. The honest answer with
  // nothing to go on is false.
  const productionEligible =
    analyses.length > 0 && analyses.every((a) => a.productionEligible);
  const modelName = analyses[0]?.modelName ?? "unknown";
  const modelVersion = analyses[0]?.modelVersion ?? "unknown";

  return {
    sessionId: session.id,
    captureCount: analyses.length,
    analyses,
    totalFacesDetected,
    modelName,
    modelVersion,
    productionEligible,
    status: session.status,
    enrolledStudentCount,
    hasUsableCaptures,
  };
}

export interface CancelCaptureSessionDeps {
  getSessionById?: (id: string) => Promise<AttendanceSession | null>;
  transitionSessionStatus?: (
    sessionId: string,
    from: SessionStatus,
    to: SessionStatus,
  ) => Promise<AttendanceSession>;
  requireCohortAccess?: (u: SessionUser, cohortId: string) => Promise<void>;
  recordAuditLog?: (input: RecordAuditLogInput) => Promise<void>;
}

/**
 * Faculty-initiated cancel — used by the wizard's "Discard session" button.
 * Never destroys the AttendanceSession row (audit trail requires it survive)
 * — moves it to CANCELLED so the daily-uniqueness invariant does not lock
 * the cohort out of a fresh capture on the same day.
 */
export async function cancelCaptureSession(
  actor: SessionUser,
  sessionId: string,
  deps: CancelCaptureSessionDeps = {},
): Promise<AttendanceSession> {
  requirePermission(actor, "attendanceSession.capture");

  const getSession = deps.getSessionById ?? getSessionById;
  const session = await getSession(sessionId);
  if (!session) throw new Error("session_not_found");
  requireSameInstitution(actor, session.institutionId);
  const checkAccess = deps.requireCohortAccess ?? requireCohortAccess;
  await checkAccess(actor, session.cohortId);

  if (session.status === "FINALIZED" || session.status === "CANCELLED") {
    return session;
  }
  if (!canTransitionSessionStatus(session.status, "CANCELLED")) {
    throw new Error(`invalid_transition:${session.status}->CANCELLED`);
  }
  const transition = deps.transitionSessionStatus ?? transitionSessionStatusDefault;
  const updated = await transition(session.id, session.status, "CANCELLED");

  const auditFn = deps.recordAuditLog ?? ((i: RecordAuditLogInput) => defaultRecordAuditLog(i));
  await auditFn({
    action: "attendance_capture.cancelled",
    entityType: "AttendanceSession",
    entityId: session.id,
    institutionId: session.institutionId,
    actorUserId: actor.userId,
    beforeJson: { status: session.status },
    afterJson: { status: "CANCELLED" },
  });
  return updated;
}
