import {
  correctionWindowOpen,
  resolveAttendancePolicy,
} from "@/modules/admin-settings/policy";
import {
  DEFAULT_ATTENDANCE_POLICY,
  type AttendancePolicySettings,
} from "@/modules/admin-settings/types";
import { recordAuditLog as defaultRecordAuditLog } from "@/modules/audit/service";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  requireCohortAccess,
  requireCohortSubjectAccess,
} from "@/modules/authorization/cohort-access";
import {
  hasPermission,
  requirePermission,
  requireSameInstitution,
} from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { getAttendanceRecordById as getAttendanceRecordByIdDefault } from "@/modules/attendance/repository";
import { correctAttendanceRecord as correctAttendanceRecordDefault } from "@/modules/attendance/service";
import type { AttendanceRecord, CorrectAttendanceRecordInput } from "@/modules/attendance/types";
import { buildEnvelope as buildWebhookEnvelope } from "@/modules/integrations/webhook-delivery";
import { emitWebhookEvent } from "@/modules/integrations/webhook-dispatcher";
import type { WebhookEvent, WebhookEventEnvelope } from "@/modules/integrations/types";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAttendanceMode } from "@/modules/institutions/service";
import type { Institution } from "@/modules/institutions/types";
import { attendanceEventPublisher } from "@/modules/realtime/publisher";
import type { AttendanceEventPublisher } from "@/modules/realtime/types";
import type { RecognitionRunSummary } from "@/modules/recognition-engine/types";
import { getSessionById, transitionSessionStatus } from "@/modules/sessions/repository";
import {
  finalizeAttendanceSession as finalizeAttendanceSessionDefault,
  type FinalizeAttendanceSessionDeps,
} from "@/modules/sessions/service";
import type { AttendanceSession, SessionStatus } from "@/modules/sessions/types";
import {
  getSessionDetailRow,
  getStudentByUserId,
  getUserNameById,
  listAttendanceRecordRowsForSession,
  listCohortRoster,
  listCohortSubjectRoster,
  listFinalizedAttendanceForStudent,
  listStudentIdsWithAnyTemplate,
  listStudentIdsWithComparableTemplates,
  mergeSessionMetadata,
  upsertAttendanceCandidates,
} from "./repository";
import type { AttendanceRecordRow, SessionDetailRow } from "./repository";
import type {
  AttendanceCounts,
  AttendanceSuggestion,
  AttendanceGenerationSource,
  AttendanceReviewBoard,
  AttendanceReviewReason,
  AttendanceReviewStudent,
  AttendanceRosterScope,
  AttendanceRosterStudent,
  AttendanceSessionDetail,
  CaptureImageMetadata,
  RecognitionRunMetadata,
  ReviewDecisionInput,
  ReviewDecisionResult,
  StudentAttendanceEntry,
  StudentAttendanceView,
} from "./types";

/**
 * Phase 6 attendance engine — the step that turns advisory recognition
 * output into an actual attendance register a human owns.
 *
 *   Captured images
 *     → Recognition results        (modules/recognition-engine, advisory)
 *     → Attendance candidates      (this module — one row per ENROLLED student)
 *     → Present / Absent / Needs Review
 *     → Faculty review + correction
 *     → Final attendance           (session FINALIZED, visible to students)
 *
 * Two rules shape everything below:
 *
 *  1. **Nobody is lost.** Candidates are generated from the enrolled roster,
 *     not from whoever recognition happened to return. A student with no
 *     usable face template is not silently omitted — they get a row and a
 *     reason.
 *  2. **Uncertainty is never promoted.** NEEDS_REVIEW is a terminal state
 *     for the machine; only a human can move it, and finalization is blocked
 *     while any unresolved state remains.
 */

// ---------------------------------------------------------------------------
// Session metadata (stored on AttendanceSession.metadata — no schema change)
// ---------------------------------------------------------------------------

/**
 * Where this phase's session-level facts live.
 *
 * `finalizedBy` / `finalizedAt` are part of the Phase 6 session contract, but
 * `AttendanceSession` has no columns for them and the phase invariant forbids
 * changing the database schema. They are written into the existing
 * `metadata Json` column instead, alongside the recognition provenance and
 * capture-image metadata. The authoritative, tamper-evident record of who
 * finalized is still the `AuditLog` row ("attendance.finalized",
 * actorUserId) — this copy exists so the review header can render without a
 * second query. Promoting these to real columns is an additive migration
 * whenever a schema change is in scope.
 */
export const ATTENDANCE_METADATA_KEY = "attendanceReview";

/**
 * One observation, as stored with the register.
 *
 * A trimmed copy of the engine's `StudentObservation`: capture number, face
 * index, similarity and the face-level verdict. Deliberately no embedding and
 * no bounding box — the provenance worth keeping is "which photograph, which
 * face, how sure", not a re-derivable biometric.
 */
export interface StoredObservation {
  captureNumber: number;
  faceIndex: number;
  similarity: number;
  matchStatus: string;
}

export interface StoredStudentNote {
  reason: AttendanceReviewReason;
  /**
   * What the model proposed, if anything. Separate from `reason`, which says
   * why a row needs a human. A row can have a suggestion AND still be
   * unresolved — that is the normal case for a confident match.
   */
  aiSuggestion?: AttendanceSuggestion;
  wasAmbiguous: boolean;
  wasComparable: boolean;
  bestFaceId: string | null;
  /**
   * Every face that named this student, so a reviewer asking "why is Priya in
   * review?" can be told "photo 1 face 3 at 71%, and photo 2 face 0 also
   * claimed her". Absent on rows written before this existed, and on rows that
   * recognition never produced.
   */
  observations?: StoredObservation[];
  /** Which demotion rules the aggregation policy applied, if any. */
  downgrades?: string[];
}

export interface StoredAttendanceMetadata {
  rosterScope: AttendanceRosterScope;
  generationSource: AttendanceGenerationSource;
  generatedAt: string;
  captureImages: CaptureImageMetadata[];
  recognition: RecognitionRunMetadata | null;
  studentNotes: Record<string, StoredStudentNote>;
  finalizedByUserId?: string;
  finalizedAt?: string;
}

