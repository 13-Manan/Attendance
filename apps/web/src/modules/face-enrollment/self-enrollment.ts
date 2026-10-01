import type { Prisma } from "@prisma/client";
import type { ModelInfoResponse } from "@attendance/shared-types";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { hasPermission, requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import * as galleryRepo from "@/modules/face-gallery/repository";
import { latestPairDecision } from "@/modules/twin-confirmation/repository";
import { twinBlockStates } from "@/modules/twin-confirmation/service";
import type { Institution } from "@/modules/institutions/types";
import type { Student } from "@/modules/students/types";
import { GUIDED_STEP_ORDER, currentGuidedStep } from "./guided-steps";
import {
  resolveSelfEnrollmentEnabled,
  summariseEnrollmentStatus,
  type FaceEnrollmentStatusSummary,
  type TemplateModel,
} from "./policy";
import * as repo from "./repository";
import {
  deriveSelfCaptureKey,
  inspectSelfCapture,
  issueSelfCaptureToken,
  verifySelfCaptureToken,
  type SelfCaptureBinding,
} from "./self-capture";
import { enrollOwnFaceRequest, type FaceEnrollmentDeps } from "./service";
import {
  SELF_ENROLLMENT_COMPLETE,
  describeRefusal,
  isRetryable,
  type FaceCaptureOutcome,
  type FaceCaptureSource,
  type FaceEnrollmentRefusal,
  type FaceEnrollmentResult,
} from "./types";

/**
 * A student enrolling their own face from the portal: the checks that belong
 * to that one path, in front of the enrollment core that every path shares.
 *
 * ## What this adds, and what it leaves alone
 *
 * `enrollOwnFaceRequest` in service.ts already resolves the subject from the
 * session, never from the request, and runs the same seven steps as staff
 * enrollment: policy, the sample cap, the quality gates, the vector check,
 * the duplicate and look-alike scans. None of that is repeated or changed
 * here. This module adds what only the student path needs:
 *
 * - **Camera only.** A capture must carry a camera session from
 *   `startOwnFaceCaptureRequest` and look like a frame from this app's camera
 *   code; anything else is `camera_required`. See self-capture.ts, including
 *   what those checks cannot prove.
 * - **One enrollment at a time per student.** A per-student advisory lock,
 *   held for the whole enrollment, turns a double click, a second tab or a
 *   retry that overtakes the original into `enrollment_in_progress` rather
 *   than a second template or a sixth sample. The lock is transaction-scoped,
 *   the same mechanism the college and school setup writes use, so it is
 *   released however the request ends.
 * - **A log line per outcome**, with ids and categories only.
 *
 * Staff enrollment does not pass through here and is unchanged, uploads
 * included.
 */

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/**
 * Where the student's own twin / lookalike review stands: waiting for staff,
 * not confirmed, or confirmed. Never who the other student is.
 */
export type OwnTwinReview = "pending" | "not_confirmed" | "confirmed";

/** One stored sample, as much as the student's own page needs: no id, no vector. */
export interface OwnActiveSample extends TemplateModel {
  createdAt: Date;
}

export type EnrollmentLockOutcome<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Runs `work` holding this student's self-enrollment lock, or reports that
 * somebody else holds it. `work` receives enrollment-core dependencies that
 * read and write through the lock's own connection.
 */
export type EnrollmentLock = <T>(
  studentId: string,
  work: (core: FaceEnrollmentDeps) => Promise<T>,
) => Promise<EnrollmentLockOutcome<T>>;

export interface SelfEnrollmentDeps extends FaceEnrollmentDeps {
  listActiveSamples?: (studentId: string) => Promise<OwnActiveSample[]>;
  /** The student's own standing in a twin / lookalike review, if they have one. */
  ownTwinReview?: (institutionId: string, studentId: string) => Promise<OwnTwinReview | null>;
  withEnrollmentLock?: EnrollmentLock;
  captureKey?: () => Buffer;
  now?: () => number;
  log?: (level: "info" | "warn", line: string) => void;
}

/**
 * How long the lock's transaction may stay open: the face service's round
 * trip plus a few queries, normally a second or two. A service that takes
 * longer than this is broken, and the transaction is rolled back rather than
 * left holding a connection — nothing is written outside it.
 */
const LOCK_TRANSACTION = { timeout: 60_000, maxWait: 10_000 };

function lockKey(studentId: string): string {
  return `face-self-enrollment:${studentId}`;
}

/**
 * The enrollment core's database dependencies, bound to one transaction.
 *
 * Every read and write the core makes on this path goes through the
 * connection that holds the lock. Were they left on the shared pool, each
 * enrollment would need two connections at once — the held one and one per
 * query — and enough simultaneous enrollments would wait on each other until
 * the pool timed out. The sample and its audit row also commit together.
 */
function throughTransaction(tx: Prisma.TransactionClient): FaceEnrollmentDeps {
  return {
    getStudentById: (id) => tx.student.findUnique({ where: { id } }),
    getStudentByUserId: (userId) => tx.student.findUnique({ where: { userId } }),
    getInstitution: (id) => tx.institution.findUnique({ where: { id } }),
    listActiveTemplateModelsForStudent: (studentId) =>
      tx.faceEmbedding.findMany({
        where: { studentId, isActive: true },
        select: { modelName: true, modelVersion: true },
      }),
    findNearestTemplates: (institutionId, probe, model, limit, enrollingStudentId) =>
      repo.findNearestTemplatesInInstitution(institutionId, probe, model, limit, { enrollingStudentId }, tx),
    findOwnTemplateSimilarities: (institutionId, studentId, probe, model) =>
      repo.findOwnTemplateSimilarities(institutionId, studentId, probe, model, tx),
    insertFaceEmbedding: (input) => repo.insertFaceEmbedding(input, tx),
    insertGallerySample: (input) => galleryRepo.insertGallerySample(input, tx),
    recordAuditLog: (input) => recordAuditLog(input, tx),
    pairDecision: (institutionId, studentId, otherStudentId) =>
      latestPairDecision(institutionId, studentId, otherStudentId, tx),
  };
}

const withStudentEnrollmentLock: EnrollmentLock = (studentId, work) =>
  prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(hashtext(${lockKey(studentId)})) AS acquired
    `;
    if (!rows[0]?.acquired) return { acquired: false as const };
    return { acquired: true as const, value: await work(throughTransaction(tx)) };
  }, LOCK_TRANSACTION);

function defaults() {
  return {
    getStudentByUserId: (userId: string) => prisma.student.findUnique({ where: { userId } }),
    getInstitution: (id: string) => prisma.institution.findUnique({ where: { id } }),
    listActiveTemplateModelsForStudent: repo.listActiveTemplateModelsForStudent,
    listActiveSamples: (studentId: string) =>
      prisma.faceEmbedding.findMany({
        where: { studentId, isActive: true },
        select: { modelName: true, modelVersion: true, createdAt: true },
      }),
    faceModelInfo: async (): Promise<ModelInfoResponse> => {
      const { faceModelInfo } = await import("@/lib/face-ai-client");
      return faceModelInfo();
    },
    ownTwinReview: async (institutionId: string, studentId: string) =>
      (await twinBlockStates(institutionId, [studentId])).get(studentId) ?? null,
    withEnrollmentLock: withStudentEnrollmentLock,
    captureKey: () => deriveSelfCaptureKey(process.env.AUTH_SECRET),
    now: () => Date.now(),
    log: (level: "info" | "warn", line: string) => {
      if (level === "warn") console.warn(line);
      else console.info(line);
    },
  };
}

function deps(overrides: SelfEnrollmentDeps) {
  return { ...defaults(), ...overrides };
}

type ResolvedDeps = ReturnType<typeof deps>;

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

type SelfEnrollmentEvent = "started" | "success" | "failed" | "rejected";

interface EventFacts {
  studentId: string;
  institutionId: string;
  /** School or college — the only thing about the institution worth a log field. */
  scope: "school" | "college";
  reason?: string;
  detail?: string;
  samples?: number;
}

/**
 * `student_face_enrollment.<event>`, one JSON line. Ids and categories only:
 * never the image, a frame, a vector, the camera token or anything a student
 * typed.
 */
function logEvent(d: ResolvedDeps, event: SelfEnrollmentEvent, facts: EventFacts): void {
  const line = JSON.stringify({
    log: "student_face_enrollment",
    event: `student_face_enrollment.${event}`,
    ...facts,
  });
  d.log(event === "failed" ? "warn" : "info", line);
}

// ---------------------------------------------------------------------------
// Resolving the caller
// ---------------------------------------------------------------------------

interface OwnSubject {
  student: Student;
  institution: Institution;
  facts: EventFacts;
}

/**
 * The student this session may enrol, and nobody else.
 *
 * The same resolution as the core — the session's user id to its linked
 * profile, checked against the session's institution — plus the one check the
 * core leaves to the session layer: that the student is on roll. An archived
 * student's session is already refused before it gets here; this makes the
 * rule hold for any caller.
 */
async function resolveOwnSubject(actor: SessionUser, d: ResolvedDeps): Promise<OwnSubject> {
  requirePermission(actor, "faceEmbedding.enroll.own");

  const student = await d.getStudentByUserId(actor.userId);
  if (!student) throw new Error("no_linked_student_profile");
  requireSameInstitution(actor, student.institutionId);

  const institution = await d.getInstitution(student.institutionId);
  if (!institution) throw new Error("institution_not_found");

  const facts: EventFacts = {
    studentId: student.id,
    institutionId: institution.id,
    scope: institution.type === "SCHOOL" ? "school" : "college",
  };
  if (student.status !== "ACTIVE") {
    logEvent(d, "rejected", { ...facts, reason: "student_inactive" });
    throw new ForbiddenError("student_inactive");
  }
  return { student, institution, facts };
}

/** The status the capture UI shows, with the running model asked for when it can be. */
async function ownStatus(d: ResolvedDeps, studentId: string): Promise<FaceEnrollmentStatusSummary> {
  const [models, runningModel] = await Promise.all([
    d.listActiveTemplateModelsForStudent(studentId),
    d.faceModelInfo().catch(() => null),
  ]);
  return summariseEnrollmentStatus(
    models,
    runningModel ? { modelName: runningModel.modelName, modelVersion: runningModel.modelVersion } : null,
  );
}

async function refuseOwn(
  d: ResolvedDeps,
  subject: OwnSubject,
  reason: FaceEnrollmentRefusal,
  detail?: string,
): Promise<FaceCaptureOutcome> {
  logEvent(d, "rejected", { ...subject.facts, reason, ...(detail ? { detail } : {}) });
  return {
    ok: false,
    reason,
    message: describeRefusal(reason, { channel: "SELF" }),
    status: await ownStatus(d, subject.student.id),
    retryable: isRetryable(reason),
  };
}

function bindingOf(actor: SessionUser, subject: OwnSubject): SelfCaptureBinding {
  return {
    userId: actor.userId,
    studentId: subject.student.id,
    institutionId: subject.institution.id,
  };
}

// ---------------------------------------------------------------------------
// Starting the camera
// ---------------------------------------------------------------------------

export type OwnFaceCaptureStart =
  | { ok: true; captureToken: string; expiresAt: string }
  | { ok: false; reason: "self_enrollment_disabled" | "sample_limit"; message: string };

/**
 * Opens a camera session: called by the portal once the student's camera is
 * running, before a photograph can be taken.
 *
 * Refuses up front what a capture would be refused for anyway — a closed
 * policy, a full set of samples — so nobody takes a photograph that cannot be
 * saved. Writes nothing.
 */
export async function startOwnFaceCaptureRequest(
  actor: SessionUser,
  overrides: SelfEnrollmentDeps = {},
): Promise<OwnFaceCaptureStart> {
  const d = deps(overrides);
  const subject = await resolveOwnSubject(actor, d);

  if (!resolveSelfEnrollmentEnabled(subject.institution)) {
    logEvent(d, "rejected", { ...subject.facts, reason: "self_enrollment_disabled" });
    return {
      ok: false,
      reason: "self_enrollment_disabled",
      message: describeRefusal("self_enrollment_disabled", { channel: "SELF" }),
    };
  }

  // The cap counts every active sample, whichever model made it, so the
  // running model is not needed to know whether there is room.
  const models = await d.listActiveTemplateModelsForStudent(subject.student.id);
  if (summariseEnrollmentStatus(models, null).remainingSlots === 0) {
    logEvent(d, "rejected", { ...subject.facts, reason: "sample_limit" });
    return {
      ok: false,
      reason: "sample_limit",
      message: describeRefusal("sample_limit", { channel: "SELF" }),
    };
  }

  const issued = issueSelfCaptureToken(d.captureKey(), bindingOf(actor, subject), d.now());
  logEvent(d, "started", { ...subject.facts, samples: models.length });
  return { ok: true, captureToken: issued.token, expiresAt: new Date(issued.expiresAt).toISOString() };
}

// ---------------------------------------------------------------------------
// Enrolling a capture
// ---------------------------------------------------------------------------

export interface EnrollOwnFaceFromCameraInput {
  imageBase64: string;
  captureSource: FaceCaptureSource;
  /** The camera session this frame was taken in. */
  captureToken?: string;
}

/** Said after a sample is saved: complete once the guided set is. */
function selfSuccessMessage(status: FaceEnrollmentStatusSummary): string {
  if (currentGuidedStep(status.usableSamples) === null) return SELF_ENROLLMENT_COMPLETE;
  const total = GUIDED_STEP_ORDER.length;
  return `Photo ${Math.min(status.usableSamples, total)} of ${total} saved. Your face is now available for attendance recognition — take the remaining guided photos so it recognizes you reliably in class.`;
}

/**
 * Enrols one camera frame for the signed-in student.
 *
 * Order: who (permission, own profile, tenancy, on roll), the institution's
 * policy, then the camera checks, then the lock — all before the image is sent
 * anywhere. Only then the unchanged core, which receives the image and
 * `captureSource: "CAMERA"` and nothing else from the request.
 *
 * Authorization failures throw, as on every other enrollment path. Any other
 * unexpected error is logged by category and replaced with a generic one, so
 * nothing from inside the pipeline reaches the browser or the server log.
 *
 * Returns a `FaceCaptureOutcome`: what the capture UI shows, without the
 * stored template's id or the model's score.
 */
export async function enrollOwnFaceFromCameraRequest(
  actor: SessionUser,
  input: EnrollOwnFaceFromCameraInput,
  overrides: SelfEnrollmentDeps = {},
): Promise<FaceCaptureOutcome> {
  const d = deps(overrides);
  const subject = await resolveOwnSubject(actor, d);

  if (!resolveSelfEnrollmentEnabled(subject.institution)) {
    return refuseOwn(d, subject, "self_enrollment_disabled");
  }

  // -- Camera only ----------------------------------------------------------
  if (input?.captureSource !== "CAMERA") {
    return refuseOwn(d, subject, "camera_required", "capture_source");
  }
  const session = verifySelfCaptureToken(d.captureKey(), input.captureToken, bindingOf(actor, subject), d.now());
  if (!session.ok) {
    return refuseOwn(d, subject, "camera_required", `session_${session.problem}`);
  }
  const frame = inspectSelfCapture(input.imageBase64);
  if (!frame.ok) {
    return refuseOwn(d, subject, "camera_required", `frame_${frame.problem}`);
  }

  // -- One at a time ----------------------------------------------------------
  let outcome: EnrollmentLockOutcome<FaceEnrollmentResult>;
  try {
    outcome = await d.withEnrollmentLock(subject.student.id, (throughLock) =>
      enrollOwnFaceRequest(
        actor,
        { imageBase64: input.imageBase64, captureSource: "CAMERA" },
        // Injected dependencies (tests) win over the lock's own.
        { ...throughLock, ...overrides },
      ),
    );
  } catch (error) {
    if (error instanceof ForbiddenError) {
      logEvent(d, "rejected", { ...subject.facts, reason: error.reason });
      throw error;
    }
    const code = (error as { code?: unknown } | null)?.code;
    logEvent(d, "failed", {
      ...subject.facts,
      reason: "error",
      detail: typeof code === "string" ? code : error instanceof Error ? error.name : "unknown",
    });
    throw new Error("face_enrollment_failed");
  }

  if (!outcome.acquired) {
    return refuseOwn(d, subject, "enrollment_in_progress");
  }

  const result = outcome.value;
  if (result.ok) {
    logEvent(d, "success", { ...subject.facts, samples: result.status.usableSamples });
    return {
      ok: true,
      message: selfSuccessMessage(result.status),
      status: result.status,
      replaced: result.replaced,
    };
  }
  logEvent(d, result.reason === "service_error" || result.reason === "invalid_embedding" ? "failed" : "rejected", {
    ...subject.facts,
    reason: result.reason,
    ...(result.twinReview ? { detail: `twin_review_${result.twinReview}` } : {}),
  });
  if (result.reason === "duplicate_identity" && result.twinReview === "pending") {
    // Their own name and student ID — never the other student's — so the
    // member of staff they ask can find the review.
    const own = subject.student;
    return {
      ...result,
      message: `${result.message} Give them your name and student ID: ${`${own.firstName} ${own.lastName}`.trim()} (${own.studentCode}).`,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface OwnFaceEnrollmentOverview {
  status: FaceEnrollmentStatusSummary;
  selfEnrollmentEnabled: boolean;
  /** When the earliest photo still used for recognition was saved; null when none is. */
  enrolledOn: Date | null;
  /** The student's own twin / lookalike review, when an enrollment was refused for one. */
  twinReview: OwnTwinReview | null;
  /** Who a student is told to ask: a school's staff, or a college's. */
  institutionType: "SCHOOL" | "COLLEGE";
}

/**
 * What the student's own enrollment page shows about them.
 *
 * The status the capture UI already uses, plus one date. No sample ids, no
 * model provenance, no vector — the page is reachable by anyone who can sign
 * in as this student, and none of those is anything they need.
 */
export async function getOwnFaceEnrollmentOverview(
  actor: SessionUser,
  overrides: SelfEnrollmentDeps = {},
): Promise<OwnFaceEnrollmentOverview> {
  const d = deps(overrides);
  const { student, institution } = await resolveOwnSubject(actor, d);

  const [samples, runningModel, twinReview] = await Promise.all([
    d.listActiveSamples(student.id),
    d.faceModelInfo().catch(() => null),
    // Decorates the page; a failure must not take it down.
    d.ownTwinReview(institution.id, student.id).catch(() => null),
  ]);
  const running: TemplateModel | null = runningModel
    ? { modelName: runningModel.modelName, modelVersion: runningModel.modelVersion }
    : null;
  const usable = running
    ? samples.filter((s) => s.modelName === running.modelName && s.modelVersion === running.modelVersion)
    : samples;
  const enrolledOn = usable.reduce<Date | null>(
    (earliest, s) => (earliest === null || s.createdAt < earliest ? s.createdAt : earliest),
    null,
  );

  return {
    status: summariseEnrollmentStatus(samples, running),
    selfEnrollmentEnabled: resolveSelfEnrollmentEnabled(institution),
    enrolledOn,
    twinReview,
    institutionType: institution.type,
  };
}

/**
 * Whether the portal home should invite this student to enrol: they may, and
 * they have no face samples at all.
 *
 * A database count and nothing else — the home page must not wait on the face
 * service — and false on any failure, because a prompt is not worth an error
 * on the page a student sees first.
 */
export async function shouldPromptOwnFaceEnrollment(
  actor: SessionUser,
  overrides: SelfEnrollmentDeps = {},
): Promise<boolean> {
  if (!hasPermission(actor, "faceEmbedding.enroll.own")) return false;
  const d = deps(overrides);
  try {
    const student = await d.getStudentByUserId(actor.userId);
    if (!student || student.status !== "ACTIVE" || student.institutionId !== actor.institutionId) return false;
    const institution = await d.getInstitution(student.institutionId);
    if (!institution || !resolveSelfEnrollmentEnabled(institution)) return false;
    const models = await d.listActiveTemplateModelsForStudent(student.id);
    return models.length === 0;
  } catch {
    return false;
  }
}