function readStoredMetadata(metadata: unknown): Partial<StoredAttendanceMetadata> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const bucket = (metadata as Record<string, unknown>)[ATTENDANCE_METADATA_KEY];
  if (!bucket || typeof bucket !== "object" || Array.isArray(bucket)) return {};
  return bucket as Partial<StoredAttendanceMetadata>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function countAttendance(rows: Array<{ finalResult: string }>): AttendanceCounts {
  const counts: AttendanceCounts = {
    total: rows.length,
    present: 0,
    absent: 0,
    needsReview: 0,
    notEvaluated: 0,
  };
  for (const r of rows) {
    if (r.finalResult === "PRESENT") counts.present++;
    else if (r.finalResult === "ABSENT") counts.absent++;
    else if (r.finalResult === "NEEDS_REVIEW") counts.needsReview++;
    else counts.notEvaluated++;
  }
  return counts;
}

/**
 * Capture-image metadata, derived from the recognition run's per-face rows
 * rather than accepted from the browser. The client already knows these
 * numbers, but "how many faces were in photo 2" is part of the attendance
 * record's provenance, so it is recomputed from what the server actually
 * received.
 */
export function captureImageMetadataFrom(
  perFace: Array<{
    imageSequenceNumber: number;
    qualityScore: number | null;
  }>,
): CaptureImageMetadata[] {
  const bySequence = new Map<number, { faces: number; qualitySum: number; qualityN: number }>();
  for (const face of perFace) {
    const entry = bySequence.get(face.imageSequenceNumber) ?? {
      faces: 0,
      qualitySum: 0,
      qualityN: 0,
    };
    entry.faces++;
    if (face.qualityScore !== null) {
      entry.qualitySum += face.qualityScore;
      entry.qualityN++;
    }
    bySequence.set(face.imageSequenceNumber, entry);
  }
  return Array.from(bySequence.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([sequenceNumber, e]) => ({
      sequenceNumber,
      facesDetected: e.faces,
      qualityScore: e.qualityN > 0 ? e.qualitySum / e.qualityN : null,
    }));
}

export function initialsFor(firstName: string, lastName: string): string {
  const a = firstName.trim()[0] ?? "";
  const b = lastName.trim()[0] ?? "";
  return (a + b).toUpperCase() || "?";
}

/**
 * The candidate-generation decision table. Deliberately a pure function of
 * (roster student, recognition aggregate, template availability) so the
 * "do not lose them" behaviour is testable without any I/O.
 *
 * | situation                          | aiResult      | suggestion | finalResult  |
 * | ---------------------------------- | ------------- | ---------- | ------------ |
 * | recognition did not run            | NOT_EVALUATED | -          | NEEDS_REVIEW |
 * | recognition failed outright        | NOT_EVALUATED | -          | NEEDS_REVIEW |
 * | no usable face template            | NOT_EVALUATED | -          | NEEDS_REVIEW |
 * | no face detected in any capture    | NOT_EVALUATED | -          | NEEDS_REVIEW |
 * | matched above presentMin           | PRESENT       | PRESENT    | NEEDS_REVIEW |
 * | uncertain / ambiguous / duplicate  | NEEDS_REVIEW  | -          | NEEDS_REVIEW |
 * | compared, nothing above reviewMin  | ABSENT        | -          | NEEDS_REVIEW |
 *
 * ## Every row ends in NEEDS_REVIEW, and that is the point
 *
 * `finalResult` is what the register records. Nothing the model produces
 * writes it, because the model produces *evidence* and evidence is not a
 * decision. Two rows changed in Phase 6 to make that true:
 *
 *  - **"compared, nothing above reviewMin" used to write ABSENT.** It was the
 *    one place the system asserted absence on its own. Failing to find
 *    somebody has many causes that are not the student being elsewhere: they
 *    were behind another student, facing away, at the back of a dark room, or
 *    outside the frame. The `aiResult` still records ABSENT — that is the
 *    honest summary of what the comparison found — but the register waits for
 *    a person.
 *  - **"matched above presentMin" used to write PRESENT.** A confident match
 *    is now a *suggestion*: it shows in the Present column marked as the
 *    model's proposal, and becomes a real PRESENT when a faculty member
 *    confirms it, individually or by confirming the register.
 *
 * So the only paths to a final PRESENT or ABSENT run through
 * `applyReviewDecision` or `confirmAttendance`, both of which require a
 * permission, record an actor, and append an `AttendanceCorrection` row.
 *
 * `aiResult` keeps the machine's finding for every row regardless, so a
 * reviewer can always see what the model thought and a later investigation
 * can tell a human's decision from a machine's.
 */
export function decideCandidate(args: {
  aggregate:
    | {
        advisoryResult: string;
        bestSimilarity: number | null;
        wasAmbiguous: boolean;
        bestFaceId: string | null;
        bestEmbeddingId?: string | null;
        downgrades?: string[];
        observations?: Array<{
          captureNumber: number;
          faceIndex: number;
          similarity: number;
          matchStatus: string;
        }>;
      }
    | undefined;
  recognitionRan: boolean;
  hasComparableTemplate: boolean;
  hasAnyTemplate: boolean;
  /** True when recognition ran but found no face in any capture. Separates
   * "we saw nobody" from "we saw people, none of them you". */
  noFacesDetected?: boolean;
  /** True when recognition was attempted and errored. Distinct from never
   * having been attempted. */
  recognitionErrored?: boolean;
}): {
  aiResult: AttendanceRecordRow["aiResult"];
  aiConfidence: number | null;
  /** The `FaceEmbedding` behind the advisory, for `matchedEmbeddingId`. */
  matchedEmbeddingId: string | null;
  finalResult: AttendanceRecordRow["finalResult"];
  note: StoredStudentNote;
} {
  /** Provenance shared by every branch that had an aggregate to work from. */
  const provenance = (): Pick<StoredStudentNote, "observations" | "downgrades"> => ({
    observations: args.aggregate?.observations?.map((o) => ({
      captureNumber: o.captureNumber,
      faceIndex: o.faceIndex,
      similarity: o.similarity,
      matchStatus: o.matchStatus,
    })),
    downgrades: args.aggregate?.downgrades,
  });
  if (!args.recognitionRan) {
    return {
      aiResult: "NOT_EVALUATED",
      aiConfidence: null,
      matchedEmbeddingId: null,
      finalResult: "NEEDS_REVIEW",
      note: {
        reason: args.recognitionErrored ? "recognition_error" : "recognition_unavailable",
        aiSuggestion: null,
        wasAmbiguous: false,
        wasComparable: false,
        bestFaceId: null,
      },
    };
  }

  // Recognition ran but the room yielded no detectable face. Every student is
  // unresolved for the same reason, and that reason is about the photograph.
  if (args.noFacesDetected) {
    return {
      aiResult: "NOT_EVALUATED",
      aiConfidence: null,
      matchedEmbeddingId: null,
      finalResult: "NEEDS_REVIEW",
      note: {
        reason: "no_face_detected",
        aiSuggestion: null,
        wasAmbiguous: false,
        wasComparable: args.hasComparableTemplate,
        bestFaceId: null,
      },
    };
  }

  if (!args.hasComparableTemplate) {
    const reason: AttendanceReviewReason = args.hasAnyTemplate
      ? "incompatible_face_template"
      : "no_face_template";
    return {
      aiResult: "NOT_EVALUATED",
      aiConfidence: null,
      matchedEmbeddingId: null,
      finalResult: "NEEDS_REVIEW",
      note: {
        reason,
        aiSuggestion: null,
        wasAmbiguous: false,
        wasComparable: false,
        bestFaceId: null,
      },
    };
  }

  const agg = args.aggregate;
  if (!agg) {
    // Compared against every detected face and matched none of them. The
    // evidence is recorded as ABSENT; the register is NOT. Failing to find
    // somebody is not the same as their not being there, and only a person
    // may make that call.
    return {
      aiResult: "ABSENT",
      aiConfidence: null,
      matchedEmbeddingId: null,
      finalResult: "NEEDS_REVIEW",
      note: {
        reason: "no_match",
        aiSuggestion: null,
        wasAmbiguous: false,
        wasComparable: true,
        bestFaceId: null,
      },
    };
  }

  if (agg.advisoryResult === "PRESENT") {
    // A confident match is a proposal. It shows in the Present column marked
    // as the model's suggestion and becomes a real PRESENT only when a
    // faculty member confirms it — individually, or by confirming the
    // register, which records them as the actor either way.
    return {
      aiResult: "PRESENT",
      aiConfidence: agg.bestSimilarity,
      matchedEmbeddingId: agg.bestEmbeddingId ?? null,
      finalResult: "NEEDS_REVIEW",
      note: {
        reason: null,
        aiSuggestion: "PRESENT",
        wasAmbiguous: false,
        wasComparable: true,
        bestFaceId: agg.bestFaceId,
        ...provenance(),
      },
    };
  }

  if (agg.advisoryResult === "NEEDS_REVIEW") {
    return {
      aiResult: "NEEDS_REVIEW",
      aiConfidence: agg.bestSimilarity,
      matchedEmbeddingId: agg.bestEmbeddingId ?? null,
      finalResult: "NEEDS_REVIEW",
      note: {
        reason: agg.downgrades?.includes("duplicate_within_capture")
          ? "duplicate_in_capture"
          : agg.wasAmbiguous
            ? "ambiguous_match"
            : "low_confidence",
        aiSuggestion: null,
        wasAmbiguous: agg.wasAmbiguous,
        wasComparable: true,
        bestFaceId: agg.bestFaceId,
        ...provenance(),
      },
    };
  }

  // Same rule as the no-aggregate branch: evidence of ABSENT, decision
  // withheld. This was the one place the system used to assert absence.
  return {
    aiResult: "ABSENT",
    aiConfidence: agg.bestSimilarity,
    matchedEmbeddingId: null,
    finalResult: "NEEDS_REVIEW",
    note: {
      reason: "no_match",
      aiSuggestion: null,
      wasAmbiguous: false,
      wasComparable: true,
      bestFaceId: agg.bestFaceId,
      ...provenance(),
    },
  };
}

// ---------------------------------------------------------------------------
// Shared dependency surface
// ---------------------------------------------------------------------------

type RosterLoader = (id: string) => Promise<AttendanceRosterStudent[]>;

export interface AttendanceReviewDeps {
  getSessionById?: (id: string) => Promise<AttendanceSession | null>;
  getSessionDetailRow?: (id: string) => Promise<SessionDetailRow | null>;
  getAttendanceRecordById?: (id: string) => Promise<AttendanceRecord | null>;
  getInstitutionById?: (id: string) => Promise<Institution | null>;
  requireCohortAccess?: (u: SessionUser, cohortId: string) => Promise<void>;
  requireCohortSubjectAccess?: (u: SessionUser, cohortSubjectId: string) => Promise<void>;
  listCohortRoster?: RosterLoader;
  listCohortSubjectRoster?: RosterLoader;
  listComparableTemplates?: (
    studentIds: string[],
    model?: { modelName: string; modelVersion: string },
  ) => Promise<string[]>;
  listAnyTemplates?: (studentIds: string[]) => Promise<string[]>;
  listAttendanceRecords?: (sessionId: string) => Promise<AttendanceRecordRow[]>;
  upsertCandidates?: typeof upsertAttendanceCandidates;
  mergeSessionMetadata?: (sessionId: string, patch: Record<string, unknown>) => Promise<void>;
  transitionSessionStatus?: (
    sessionId: string,
    from: SessionStatus,
    to: SessionStatus,
  ) => Promise<AttendanceSession>;
  correctAttendanceRecord?: (input: CorrectAttendanceRecordInput) => Promise<AttendanceRecord>;
  finalizeAttendanceSession?: (
    actor: SessionUser,
    sessionId: string,
    deps?: FinalizeAttendanceSessionDeps,
  ) => Promise<AttendanceSession>;
  recordAuditLog?: (input: RecordAuditLogInput) => Promise<void>;
  publisher?: AttendanceEventPublisher;
  /**
   * Outbound webhook notification. Distinct from `publisher`, which is the
   * in-app realtime channel: that one pushes to a teacher's open browser and
   * is allowed to carry the AI advisory, because the reviewer is looking at
   * it. This one leaves the building, so its payloads carry `finalResult` and
   * never a confidence score — see `emitAttendanceWebhook` below.
   *
   * Injectable so the review tests can assert which events fire without a
   * dispatcher, and defaulted so no call site can forget it.
   */
  emitWebhook?: (envelope: WebhookEventEnvelope) => void;
  getUserNameById?: (id: string) => Promise<string | null>;
  now?: () => Date;
}

/**
 * Emits an attendance webhook, after the write and never able to break it.
 *
 * The payload is built here rather than passed in so there is exactly one
 * place that decides what an external system learns about a register. It is
 * `finalResult` and the session's identity — never `aiResult`, never
 * `aiConfidence`, never an image URL. A confidence score is an inference drawn
 * from a biometric template, and the product's rule is that the model is
 * advisory and the human is authoritative; an outbound payload offering both
 * would let a receiver prefer the model's answer to the teacher's.
 */
function emitAttendanceWebhook(
  deps: AttendanceReviewDeps,
  institutionId: string,
  type: WebhookEvent,
  subjectId: string,
  occurredAt: string,
  data: Record<string, unknown>,
): void {
  const envelope = buildWebhookEnvelope(institutionId, type, subjectId, occurredAt, data);
  if (deps.emitWebhook) {
    deps.emitWebhook(envelope);
    return;
  }
  emitWebhookEvent(envelope);
}

/**
 * The institution's attendance-correction policy, or the permissive default.
 *
 * Fails open, deliberately. The default policy is "no window, no mandatory
 * reason" — exactly what this module enforced before the setting existed — so
 * falling back to it on a failed settings read cannot grant anyone access they
 * did not have: `attendanceRecord.correct` and `attendanceSession.finalize`
 * have already been checked by the time this runs, and they are the controls.
 * Failing closed would instead mean a database hiccup silently locks a teacher
 * out of fixing a register, which is a worse failure with no security benefit.
 */
async function loadAttendancePolicy(
  institutionId: string,
  deps: AttendanceReviewDeps,
): Promise<AttendancePolicySettings> {
  const getInstitution = deps.getInstitutionById ?? getInstitutionById;
  try {
    const institution = await getInstitution(institutionId);
    return resolveAttendancePolicy(institution?.settings ?? null);
  } catch {
    return { ...DEFAULT_ATTENDANCE_POLICY };
  }
}

/**
 * Loads the session and runs the checks every entry point in this module
 * needs: it exists, it belongs to the caller's institution, and the caller
 * teaches (or administers) the cohort. Returns the session so callers do not
 * re-fetch.
 *
 * ## Why writing asks for more than reading
 *
 * `intent: "write"` additionally requires the subject link on a subject
 * session. `createAttendanceSessionForRequest` already demands it before a
 * college session can be opened at all, and recognition demands it before
 * processing one — so a register that exists was opened by somebody holding
 * that link, and this cannot lock out the person who started the capture. What
 * it stops is a colleague who teaches the same class a *different* subject
 * finalizing a register that is not theirs.
 *
 * Reading stays at cohort level deliberately: a class teacher looking at a
 * subject register their colleague took is ordinary oversight, not an
 * escalation, and an admin holds `cohort.manage` and bypasses both.
 */
async function loadAuthorizedSession(
  actor: SessionUser,
  sessionId: string,
  deps: AttendanceReviewDeps,
  intent: "read" | "write" = "read",
): Promise<AttendanceSession> {
  const getSession = deps.getSessionById ?? getSessionById;
  const session = await getSession(sessionId);
  if (!session) throw new Error("session_not_found");
  requireSameInstitution(actor, session.institutionId);
  const checkAccess = deps.requireCohortAccess ?? requireCohortAccess;
  await checkAccess(actor, session.cohortId);
  if (intent === "write" && session.cohortSubjectId) {
    const checkSubject = deps.requireCohortSubjectAccess ?? requireCohortSubjectAccess;
    await checkSubject(actor, session.cohortSubjectId);
  }
  return session;
}

/**
 * The roster for this session, and which scope produced it.
 *
 * SUBJECT_WISE sessions use the subject's own enrollment, falling back to
 * the whole cohort when the subject has no per-student rows. The fallback
 * mirrors the recognition engine's `candidateScope` decision exactly (see
 * modules/recognition-engine/service.ts): a non-elective subject legitimately
 * has no StudentSubjectEnrollment rows, and treating that as "nobody is
 * enrolled" would produce an empty register for a full classroom.
 */
export async function resolveSessionRoster(
  session: Pick<AttendanceSession, "cohortId" | "cohortSubjectId">,
  deps: AttendanceReviewDeps = {},
): Promise<{ scope: AttendanceRosterScope; students: AttendanceRosterStudent[] }> {
  const byCohort = deps.listCohortRoster ?? listCohortRoster;
  const bySubject = deps.listCohortSubjectRoster ?? listCohortSubjectRoster;

  if (session.cohortSubjectId) {
    const subjectRoster = await bySubject(session.cohortSubjectId);
    if (subjectRoster.length > 0) {
      return { scope: "cohortSubject", students: subjectRoster };
    }
  }
  return { scope: "cohort", students: await byCohort(session.cohortId) };
}

// ---------------------------------------------------------------------------
// Attendance candidate generation
// ---------------------------------------------------------------------------

export interface GenerateAttendanceCandidatesInput {
  sessionId: string;
  /** Advisory recognition output. Null means recognition did not run (or
   * failed) and the faculty member is opening a manual roll call. */
  recognition: RecognitionRunSummary | null;
}

export interface GenerateAttendanceCandidatesResult {
  sessionId: string;
  rosterScope: AttendanceRosterScope;
  generationSource: AttendanceGenerationSource;
  created: number;
  refreshed: number;
  counts: AttendanceCounts;
}

/**
 * Writes the attendance register for a session: one AttendanceRecord per
 * enrolled student, with the AI advisory attached and `finalResult` seeded
 * from it. Moves the session CAPTURING → PROCESSING → REVIEW.
 *
 * Idempotent. Reprocessing after a retake refreshes the advisory on rows no
 * human has touched and leaves manually corrected rows exactly as they are.
 */
export async function generateAttendanceCandidates(
  actor: SessionUser,
  input: GenerateAttendanceCandidatesInput,
  deps: AttendanceReviewDeps = {},
): Promise<GenerateAttendanceCandidatesResult> {
  requirePermission(actor, "attendanceSession.capture");

  const session = await loadAuthorizedSession(actor, input.sessionId, deps, "write");
  if (session.status === "FINALIZED" || session.status === "CANCELLED") {
    throw new Error(`session_locked:${session.status}`);
  }

  const { scope, students } = await resolveSessionRoster(session, deps);
  if (students.length === 0) throw new Error("empty_roster");

  const recognition = input.recognition;
  const recognitionRan = recognition !== null;

  // Template availability decides whether "absent" is a claim we can make.
  const studentIds = students.map((s) => s.studentId);
  const listComparable = deps.listComparableTemplates ?? listStudentIdsWithComparableTemplates;
  const listAny = deps.listAnyTemplates ?? listStudentIdsWithAnyTemplate;
  const comparable = recognitionRan
    ? new Set(
        await listComparable(studentIds, {
          modelName: recognition.modelName,
          modelVersion: recognition.modelVersion,
        }),
      )
    : new Set<string>();
  // Only queried when it changes the message shown to the reviewer.
  const anyTemplate =
    recognitionRan && comparable.size < studentIds.length
      ? new Set(await listAny(studentIds))
      : new Set<string>();

  const aggregates = new Map(
    (recognition?.perStudent ?? []).map((s) => [s.studentId, s] as const),
  );

  const notes: Record<string, StoredStudentNote> = {};
  const rows = students.map((student) => {
    const decision = decideCandidate({
      aggregate: aggregates.get(student.studentId),
      recognitionRan,
      hasComparableTemplate: comparable.has(student.studentId),
      hasAnyTemplate: anyTemplate.has(student.studentId),
      // "We looked and saw nobody" reads very differently from "we saw people
      // and none was you", so the reviewer is told which happened.
      noFacesDetected: recognitionRan && recognition!.detectedFacesTotal === 0,
    });
    notes[student.studentId] = decision.note;
    return {
      institutionId: session.institutionId,
      sessionId: session.id,
      studentId: student.studentId,
      aiResult: decision.aiResult,
      aiConfidence: decision.aiConfidence,
      matchedEmbeddingId: decision.matchedEmbeddingId,
      finalResult: decision.finalResult,
    };
  });

  // Advance the state machine around the write so a reviewer can never land
  // on a REVIEW session whose register has not been written yet.
  const transition = deps.transitionSessionStatus ?? transitionSessionStatus;
  if (session.status === "CAPTURING") {
    await transition(session.id, "CAPTURING", "PROCESSING");
  }

  const upsert = deps.upsertCandidates ?? upsertAttendanceCandidates;
  const written = await upsert(rows);

  const generationSource: AttendanceGenerationSource = recognitionRan ? "recognition" : "manual";
  const nowFn = deps.now ?? (() => new Date());
  const merge = deps.mergeSessionMetadata ?? mergeSessionMetadata;
  const stored: StoredAttendanceMetadata = {
    rosterScope: scope,
    generationSource,
    generatedAt: nowFn().toISOString(),
    captureImages: recognition ? captureImageMetadataFrom(recognition.perFace) : [],
    recognition: recognition
      ? {
          modelName: recognition.modelName,
          modelVersion: recognition.modelVersion,
          productionEligible: recognition.productionEligible,
          candidateScope: recognition.candidateScope,
          candidatePoolSize: recognition.candidatePoolSize,
          detectedFacesTotal: recognition.detectedFacesTotal,
          scoredFacesTotal: recognition.scoredFacesTotal,
          skippedIncompatibleCandidates: recognition.skippedIncompatibleCandidates,
          presentMin: recognition.policy.presentMin,
          reviewMin: recognition.policy.reviewMin,
        }
      : null,
    studentNotes: notes,
  };
  await merge(session.id, { [ATTENDANCE_METADATA_KEY]: stored });

  const current = await (deps.getSessionById ?? getSessionById)(session.id);
  if (current && current.status === "PROCESSING") {
    await transition(session.id, "PROCESSING", "REVIEW");
  }

  const auditFn = deps.recordAuditLog ?? ((i: RecordAuditLogInput) => defaultRecordAuditLog(i));
  await auditFn({
    action: "attendance.candidates_generated",
    entityType: "AttendanceSession",
    entityId: session.id,
    institutionId: session.institutionId,
    actorUserId: actor.userId,
    afterJson: {
      rosterScope: scope,
      generationSource,
      rosterSize: students.length,
      created: written.created,
      refreshed: written.refreshed,
    },
  });

  const listRecords = deps.listAttendanceRecords ?? listAttendanceRecordRowsForSession;
  const persisted = await listRecords(session.id);

  // `attendance.created` — the register now exists. Sent once per generation
  // with counts rather than one event per student: a class of sixty would
  // otherwise produce sixty deliveries to every subscriber, and the fact a
  // receiver acts on is "this session has a register, come and read it".
  // Deliberately not a finalization: the session is in REVIEW, nothing here is
  // a confirmed result, and `sessionStatus` says so on the wire.
  emitAttendanceWebhook(
    deps,
    session.institutionId,
    "attendance.created",
    session.id,
    (deps.now ?? (() => new Date()))().toISOString(),
    {
      sessionId: session.id,
      cohortId: session.cohortId,
      subjectLinkId: session.cohortSubjectId,
      sessionDate: session.sessionDate.toISOString(),
      sessionStatus: "REVIEW",
      rosterScope: scope,
      generationSource,
      counts: countAttendance(persisted),
    },
  );

  return {
    sessionId: session.id,
    rosterScope: scope,
    generationSource,
    created: written.created,
    refreshed: written.refreshed,
    counts: countAttendance(persisted),
  };
}

// ---------------------------------------------------------------------------
// Review board
// ---------------------------------------------------------------------------

function reasonForStoredRow(
  row: AttendanceRecordRow,
  note: StoredStudentNote | undefined,
): AttendanceReviewReason {
  if (row.isManuallyCorrected) return "manually_corrected";
  return note?.reason ?? null;
}

export async function getAttendanceReviewBoard(
  actor: SessionUser,
  sessionId: string,
  deps: AttendanceReviewDeps = {},
): Promise<AttendanceReviewBoard> {
  requirePermission(actor, "attendanceRecord.read");

  const session = await loadAuthorizedSession(actor, sessionId, deps);

  const getDetail = deps.getSessionDetailRow ?? getSessionDetailRow;
  const detailRow = await getDetail(sessionId);
  if (!detailRow) throw new Error("session_not_found");

  const stored = readStoredMetadata(detailRow.metadata);
  const { students } = await resolveSessionRoster(session, deps);
  const rosterById = new Map(students.map((s) => [s.studentId, s] as const));

  const listRecords = deps.listAttendanceRecords ?? listAttendanceRecordRowsForSession;
  const records = await listRecords(sessionId);

  const notes = stored.studentNotes ?? {};
  const rows: AttendanceReviewStudent[] = records.map((record) => {
    const rosterEntry = rosterById.get(record.studentId);
    const note = notes[record.studentId];
    return {
      studentId: record.studentId,
      attendanceRecordId: record.id,
      // A record whose student has since been unenrolled still belongs on
      // this register — the attendance happened. Fall back to the id rather
      // than dropping the row.
      studentCode: rosterEntry?.studentCode ?? record.studentId,
      firstName: rosterEntry?.firstName ?? "Unknown",
      lastName: rosterEntry?.lastName ?? "student",
      initials: initialsFor(rosterEntry?.firstName ?? "?", rosterEntry?.lastName ?? ""),
      photoUrl: null,
      aiResult: record.aiResult,
      aiConfidence: record.aiConfidence,
      finalResult: record.finalResult,
      isManuallyCorrected: record.isManuallyCorrected,
      reason: reasonForStoredRow(record, note),
      aiSuggestion: note?.aiSuggestion ?? null,
      wasComparable: note?.wasComparable ?? false,
      wasAmbiguous: note?.wasAmbiguous ?? false,
      bestFaceId: note?.bestFaceId ?? null,
    };
  });

  const byName = (a: AttendanceReviewStudent, b: AttendanceReviewStudent) =>
    a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName);

  /**
   * Three columns, and the Present one has two kinds of row in it.
   *
   *   Present   = confirmed by a person, plus the model's unconfirmed
   *               suggestions, which are shown here because that is where a
   *               reviewer looks for them — but labelled as proposals and
   *               still carrying `finalResult: NEEDS_REVIEW`.
   *   Needs review = unresolved with no suggestion. These are the rows that
   *               genuinely need somebody to decide, and the ones that block
   *               finalization.
   *   Absent    = only ever set by a person.
   */
  const isUnresolved = (r: AttendanceReviewStudent) =>
    r.finalResult === "NEEDS_REVIEW" || r.finalResult === "NOT_EVALUATED";
  const isSuggestedPresent = (r: AttendanceReviewStudent) =>
    isUnresolved(r) && r.aiSuggestion === "PRESENT" && !r.isManuallyCorrected;

  const present = rows
    .filter((r) => r.finalResult === "PRESENT" || isSuggestedPresent(r))
    .sort(byName);
  const absent = rows.filter((r) => r.finalResult === "ABSENT").sort(byName);
  const needsReview = rows.filter((r) => isUnresolved(r) && !isSuggestedPresent(r)).sort(byName);

  const counts = countAttendance(records);
  // What actually blocks confirmation: unresolved rows the model made no
  // proposal about. A suggested-present row is resolved BY confirming the
  // register — that act is the faculty decision, and it is recorded as one.
  const awaitingDecision = needsReview.length;
  const awaitingConfirmation = present.filter((r) => r.finalResult !== "PRESENT").length;

  let finalizeBlockedReason: string | null = null;
  if (counts.total === 0) {
    finalizeBlockedReason = "No attendance candidates have been generated for this session yet.";
  } else if (awaitingDecision > 0) {
    finalizeBlockedReason = `${awaitingDecision} student${awaitingDecision === 1 ? "" : "s"} still need${
      awaitingDecision === 1 ? "s" : ""
    } review. Resolve each one as present or absent before confirming.`;
  } else if (session.status !== "REVIEW") {
    finalizeBlockedReason =
      session.status === "FINALIZED"
        ? "This attendance has already been finalized."
        : `Session is ${session.status.toLowerCase()} — attendance can only be confirmed from review.`;
  }

  const getInstitution = deps.getInstitutionById ?? getInstitutionById;
  const institution = await getInstitution(session.institutionId);
  const attendanceMode = institution ? resolveAttendanceMode(institution) : "DAILY";
  const institutionName = institution?.name ?? "";

  const getName = deps.getUserNameById ?? getUserNameById;
  const finalizedByUserId = stored.finalizedByUserId ?? null;
  const finalizedByName = finalizedByUserId ? await getName(finalizedByUserId) : null;

  const detail: AttendanceSessionDetail = {
    id: detailRow.id,
    institutionId: detailRow.institutionId,
    institutionName,
    academicSessionId: detailRow.cohort?.academicSessionId ?? null,
    academicSessionName: detailRow.cohort?.academicSession?.name ?? null,
    cohortId: detailRow.cohortId,
    cohortName: detailRow.cohort?.name ?? "",
    cohortTermLabel: detailRow.cohort?.termLabel ?? null,
    attendanceMode,
    cohortSubjectId: detailRow.cohortSubjectId,
    subjectName: detailRow.cohortSubject?.subject?.name ?? null,
    subjectCode: detailRow.cohortSubject?.subject?.code ?? null,
    facultyUserId: detailRow.facultyId,
    facultyName: detailRow.faculty?.name ?? null,
    sessionDate: detailRow.sessionDate.toISOString(),
    startedAt: detailRow.startedAt.toISOString(),
    endedAt: detailRow.endedAt?.toISOString() ?? null,
    processingStatus: detailRow.status,
    rosterScope: stored.rosterScope ?? "cohort",
    generationSource: stored.generationSource ?? null,
    captureImages: stored.captureImages ?? [],
    recognition: stored.recognition ?? null,
    finalizedByUserId,
    finalizedByName,
    finalizedAt: stored.finalizedAt ?? null,
  };

  return {
    session: detail,
    counts,
    present,
    absent,
    needsReview,
    canFinalize: finalizeBlockedReason === null,
    finalizeBlockedReason,
    /** Rows the model proposed as present that confirming will turn into a
     * real PRESENT. Shown on the confirm dialog so nobody accepts a batch of
     * machine output without being told how much of it there is. */
    awaitingConfirmation,
    awaitingDecision,
    actorCanFinalize: hasPermission(actor, "attendanceSession.finalize"),
    actorCanOverrideFinalized: hasPermission(actor, "attendanceSession.finalize"),
  };
}

// ---------------------------------------------------------------------------
// Faculty correction
// ---------------------------------------------------------------------------

/**
 * Applies one faculty decision — Mark Present, Mark Absent, or the
 * Present/Absent choice behind Verify on a Needs Review row.
 *
 * Delegates the write to `modules/attendance/service.ts#correctAttendanceRecord`,
 * which is the only code path allowed to touch `finalResult` and always
 * appends an `AttendanceCorrection` row (student, session, previous status,
 * new status, actor, timestamp, optional reason). `aiResult`/`aiConfidence`
 * are never written here: the original AI result survives every correction.
 *
 * After FINALIZED, a correction is still possible but requires
 * `attendanceSession.finalize` — whoever may close a register may reopen a
 * line in it — and is recorded as an ADMIN_OVERRIDE rather than a routine
 * review.
 */
export async function applyReviewDecision(
  actor: SessionUser,
  input: ReviewDecisionInput,
  deps: AttendanceReviewDeps = {},
): Promise<ReviewDecisionResult> {
  requirePermission(actor, "attendanceRecord.correct");

  const listRecords = deps.listAttendanceRecords ?? listAttendanceRecordRowsForSession;
  const correct = deps.correctAttendanceRecord ?? correctAttendanceRecordDefault;

  // The record identifies the session; the session identifies what the
  // caller must be allowed to touch. Never trust a client-supplied session.
  const getRecord = deps.getAttendanceRecordById ?? getAttendanceRecordByIdDefault;
  const existing = await getRecord(input.attendanceRecordId);
  if (!existing) throw new Error("attendance_record_not_found");

  const session = await loadAuthorizedSession(actor, existing.sessionId, deps, "write");

  if (session.status === "CANCELLED") {
    throw new Error("session_cancelled");
  }
  const isPostFinalization = session.status === "FINALIZED";
  if (isPostFinalization && !hasPermission(actor, "attendanceSession.finalize")) {
    throw new ForbiddenError("attendance_finalized");
  }
  if (!isPostFinalization && session.status !== "REVIEW" && session.status !== "PROCESSING") {
    throw new Error(`invalid_session_status:${session.status}`);
  }

  // The institution's own correction rules, and only on the post-finalization
  // branch. A register still in REVIEW is being worked on: putting a deadline
  // or a paperwork requirement on that would let the clock, rather than the
  // reviewer, decide what a NEEDS_REVIEW row becomes — which is the one
  // outcome this module exists to prevent. Changing a *closed* register is the
  // rare, consequential event institutions actually want to govern.
  //
  // Both settings default to off, so an institution that has configured
  // nothing sees exactly the behaviour of every build before this check.
  if (isPostFinalization) {
    const policy = await loadAttendancePolicy(session.institutionId, deps);
    const now = (deps.now ?? (() => new Date()))();
    if (!correctionWindowOpen(policy, session.endedAt ?? null, now)) {
      throw new ForbiddenError(`correction_window_closed:${policy.correctionWindowDays}`);
    }
    if (policy.requireReasonAfterFinalization && String(input.reason ?? "").trim() === "") {
      throw new Error("correction_reason_required");
    }
  }

  if (existing.finalResult === input.newResult) {
    // No-op: writing an AttendanceCorrection whose previous and new result
    // are identical would pollute the audit trail with non-events.
    const rows = await listRecords(existing.sessionId);
    return {
      record: {
        id: existing.id,
        sessionId: existing.sessionId,
        studentId: existing.studentId,
        aiResult: existing.aiResult,
        aiConfidence: existing.aiConfidence,
        finalResult: existing.finalResult,
        isManuallyCorrected: existing.isManuallyCorrected,
      },
      counts: countAttendance(rows),
    };
  }

  const updated = await correct({
    attendanceRecordId: input.attendanceRecordId,
    newResult: input.newResult,
    changedByUserId: actor.userId,
    source: isPostFinalization ? "ADMIN_OVERRIDE" : "FACULTY_REVIEW",
    reason: input.reason,
    // The no-op check above read `existing.finalResult`; this makes the write
    // conditional on it still being true. A double-clicked button or two
    // devices on the same row then produce one correction, not two.
    onlyIfCurrentResultIn: [existing.finalResult],
  });

  const rows = await listRecords(existing.sessionId);
  const counts = countAttendance(rows);

  const publisher = deps.publisher ?? attendanceEventPublisher;
  const occurredAt = (deps.now ?? (() => new Date()))().toISOString();
  const record = {
    id: updated.id,
    sessionId: updated.sessionId,
    studentId: updated.studentId,
    aiResult: updated.aiResult,
    aiConfidence: updated.aiConfidence,
    finalResult: updated.finalResult,
    isManuallyCorrected: updated.isManuallyCorrected,
  };
  publisher.publish({
    type: "attendance-record-updated",
    sessionId: updated.sessionId,
    record,
    counts,
    occurredAt,
  });
  // The student's own channel gets only their own result.
  publisher.publishToStudent(updated.studentId, {
    type: "student-attendance-updated",
    sessionId: updated.sessionId,
    studentId: updated.studentId,
    finalResult: updated.finalResult,
    isFinalized: isPostFinalization,
    occurredAt,
  });

  // `attendance.corrected` — a human changed a result. Most-specific event
  // wins: this is not also emitted as `attendance.updated`, which would
  // deliver the same change twice to an endpoint subscribed to both.
  emitAttendanceWebhook(deps, session.institutionId, "attendance.corrected", updated.id, occurredAt, {
    id: updated.id,
    sessionId: updated.sessionId,
    studentId: updated.studentId,
    previousResult: existing.finalResult,
    result: updated.finalResult,
    isManuallyCorrected: updated.isManuallyCorrected,
    correctedByUserId: actor.userId,
    afterFinalization: isPostFinalization,
    reason: input.reason ?? null,
  });

  return { record, counts };
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

export interface ConfirmAttendanceResult {
  sessionId: string;
  counts: AttendanceCounts;
  finalizedAt: string;
  finalizedByUserId: string;
}

/**
 * The unresolved rows the model proposed as present.
 *
 * Read from the session's stored notes rather than inferred from
 * `aiResult`, because `aiResult` survives a manual correction: a student the
 * model matched and a teacher then marked absent still has `aiResult:
 * PRESENT`, and must not be swept back to present by confirming.
 */
async function resolveSuggestedRows(
  sessionId: string,
  rows: AttendanceRecordRow[],
  deps: AttendanceReviewDeps,
): Promise<AttendanceRecordRow[]> {
  const getDetail = deps.getSessionDetailRow ?? getSessionDetailRow;
  const detail = await getDetail(sessionId);
  const notes = readStoredMetadata(detail?.metadata).studentNotes ?? {};
  return rows.filter(
    (row) =>
      !row.isManuallyCorrected &&
      (row.finalResult === "NEEDS_REVIEW" || row.finalResult === "NOT_EVALUATED") &&
      notes[row.studentId]?.aiSuggestion === "PRESENT",
  );
}

/**
 * "Confirm Attendance". Closes the register.
 *
 * Two things happen, in this order: every outstanding recognition suggestion
 * is accepted as this actor's decision, and then the session is finalized.
 *
 * The unresolved-state guard lives in `modules/sessions/service.ts` so that
 * every finalization path — this one and any future API/admin path — is
 * blocked by the same check: an unresolved NEEDS_REVIEW must never become
 * PRESENT (or anything else) by omission. Accepting the suggestions first is
 * what clears the only rows allowed to reach that guard unresolved.
 *
 * The permission is checked here as well as inside `finalizeAttendanceSession`
 * because the suggestion-acceptance loop writes before finalization is
 * reached; without it, a caller who may not close a register could still have
 * caused those writes before being refused.
 */
export async function confirmAttendance(
  actor: SessionUser,
  sessionId: string,
  deps: AttendanceReviewDeps = {},
): Promise<ConfirmAttendanceResult> {
  requirePermission(actor, "attendanceSession.finalize");
  const session = await loadAuthorizedSession(actor, sessionId, deps, "write");

  const listRecords = deps.listAttendanceRecords ?? listAttendanceRecordRowsForSession;
  const correct = deps.correctAttendanceRecord ?? correctAttendanceRecordDefault;

  /**
   * Confirming the register IS the faculty decision on every suggestion in it.
   *
   * The model proposed these students as present and the register recorded
   * them as unresolved. Pressing Confirm accepts those proposals — so each one
   * is written through the same correction path a per-student Mark Present
   * uses, which means each gets an `AttendanceCorrection` row naming this
   * actor, this timestamp and the previous state.
   *
   * Doing it this way rather than flipping the rows in bulk matters for one
   * reason: months later, "who decided this student was present?" has the same
   * answer whether the teacher clicked the row or clicked Confirm. A bulk
   * update would have left the machine's suggestion looking like a fact
   * nobody signed.
   *
   * Rows a person already touched are skipped — an explicit decision outranks
   * a suggestion, and re-confirming would overwrite it.
   */
  const beforeConfirm = await listRecords(sessionId);
  const suggestionsToConfirm = await resolveSuggestedRows(sessionId, beforeConfirm, deps);
  for (const row of suggestionsToConfirm) {
    await correct({
      attendanceRecordId: row.id,
      newResult: "PRESENT",
      changedByUserId: actor.userId,
      source: "FACULTY_REVIEW",
      reason: "Confirmed with the register",
      // Two teachers pressing Confirm at the same moment must not both record
      // a decision on the same student.
      onlyIfCurrentResultIn: ["NEEDS_REVIEW", "NOT_EVALUATED"],
    });
  }

  const records = await listRecords(sessionId);
  const counts = countAttendance(records);

  const finalize = deps.finalizeAttendanceSession ?? finalizeAttendanceSessionDefault;
  const finalizedAtDate = (deps.now ?? (() => new Date()))();
  await finalize(actor, sessionId, {
    listAttendanceRecords: async () => records,
    now: () => finalizedAtDate,
  });

  const finalizedAt = finalizedAtDate.toISOString();
  const merge = deps.mergeSessionMetadata ?? mergeSessionMetadata;
  const getDetail = deps.getSessionDetailRow ?? getSessionDetailRow;
  const detail = await getDetail(sessionId);
  const stored = readStoredMetadata(detail?.metadata);
  await merge(sessionId, {
    [ATTENDANCE_METADATA_KEY]: {
      ...stored,
      finalizedByUserId: actor.userId,
      finalizedAt,
    },
  });

  const publisher = deps.publisher ?? attendanceEventPublisher;
  publisher.publish({
    type: "attendance-session-finalized",
    sessionId,
    counts,
    finalizedByUserId: actor.userId,
    finalizedAt,
    occurredAt: finalizedAt,
  });
  // Fan out to each student's private channel: their result just became
  // visible in the portal, and that is the moment they should see it.
  for (const record of records) {
    publisher.publishToStudent(record.studentId, {
      type: "student-attendance-updated",
      sessionId,
      studentId: record.studentId,
      finalResult: record.finalResult,
      isFinalized: true,
      occurredAt: finalizedAt,
    });
  }

  // `attendance.finalized` — the register is closed and is now the record of
  // fact. This is the event an ERP should write to its own attendance table
  // from; `attendance.created` is only a heads-up that review has begun.
  //
  // `finalizeAttendanceSession` refuses to close a session with an unresolved
  // NEEDS_REVIEW (modules/sessions/service.ts), so by the time this line runs
  // there is no uncertainty being published as a decision — and the counts
  // below still carry `needsReview` explicitly rather than folding it away.
  emitAttendanceWebhook(deps, session.institutionId, "attendance.finalized", sessionId, finalizedAt, {
    sessionId,
    cohortId: session.cohortId,
    subjectLinkId: session.cohortSubjectId,
    sessionDate: session.sessionDate.toISOString(),
    sessionStatus: "FINALIZED",
    finalizedAt,
    finalizedByUserId: actor.userId,
    counts,
    records: records.map((record) => ({
      studentId: record.studentId,
      result: record.finalResult,
      isManuallyCorrected: record.isManuallyCorrected,
    })),
  });

  return { sessionId, counts, finalizedAt, finalizedByUserId: actor.userId };
}

// ---------------------------------------------------------------------------
// Student portal
// ---------------------------------------------------------------------------

export interface StudentAttendanceDeps {
  getStudentByUserId?: typeof getStudentByUserId;
  listFinalizedAttendanceForStudent?: typeof listFinalizedAttendanceForStudent;
}

/**
 * The caller's own attendance, and only their own.
 *
 * There is no `studentId` parameter by design: the student is resolved from
 * the server session, so this function structurally cannot be pointed at
 * somebody else's record. Only FINALIZED sessions are returned — a register
 * still in review is a draft, and a student should not be told they were
 * absent from a class the teacher has not confirmed yet.
 */
export async function getOwnAttendance(
  actor: SessionUser,
  deps: StudentAttendanceDeps = {},
): Promise<StudentAttendanceView | null> {
  requirePermission(actor, "attendanceRecord.read.own");

  const findStudent = deps.getStudentByUserId ?? getStudentByUserId;
  const student = await findStudent(actor.userId);
  if (!student) return null;

  const listForStudent =
    deps.listFinalizedAttendanceForStudent ?? listFinalizedAttendanceForStudent;
  const rows = await listForStudent(student.id);

  const entries: StudentAttendanceEntry[] = rows.map((row) => ({
    attendanceRecordId: row.id,
    sessionId: row.session.id,
    sessionDate: row.session.sessionDate.toISOString(),
    finalizedAt: row.session.endedAt?.toISOString() ?? null,
    cohortName: row.session.cohort?.name ?? "",
    subjectName: row.session.cohortSubject?.subject?.name ?? null,
    subjectCode: row.session.cohortSubject?.subject?.code ?? null,
    finalResult: row.finalResult,
    isManuallyCorrected: row.isManuallyCorrected,
  }));

  return {
    studentId: student.id,
    studentCode: student.studentCode,
    fullName: `${student.firstName} ${student.lastName}`,
    entries,
    presentCount: entries.filter((e) => e.finalResult === "PRESENT").length,
    absentCount: entries.filter((e) => e.finalResult === "ABSENT").length,
  };
}
