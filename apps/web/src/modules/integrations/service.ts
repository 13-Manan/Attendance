import { recordAuditLog } from "@/modules/audit/service";
import { ApiError, invalidRequest, notFound, type ApiContext } from "./api-route";
import * as externalIdentity from "./external-identity";
import { buildPage, readPageRequest, type PageRequest } from "./pagination";
import { WebhookProvider } from "./providers/webhook-provider";
import { redact } from "./redaction";
import { attendanceEventPublisher } from "@/modules/realtime/publisher";
import * as repo from "./repository";
import { buildEnvelope } from "./webhook-delivery";
import { emitWebhookEvent } from "./webhook-dispatcher";
import { generateSigningSecret } from "./webhook-signature";
import type { ApiItemResponse, ApiListResponse, WebhookEvent } from "./types";

/**
 * Orchestration for the public `/api/v1/*` surface.
 *
 * ## Why this is not `students/service.ts`
 *
 * The domain services take a `SessionUser` and call `requirePermission`. That
 * is correct for them and unusable here: an API key is not a user, has no
 * roles, and must be authorized by *scope* instead. Threading a fake
 * `SessionUser` through the existing services to satisfy their signatures
 * would be the worst of both — a synthetic principal in the audit trail, and a
 * permission check that no longer means what it says.
 *
 * So authorization is split by surface and each half is honest about itself:
 * scopes are enforced in `api-route.ts` before a handler runs, and the audit
 * rows written here carry `actorApiKeyId` with `actorUserId` left null,
 * because no user did this.
 *
 * ## The serializers are the API contract
 *
 * Every function named `serialize*` below defines what leaves the building.
 * They are explicit field lists rather than spreads of Prisma rows, which is
 * the only version of this that stays safe: a `...row` means the next column
 * added to the schema is published to every integrator automatically, and the
 * column after that is the one that should not have been.
 *
 * Nothing here serializes a face embedding, an image URL, a confidence score,
 * a password hash or a webhook secret. `repository.ts` does not even select
 * most of them.
 */

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

/**
 * A date filter that refuses to guess.
 *
 * `new Date("last tuesday")` is `Invalid Date`, and an invalid date silently
 * dropped from a `where` clause turns "give me March" into "give me
 * everything" — a client that asked for one month and got the whole year will
 * happily import all of it. Rejecting is the only safe reading.
 */
function readDate(url: URL, name: string): Date | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw invalidRequest(`\`${name}\` must be an ISO 8601 date, e.g. 2026-03-01 or 2026-03-01T09:00:00Z.`);
  }
  return parsed;
}

function readEnum<T extends string>(url: URL, name: string, allowed: readonly T[]): T | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = raw.trim().toUpperCase() as T;
  if (!allowed.includes(value)) {
    throw invalidRequest(`\`${name}\` must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function readId(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const value = raw.trim();
  // The same shape `decodeCursor` accepts. A filter value is interpolated into
  // a Prisma query — parameterized, so not an injection risk — but an
  // unbounded string here becomes an unbounded string in a log line.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw invalidRequest(`\`${name}\` is not a valid identifier.`);
  }
  return value;
}

const ENROLLMENT_STATUSES = ["ACTIVE", "INACTIVE", "TRANSFERRED", "COMPLETED"] as const;
const ATTENDANCE_RESULTS = ["PRESENT", "ABSENT", "NEEDS_REVIEW", "NOT_EVALUATED"] as const;
const SESSION_STATUSES = ["OPEN", "CAPTURING", "PROCESSING", "REVIEW", "FINALIZED", "CANCELLED"] as const;

/**
 * `?updatedSince=` is the incremental-sync contract for every list endpoint.
 *
 * Named on the query string rather than inferred from a stored watermark
 * because the client owns its own progress. A server-side watermark would
 * break the moment two of an ERP's workers poll with the same key.
 */
function readUpdatedSince(url: URL): Date | undefined {
  return readDate(url, "updatedSince");
}

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** 256KB. Generous for a single-resource write, small enough not to be a lever. */
const MAX_BODY_BYTES = 256 * 1024;

export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_BODY_BYTES) {
    throw new ApiError("payload_too_large", `Request body must be under ${MAX_BODY_BYTES / 1024}KB.`);
  }

  const text = await request.text();
  // Checked again after reading: `Content-Length` is a claim, not a fact, and
  // a chunked request has none at all.
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError("payload_too_large", `Request body must be under ${MAX_BODY_BYTES / 1024}KB.`);
  }
  if (text.trim() === "") throw invalidRequest("A JSON request body is required.");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // The parser's own message quotes the offending input, which is how a
    // secret in a malformed body ends up in an error response.
    throw invalidRequest("Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidRequest("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, field: string, maxLength = 255): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidRequest(`\`${field}\` is required and must be a non-empty string.`);
  }
  if (value.length > maxLength) {
    throw invalidRequest(`\`${field}\` must be at most ${maxLength} characters.`);
  }
  return value.trim();
}

function optionalString(body: Record<string, unknown>, field: string, maxLength = 255): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return "";
  if (typeof value !== "string") throw invalidRequest(`\`${field}\` must be a string or null.`);
  if (value.length > maxLength) throw invalidRequest(`\`${field}\` must be at most ${maxLength} characters.`);
  return value.trim();
}

function optionalEnum<T extends string>(
  body: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !allowed.includes(value.toUpperCase() as T)) {
    throw invalidRequest(`\`${field}\` must be one of: ${allowed.join(", ")}.`);
  }
  return value.toUpperCase() as T;
}

/**
 * Splits a single `name` field into the two columns the schema has.
 *
 * Last space wins, because "Ravi Kumar Sharma" is a given name and a
 * two-part surname far more often than the reverse in the institutions this
 * serves. A single-word name becomes the first name with an empty last name
 * rather than being rejected — mononyms exist, and a roster import must not
 * fail on one.
 */
export function splitName(full: string): { firstName: string; lastName: string } {
  const trimmed = full.trim().replace(/\s+/g, " ");
  const cut = trimmed.lastIndexOf(" ");
  if (cut === -1) return { firstName: trimmed, lastName: "" };
  return { firstName: trimmed.slice(0, cut), lastName: trimmed.slice(cut + 1) };
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

export interface ApiStudent {
  id: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  status: string;
  cohortIds: string[];
  createdAt: string;
  updatedAt: string;
}

export function serializeStudent(row: repo.ApiStudentRow): ApiStudent {
  return {
    id: row.id,
    studentCode: row.studentCode,
    firstName: row.firstName,
    lastName: row.lastName,
    // Provided because the field mapping's `student.name` is one column in
    // every export we have seen, and making each integrator re-join two
    // fields is how "R. Sharma" and "R.Sharma" both end up in a CSV.
    fullName: [row.firstName, row.lastName].filter(Boolean).join(" "),
    email: row.email,
    phone: row.phone,
    status: row.status,
    cohortIds: row.enrollments.filter((e) => e.status === "ACTIVE").map((e) => e.cohortId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export interface ApiClass {
  id: string;
  name: string;
  termLabel: string | null;
  academicUnit: { id: string; name: string; code: string | null; kind: string };
  academicSession: { id: string; name: string };
  enrolledCount: number;
  createdAt: string;
}

export function serializeClass(row: repo.ApiCohortRow): ApiClass {
  return {
    id: row.id,
    name: row.name,
    termLabel: row.termLabel,
    academicUnit: {
      id: row.academicUnit.id,
      name: row.academicUnit.name,
      code: row.academicUnit.code,
      kind: row.academicUnit.kind,
    },
    academicSession: { id: row.academicSession.id, name: row.academicSession.name },
    enrolledCount: row._count.enrollments,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ApiAcademicUnit {
  id: string;
  kind: string;
  name: string;
  code: string | null;
  parentId: string | null;
  campusId: string | null;
  sortOrder: number;
  createdAt: string;
}

export function serializeAcademicUnit(row: repo.ApiAcademicUnitRow): ApiAcademicUnit {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    code: row.code,
    parentId: row.parentId,
    campusId: row.campusId,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeSubject(row: repo.ApiSubjectRow) {
  return { id: row.id, code: row.code, name: row.name, createdAt: row.createdAt.toISOString() };
}

/**
 * Faculty carry a work email and an employee code and nothing else.
 *
 * No `lastLoginAt`: when a teacher last signed in is a fact about a person's
 * working hours, and an integration asking for a roster has no use for it.
 */
export function serializeFaculty(row: repo.ApiFacultyRow) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    employeeCode: row.employeeCode,
    status: row.status,
    campusId: row.campusId,
    createdAt: row.createdAt.toISOString(),
  };
}

export function serializeEnrollment(row: repo.ApiEnrollmentRow) {
  return {
    id: row.id,
    studentId: row.studentId,
    studentCode: row.student.studentCode,
    cohortId: row.cohortId,
    status: row.status,
    enrolledAt: row.enrolledAt.toISOString(),
    unenrolledAt: row.unenrolledAt ? row.unenrolledAt.toISOString() : null,
  };
}

export interface ApiAttendanceRecord {
  id: string;
  sessionId: string;
  studentId: string;
  studentCode: string;
  cohortId: string;
  subjectLinkId: string | null;
  sessionDate: string;
  sessionStatus: string;
  result: string;
  isManuallyCorrected: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * `result` is `finalResult` and only ever `finalResult`.
 *
 * The AI's own guess is not published under any name. Two reasons, and the
 * second is the one that matters: a confidence score is an inference drawn
 * from a biometric template, and exporting it exports the biometric data's
 * shadow. But also — the product's rule is that the model is advisory and the
 * human is authoritative, and an API that offered both would let an
 * integrator choose the model's answer over the teacher's.
 *
 * `sessionStatus` travels with the record so a receiver can tell a finalized
 * register from a session still under review. A `NEEDS_REVIEW` result stays
 * `NEEDS_REVIEW` on the wire; nothing here maps it to present or absent.
 */
export function serializeAttendanceRecord(row: repo.ApiAttendanceRow): ApiAttendanceRecord {
  return {
    id: row.id,
    sessionId: row.sessionId,
    studentId: row.studentId,
    studentCode: row.student.studentCode,
    cohortId: row.session.cohortId,
    subjectLinkId: row.session.cohortSubjectId,
    sessionDate: row.session.sessionDate.toISOString(),
    sessionStatus: row.session.status,
    result: row.finalResult,
    isManuallyCorrected: row.isManuallyCorrected,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function serializeSession(row: repo.ApiSessionRow) {
  return {
    id: row.id,
    cohortId: row.cohortId,
    subjectLinkId: row.cohortSubjectId,
    facultyId: row.facultyId,
    sessionDate: row.sessionDate.toISOString(),
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    status: row.status,
    recordCount: row._count.attendanceRecords,
  };
}

export function serializeWebhookEndpoint(row: repo.ApiWebhookRow) {
  return {
    id: row.id,
    url: row.url,
    eventTypes: row.eventTypes,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/**
 * A domain audit row for a write made by an API key.
 *
 * This is *in addition to* the `api.resource.written` row `api-route.ts`
 * writes for every mutation. They answer different questions: the wrapper's
 * row answers "what did this key call", this one answers "what happened to
 * this student", and the second is the one an administrator searches for by
 * entity id. `actorUserId` is deliberately left null — inventing a user for an
 * integration's action would make the audit trail lie in the one place it must
 * not.
 */
async function auditApiWrite(
  ctx: ApiContext,
  action: Parameters<typeof recordAuditLog>[0]["action"],
  entityType: string,
  entityId: string,
  payload: { before?: unknown; after?: unknown },
): Promise<void> {
  await recordAuditLog({
    action,
    entityType,
    entityId,
    institutionId: ctx.institutionId,
    actorApiKeyId: ctx.apiKey.apiKeyId,
    actorUserId: null,
    beforeJson: payload.before === undefined ? undefined : redact(payload.before),
    afterJson: redact({
      ...(payload.after === undefined ? {} : { after: payload.after }),
      requestId: ctx.requestId,
      apiKeyName: ctx.apiKey.name ?? null,
      idempotencyKey: ctx.idempotencyKey,
    }),
  });
}

/**
 * Fire-and-forget by design, and the one call site that is allowed to be.
 *
 * `emitWebhookEvent` already swallows and logs its own failures; this wrapper
 * exists so the call sites read as one line and so the reason is written down
 * once: a webhook receiver being unreachable must never turn a successful
 * write into a 500 for the client that made it. The write is committed; the
 * notification is best-effort and has its own retry ladder.
 */
function emit<T>(institutionId: string, type: WebhookEvent, subjectId: string, occurredAt: string, data: T): void {
  emitWebhookEvent(buildEnvelope(institutionId, type, subjectId, occurredAt, data));
}

// ---------------------------------------------------------------------------
// Read endpoints
// ---------------------------------------------------------------------------

function page(ctx: ApiContext): PageRequest {
  return readPageRequest(ctx.url);
}

export async function listStudentsEndpoint(ctx: ApiContext): Promise<ApiListResponse<ApiStudent>> {
  const request = page(ctx);
  const rows = await repo.listStudents(ctx.institutionId, request, {
    status: readEnum(ctx.url, "status", ENROLLMENT_STATUSES),
    cohortId: readId(ctx.url, "cohortId"),
    studentCode: ctx.url.searchParams.get("studentCode")?.trim() || undefined,
    updatedSince: readUpdatedSince(ctx.url),
  });
  return buildPage(rows.map(serializeStudent), request, ctx.requestId);
}

/**
 * Resolves the `{id}` path segment, which may be an external id.
 *
 * `external:<provider>:<id>` addresses a record by what another system calls
 * it — `external:erp-x:STU-10092` — so an ERP can use its own identifiers
 * without first storing ours. Anything else is taken as this platform's id,
 * unchanged, so existing integrations are unaffected.
 *
 * The prefix is a deliberate opt-in rather than a guess. Trying an id as
 * internal and then falling back to external would make the meaning of a
 * request depend on what happens to exist, and a caller could learn which
 * internal ids are real by watching which lookups changed behaviour.
 *
 * Splitting on the *first two* colons only: an external id may itself contain
 * colons, and truncating somebody's identifier at a separator we chose would
 * silently resolve to the wrong record or to nothing.
 */
const EXTERNAL_ID_PREFIX = "external:";

async function resolveEntityId(
  ctx: ApiContext,
  entityType: externalIdentity.ExternalEntityType,
  raw: string,
): Promise<string | null> {
  if (!raw.startsWith(EXTERNAL_ID_PREFIX)) return raw;
  const rest = raw.slice(EXTERNAL_ID_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator <= 0 || separator === rest.length - 1) {
    throw invalidRequest(
      "An external reference must look like `external:<provider>:<id>`.",
    );
  }
  return externalIdentity.resolveExternalId(ctx.institutionId, {
    provider: rest.slice(0, separator),
    entityType,
    externalId: rest.slice(separator + 1),
  });
}

export async function getStudentEndpoint(ctx: ApiContext): Promise<ApiItemResponse<ApiStudent>> {
  const id = await resolveEntityId(ctx, "STUDENT", requireParam(ctx, "id"));
  // An unmapped external id and a nonexistent student are the same answer, so
  // this cannot be used to discover which ids another provider has mapped.
  if (!id) throw notFound("Student");
  const row = await repo.getStudent(ctx.institutionId, id);
  if (!row) throw notFound("Student");
  return { data: serializeStudent(row), requestId: ctx.requestId };
}

export async function listClassesEndpoint(ctx: ApiContext): Promise<ApiListResponse<ApiClass>> {
  const request = page(ctx);
  const rows = await repo.listCohorts(ctx.institutionId, request);
  return buildPage(rows.map(serializeClass), request, ctx.requestId);
}

export async function getClassEndpoint(ctx: ApiContext): Promise<ApiItemResponse<ApiClass>> {
  const row = await repo.getCohort(ctx.institutionId, requireParam(ctx, "id"));
  if (!row) throw notFound("Class");
  return { data: serializeClass(row), requestId: ctx.requestId };
}

/**
 * Sections and programs are two views of `AcademicUnit`.
 *
 * SECTION is a section everywhere. A "program" is whatever sits above it —
 * a department, a grade, a semester, a course — because a school and a
 * college disagree about the word and the schema deliberately does not take a
 * side (see the note above `AcademicUnit` in schema.prisma). GENERIC is
 * included in programs rather than dropped: an institution that has not
 * classified a unit still needs it to appear somewhere.
 */
const SECTION_KINDS = ["SECTION"] as const;
const PROGRAM_KINDS = ["DEPARTMENT", "GRADE", "SEMESTER", "COURSE", "GENERIC"] as const;

export async function listSectionsEndpoint(ctx: ApiContext): Promise<ApiListResponse<ApiAcademicUnit>> {
  const request = page(ctx);
  const rows = await repo.listAcademicUnits(ctx.institutionId, request, [...SECTION_KINDS]);
  return buildPage(rows.map(serializeAcademicUnit), request, ctx.requestId);
}

export async function getSectionEndpoint(ctx: ApiContext): Promise<ApiItemResponse<ApiAcademicUnit>> {
  const row = await repo.getAcademicUnit(ctx.institutionId, requireParam(ctx, "id"), [...SECTION_KINDS]);
  if (!row) throw notFound("Section");
  return { data: serializeAcademicUnit(row), requestId: ctx.requestId };
}

export async function listProgramsEndpoint(ctx: ApiContext): Promise<ApiListResponse<ApiAcademicUnit>> {
  const request = page(ctx);
  const rows = await repo.listAcademicUnits(ctx.institutionId, request, [...PROGRAM_KINDS]);
  return buildPage(rows.map(serializeAcademicUnit), request, ctx.requestId);
}

export async function getProgramEndpoint(ctx: ApiContext): Promise<ApiItemResponse<ApiAcademicUnit>> {
  const row = await repo.getAcademicUnit(ctx.institutionId, requireParam(ctx, "id"), [...PROGRAM_KINDS]);
  if (!row) throw notFound("Program");
  return { data: serializeAcademicUnit(row), requestId: ctx.requestId };
}

export async function listSubjectsEndpoint(ctx: ApiContext) {
  const request = page(ctx);
  const rows = await repo.listSubjects(ctx.institutionId, request);
  return buildPage(rows.map(serializeSubject), request, ctx.requestId);
}

export async function getSubjectEndpoint(ctx: ApiContext) {
  const row = await repo.getSubject(ctx.institutionId, requireParam(ctx, "id"));
  if (!row) throw notFound("Subject");
  return { data: serializeSubject(row), requestId: ctx.requestId };
}

export async function listFacultyEndpoint(ctx: ApiContext) {
  const request = page(ctx);
  const rows = await repo.listFaculty(ctx.institutionId, request);
  return buildPage(rows.map(serializeFaculty), request, ctx.requestId);
}

export async function getFacultyEndpoint(ctx: ApiContext) {
  const row = await repo.getFaculty(ctx.institutionId, requireParam(ctx, "id"));
  if (!row) throw notFound("Faculty member");
  return { data: serializeFaculty(row), requestId: ctx.requestId };
}

export async function listEnrollmentsEndpoint(ctx: ApiContext) {
  const request = page(ctx);
  const rows = await repo.listEnrollments(ctx.institutionId, request, {
    cohortId: readId(ctx.url, "cohortId"),
    studentId: readId(ctx.url, "studentId"),
    status: readEnum(ctx.url, "status", ENROLLMENT_STATUSES),
  });
  return buildPage(rows.map(serializeEnrollment), request, ctx.requestId);
}

export async function getEnrollmentEndpoint(ctx: ApiContext) {
  const row = await repo.getEnrollment(ctx.institutionId, requireParam(ctx, "id"));
  if (!row) throw notFound("Enrollment");
  return { data: serializeEnrollment(row), requestId: ctx.requestId };
}

function attendanceFilters(url: URL): repo.AttendanceFilters {
  return {
    sessionId: readId(url, "sessionId"),
    studentId: readId(url, "studentId"),
    cohortId: readId(url, "cohortId"),
    from: readDate(url, "from"),
    to: readDate(url, "to"),
    result: readEnum(url, "result", ATTENDANCE_RESULTS),
    updatedSince: readUpdatedSince(url),
  };
}

export async function listAttendanceEndpoint(ctx: ApiContext): Promise<ApiListResponse<ApiAttendanceRecord>> {
  const request = page(ctx);
  const rows = await repo.listAttendanceRecords(ctx.institutionId, request, attendanceFilters(ctx.url));
  return buildPage(rows.map(serializeAttendanceRecord), request, ctx.requestId);
}

export async function getAttendanceEndpoint(ctx: ApiContext): Promise<ApiItemResponse<ApiAttendanceRecord>> {
  const row = await repo.getAttendanceRecord(ctx.institutionId, requireParam(ctx, "id"));
  if (!row) throw notFound("Attendance record");
  return { data: serializeAttendanceRecord(row), requestId: ctx.requestId };
}

export async function listSessionsEndpoint(ctx: ApiContext) {
  const request = page(ctx);
  const rows = await repo.listAttendanceSessions(ctx.institutionId, request, {
    cohortId: readId(ctx.url, "cohortId"),
    status: readEnum(ctx.url, "status", SESSION_STATUSES),
    from: readDate(ctx.url, "from"),
    to: readDate(ctx.url, "to"),
  });
  return buildPage(rows.map(serializeSession), request, ctx.requestId);
}

export async function getSessionEndpoint(ctx: ApiContext) {
  const row = await repo.getAttendanceSession(ctx.institutionId, requireParam(ctx, "id"));
  if (!row) throw notFound("Attendance session");
  return { data: serializeSession(row), requestId: ctx.requestId };
}

/**
 * The one place a path parameter enters this API.
 *
 * The NUL check is not decorative. Postgres cannot store a NUL byte in a text
 * column, so no identifier can ever legitimately contain one — but Prisma
 * passes the string through and the driver rejects it at the wire, raising
 * `22021 invalid byte sequence for encoding "UTF8"`. That surfaced as a 500
 * on `GET /api/v1/students/abc%00def`: an unhandled exception, an error-log
 * entry and an alert, all reachable by anyone holding any valid key.
 *
 * Refused as `not_found` rather than as a new error shape, because that is
 * what every other unusable id already returns. A separate code here would
 * tell a caller that their NUL byte was interesting.
 */
function requireParam(ctx: ApiContext, name: string): string {
  const value = ctx.params[name];
  if (!value) throw notFound("Resource");
  if (value.includes("\0")) throw notFound("Resource");
  return value;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** Bound on per-student report rows. See `attendanceTotalsByStudent`. */
const REPORT_GROUP_LIMIT = 5_000;

export interface AttendanceReport {
  window: { from: string | null; to: string | null; cohortId: string | null };
  totals: Record<string, number>;
  /**
   * Present ÷ (present + absent), or null when there is nothing decided yet.
   *
   * `NEEDS_REVIEW` and `NOT_EVALUATED` are excluded from the denominator
   * rather than counted as absent. Counting an unreviewed record as absent
   * would publish a percentage that a teacher has not agreed to, and counting
   * it as present is the failure this product exists to prevent. They are
   * reported separately so a low `decided` count is visible rather than
   * hidden inside a confident-looking number.
   */
  attendanceRate: number | null;
  decided: number;
  pending: number;
  byStudent: Array<{ studentId: string; present: number; absent: number; needsReview: number; notEvaluated: number }>;
  truncated: boolean;
}

export async function attendanceReportEndpoint(ctx: ApiContext): Promise<ApiItemResponse<AttendanceReport>> {
  const filters = attendanceFilters(ctx.url);
  const [totals, perStudent] = await Promise.all([
    repo.attendanceTotals(ctx.institutionId, filters),
    repo.attendanceTotalsByStudent(ctx.institutionId, filters, REPORT_GROUP_LIMIT),
  ]);

  const totalsByResult: Record<string, number> = {
    PRESENT: 0,
    ABSENT: 0,
    NEEDS_REVIEW: 0,
    NOT_EVALUATED: 0,
  };
  for (const row of totals) totalsByResult[row.finalResult] = row.count;

  const decided = totalsByResult.PRESENT + totalsByResult.ABSENT;
  const pending = totalsByResult.NEEDS_REVIEW + totalsByResult.NOT_EVALUATED;

  const byStudent = new Map<string, { studentId: string; present: number; absent: number; needsReview: number; notEvaluated: number }>();
  for (const row of perStudent) {
    const entry =
      byStudent.get(row.studentId) ??
      { studentId: row.studentId, present: 0, absent: 0, needsReview: 0, notEvaluated: 0 };
    if (row.finalResult === "PRESENT") entry.present += row.count;
    else if (row.finalResult === "ABSENT") entry.absent += row.count;
    else if (row.finalResult === "NEEDS_REVIEW") entry.needsReview += row.count;
    else entry.notEvaluated += row.count;
    byStudent.set(row.studentId, entry);
  }

  return {
    data: {
      window: {
        from: filters.from ? filters.from.toISOString() : null,
        to: filters.to ? filters.to.toISOString() : null,
        cohortId: filters.cohortId ?? null,
      },
      totals: totalsByResult,
      attendanceRate: decided === 0 ? null : Number((totalsByResult.PRESENT / decided).toFixed(4)),
      decided,
      pending,
      byStudent: [...byStudent.values()],
      // Told rather than hidden: a client that sees `truncated: true` knows to
      // narrow the window instead of publishing a partial roster as a whole one.
      truncated: perStudent.length >= REPORT_GROUP_LIMIT,
    },
    requestId: ctx.requestId,
  };
}

// ---------------------------------------------------------------------------
// Institution
// ---------------------------------------------------------------------------

/**
 * The caller's own institution, and only ever their own.
 *
 * There is no `?institutionId=` and no list endpoint for other tenants. The
 * resource exists so an integrator can confirm which school a key belongs to
 * and read the labels that make the rest of the API legible — a "class" in a
 * school and a "course" in a college come back from the same field.
 */
export async function getInstitutionEndpoint(ctx: ApiContext) {
  const row = await repo.getInstitutionSettings(ctx.institutionId);
  if (!row) throw notFound("Institution");

  const settings = (typeof row.settings === "object" && row.settings !== null ? row.settings : {}) as Record<
    string,
    unknown
  >;
  return {
    data: {
      id: row.id,
      // Only the presentational settings. Connections, credentials and rate
      // limits live in the same column and are none of an integrator's
      // business — `integrations` is not in this list, and must not be.
      academicUnitLabels: settings.academicUnitLabels ?? null,
      attendanceMode: settings.attendanceMode ?? null,
    },
    requestId: ctx.requestId,
  };
}

// ---------------------------------------------------------------------------
// Integrations (read-only over the public API)
// ---------------------------------------------------------------------------

export interface ApiIntegration {
  id: string;
  name: string;
  kind: string;
  status: string;
  resources: string[];
  syncMode: string;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  mappedFields: number;
  recentErrorCount: number;
  updatedAt: string;
}

/**
 * A connection without its credentials.
 *
 * `config` never crosses this boundary. It holds `headers`, which is where a
 * REST connection's bearer token for the *external* system lives, and a base
 * URL that describes an institution's internal network. An integrator asking
 * "is my connection healthy" needs status, mode and error count; it does not
 * need another integration's credentials, and the shape of this function is
 * what guarantees it cannot have them.
 */
export function serializeConnection(connection: {
  id: string;
  name: string;
  kind: string;
  status: string;
  resources: string[];
  fieldMappings: unknown[];
  schedule: { mode: string; lastSyncAt?: string; lastSuccessAt?: string };
  recentErrors: unknown[];
  updatedAt: string;
}): ApiIntegration {
  return {
    id: connection.id,
    name: connection.name,
    kind: connection.kind,
    status: connection.status,
    resources: connection.resources,
    syncMode: connection.schedule.mode,
    lastSyncAt: connection.schedule.lastSyncAt ?? null,
    lastSuccessAt: connection.schedule.lastSuccessAt ?? null,
    mappedFields: connection.fieldMappings.length,
    recentErrorCount: connection.recentErrors.length,
    updatedAt: connection.updatedAt,
  };
}

export async function listIntegrationsEndpoint(ctx: ApiContext): Promise<ApiListResponse<ApiIntegration>> {
  const request = page(ctx);
  const row = await repo.getInstitutionSettings(ctx.institutionId);
  const { listConnections } = await import("./connections");
  const all = listConnections(row?.settings).map(serializeConnection);

  // Connections live in a JSON column, so there is no database cursor to page
  // with — and there are a handful per institution, not thousands. The slice
  // keeps the response envelope identical to every other list endpoint rather
  // than making integrations the one resource with a different shape.
  const startIndex = request.cursorId ? all.findIndex((entry) => entry.id === request.cursorId) + 1 : 0;
  const window = all.slice(startIndex, startIndex + request.limit + 1);
  return buildPage(window, request, ctx.requestId);
}

// ---------------------------------------------------------------------------
// Student writes
// ---------------------------------------------------------------------------

/**
 * Create a student, idempotently by student code.
 *
 * A retried POST — the timeout that every integration eventually hits — must
 * not produce a duplicate roster entry, and `studentCode` is unique per
 * institution precisely because it is the external identity. So a repeat whose
 * payload matches the stored row returns that row with 200 instead of a 409
 * the client would have to special-case. A repeat that *differs* is a genuine
 * conflict and says so: two different students claiming one code is a data
 * problem in the source system, and silently overwriting one with the other is
 * how a child's attendance ends up on someone else's record.
 */
export async function createStudentEndpoint(
  ctx: ApiContext,
): Promise<{ body: ApiItemResponse<ApiStudent>; status: number }> {
  const body = await readJsonBody(ctx.request);
  const input = readStudentBody(body, { requireName: true });

  const existing = await repo.findStudentByCode(ctx.institutionId, input.studentCode);
  if (existing) {
    const unchanged =
      existing.firstName === input.firstName &&
      existing.lastName === input.lastName &&
      (input.email === undefined || (existing.email ?? "") === input.email) &&
      (input.phone === undefined || (existing.phone ?? "") === input.phone) &&
      (input.status === undefined || existing.status === input.status);

    if (unchanged) {
      return { body: { data: serializeStudent(existing), requestId: ctx.requestId }, status: 200 };
    }
    throw new ApiError(
      "conflict",
      `A different student already exists with code \`${input.studentCode}\`. Use PATCH /api/v1/students/${existing.id} to change it.`,
      { details: { studentId: existing.id, studentCode: input.studentCode } },
    );
  }

  const created = await repo.createStudentRow(ctx.institutionId, {
    studentCode: input.studentCode,
    firstName: input.firstName!,
    lastName: input.lastName!,
    email: input.email || null,
    phone: input.phone || null,
    status: input.status,
  });

  const data = serializeStudent(created);
  await auditApiWrite(ctx, "student.created", "Student", created.id, { after: data });
  emit(ctx.institutionId, "student.created", created.id, created.createdAt.toISOString(), data);

  return { body: { data, requestId: ctx.requestId }, status: 201 };
}

export async function updateStudentEndpoint(ctx: ApiContext): Promise<ApiItemResponse<ApiStudent>> {
  const id = requireParam(ctx, "id");
  const body = await readJsonBody(ctx.request);
  const input = readStudentBody(body, { requireName: false });

  const before = await repo.getStudent(ctx.institutionId, id);
  if (!before) throw notFound("Student");

  // A code change is a change of external identity, so it must not collide
  // with a student who already holds that identity.
  if (input.studentCode && input.studentCode !== before.studentCode) {
    const clash = await repo.findStudentByCode(ctx.institutionId, input.studentCode);
    if (clash && clash.id !== id) {
      throw new ApiError("conflict", `Student code \`${input.studentCode}\` is already in use.`, {
        details: { studentId: clash.id },
      });
    }
  }

  const updated = await repo.updateStudentRow(ctx.institutionId, id, {
    ...(input.studentCode ? { studentCode: input.studentCode } : {}),
    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
    ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
    ...(input.email !== undefined ? { email: input.email || null } : {}),
    ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
  });
  if (!updated) throw notFound("Student");

  const data = serializeStudent(updated);
  const beforeData = serializeStudent(before);
  await auditApiWrite(ctx, "student.updated", "Student", id, { before: beforeData, after: data });

  /**
   * One event per change, most specific wins.
   *
   * A student leaving is the fact downstream systems act on — a library
   * revokes a card, a transport route drops a stop — so it gets its own event
   * rather than arriving as a generic `student.updated` a receiver has to
   * diff to understand. Emitting both would double every delivery for an
   * endpoint subscribed to the pair.
   */
  const deactivated = before.status === "ACTIVE" && updated.status !== "ACTIVE";
  emit(
    ctx.institutionId,
    deactivated ? "student.deactivated" : "student.updated",
    id,
    updated.updatedAt.toISOString(),
    data,
  );

  return { data, requestId: ctx.requestId };
}

function readStudentBody(body: Record<string, unknown>, options: { requireName: boolean }) {
  const studentCode = options.requireName
    ? requiredString(body, "studentCode", 64)
    : optionalString(body, "studentCode", 64);

  // `name` and `firstName`/`lastName` are both accepted because exports are
  // split about evenly between the two and forcing one costs every integrator
  // a string-splitting bug of their own.
  let firstName = optionalString(body, "firstName", 120);
  let lastName = optionalString(body, "lastName", 120);
  const fullName = optionalString(body, "name", 240);
  if (fullName && firstName === undefined && lastName === undefined) {
    const split = splitName(fullName);
    firstName = split.firstName;
    lastName = split.lastName;
  }

  if (options.requireName && !firstName) {
    throw invalidRequest("Provide `name`, or `firstName` and `lastName`.");
  }

  return {
    studentCode: studentCode as string,
    firstName,
    lastName: lastName ?? (options.requireName ? "" : undefined),
    email: optionalString(body, "email", 255),
    phone: optionalString(body, "phone", 32),
    status: optionalEnum(body, "status", ENROLLMENT_STATUSES),
  };
}

// ---------------------------------------------------------------------------
// Attendance writes
// ---------------------------------------------------------------------------

/**
 * The only attendance an external system may set: PRESENT or ABSENT.
 *
 * `NEEDS_REVIEW` is a state the recognition pipeline produces and a teacher
 * resolves; letting an integration push a finalized register back into review
 * would hand an external system control over a workflow it cannot see.
 * `NOT_EVALUATED` would erase a decision. Both are readable and neither is
 * writable, which is a smaller API and a defensible one.
 */
const API_WRITABLE_RESULTS = ["PRESENT", "ABSENT"] as const;

/**
 * Applies a correction on behalf of a named, authorized human.
 *
 * The brief's rule is that students cannot alter attendance and that a change
 * always has an author. An API key has no author, so the request must carry
 * one: `correctedBy` is a user id or work email, resolved inside the
 * institution, required to be ACTIVE, and required to hold
 * `attendanceRecord.correct`. An integration cannot mint authority it was not
 * given — it can only carry a decision a person with that authority made in
 * the source system.
 */
export async function correctAttendanceEndpoint(ctx: ApiContext): Promise<ApiItemResponse<ApiAttendanceRecord>> {
  const id = requireParam(ctx, "id");
  const body = await readJsonBody(ctx.request);

  const result = optionalEnum(body, "result", API_WRITABLE_RESULTS);
  if (!result) {
    throw invalidRequest(`\`result\` must be one of: ${API_WRITABLE_RESULTS.join(", ")}.`);
  }
  const correctedBy = requiredString(body, "correctedBy", 255);
  const reason = optionalString(body, "reason", 500);

  const record = await repo.getAttendanceRecord(ctx.institutionId, id);
  if (!record) throw notFound("Attendance record");

  const actor = await repo.findCorrectionActor(ctx.institutionId, correctedBy);
  if (!actor) {
    throw invalidRequest("`correctedBy` does not match a user in this institution.");
  }
  if (actor.status !== "ACTIVE") {
    throw invalidRequest("`correctedBy` names a user whose account is not active.");
  }
  if (!actor.permissions.includes("attendanceRecord.correct")) {
    throw new ApiError(
      "insufficient_scope",
      "`correctedBy` names a user who is not permitted to correct attendance.",
    );
  }

  // Idempotent: re-sending the value already stored is not a correction, and
  // writing an append-only trail row that records no change would make the
  // history unreadable for the person it exists for.
  if (record.finalResult === result) {
    return { data: serializeAttendanceRecord(record), requestId: ctx.requestId };
  }

  const outcome = await repo.applyAttendanceCorrection({
    institutionId: ctx.institutionId,
    recordId: id,
    previousResult: record.finalResult,
    newResult: result,
    changedByUserId: actor.id,
    reason: reason || null,
  });
  if (outcome.status === "not_found") throw notFound("Attendance record");
  if (outcome.status === "conflict") {
    // Somebody moved this record between the read above and the write — a
    // second integration, a teacher on the review board, an offline queue
    // draining. The correction was *not* applied, and saying so is the whole
    // point: the previous behaviour overwrote whatever had landed and wrote a
    // trail entry claiming a transition that never happened.
    //
    // A retry of the identical request is not a conflict: the record already
    // holds the requested result, and the equality check above returns it
    // unchanged before reaching here. So a 409 here always means a genuinely
    // different value arrived, and re-reading is the right next step.
    const current = await repo.getAttendanceRecord(ctx.institutionId, id);
    throw new ApiError(
      "conflict",
      "This attendance record changed while the correction was in flight. Re-read it and retry if the change is still wanted.",
      { details: current ? { currentResult: serializeAttendanceRecord(current).result } : undefined },
    );
  }

  const updated = outcome.record;
  const data = serializeAttendanceRecord(updated);
  await auditApiWrite(ctx, "attendance.corrected", "AttendanceRecord", id, {
    before: { result: record.finalResult },
    after: { result: data.result, correctedByUserId: actor.id, reason: reason || null },
  });
  emit(ctx.institutionId, "attendance.corrected", id, updated.updatedAt.toISOString(), {
    ...data,
    previousResult: record.finalResult,
    correctedByUserId: actor.id,
    reason: reason || null,
  });

  // The student may have their portal open right now. The faculty review path
  // already pushes a correction to their private channel; a correction that
  // arrives over the API is the same fact about the same student and has to
  // reach them the same way, or whether a result updates live depends on
  // which door the correction came through.
  //
  // Their own result only — the student channel never carries the class.
  attendanceEventPublisher.publishToStudent(updated.studentId, {
    type: "student-attendance-updated",
    sessionId: updated.sessionId,
    studentId: updated.studentId,
    finalResult: updated.finalResult,
    // An API correction targets a record that already exists in a register;
    // the portal only ever shows finalized ones, so this is the finalized
    // value being revised rather than a provisional one being published.
    isFinalized: true,
    occurredAt: updated.updatedAt.toISOString(),
  });

  return { data, requestId: ctx.requestId };
}

// ---------------------------------------------------------------------------
// Webhook endpoint registration
// ---------------------------------------------------------------------------

const webhookProvider = new WebhookProvider();

export async function listWebhookEndpointsEndpoint(ctx: ApiContext) {
  const request = page(ctx);
  const rows = await repo.listWebhookEndpoints(ctx.institutionId, request);
  return buildPage(rows.map(serializeWebhookEndpoint), request, ctx.requestId);
}

/**
 * Registers an endpoint and reveals its signing secret exactly once.
 *
 * The secret is returned in this response and never again — there is no
 * "show secret" endpoint, the list select does not include the column, and a
 * receiver that loses it registers a new endpoint. That is the same one-time
 * reveal `generateApiKey` uses, for the same reason.
 *
 * The URL goes through the provider's SSRF guard before anything is stored:
 * an endpoint pointed at `169.254.169.254` would make this application a proxy
 * into its own cloud metadata service, on a schedule, with retries.
 */
export async function createWebhookEndpointEndpoint(
  ctx: ApiContext,
): Promise<{ body: ApiItemResponse<Record<string, unknown>>; status: number }> {
  const body = await readJsonBody(ctx.request);
  const url = requiredString(body, "url", 2048);
  const rawEvents = body.eventTypes;

  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    throw invalidRequest("`eventTypes` must be a non-empty array of event names.");
  }
  const { WEBHOOK_EVENTS } = await import("./types");
  const eventTypes: string[] = [];
  for (const entry of rawEvents) {
    if (typeof entry !== "string" || !(WEBHOOK_EVENTS as readonly string[]).includes(entry)) {
      throw invalidRequest(`Unknown event type. Supported: ${WEBHOOK_EVENTS.join(", ")}.`);
    }
    if (!eventTypes.includes(entry)) eventTypes.push(entry);
  }

  const problems = webhookProvider.validateConfig({ deliveryUrl: url });
  if (problems.length > 0) {
    throw invalidRequest(problems.join(" "), { url: problems });
  }

  const secret = generateSigningSecret();
  const created = await repo.createWebhookEndpoint({
    institutionId: ctx.institutionId,
    url,
    secret,
    eventTypes,
  });

  await auditApiWrite(ctx, "webhook_endpoint.created", "WebhookEndpoint", created.id, {
    // The secret is not in the audit row. It is not in the access log either —
    // `redact()` catches the key name, and nothing puts it there to begin with.
    after: serializeWebhookEndpoint(created),
  });

  return {
    body: {
      data: {
        ...serializeWebhookEndpoint(created),
        secret,
        secretNotice: "Store this now. It is shown once and cannot be retrieved again.",
      },
      requestId: ctx.requestId,
    },
    status: 201,
  };
}

export async function deleteWebhookEndpointEndpoint(ctx: ApiContext) {
  const id = requireParam(ctx, "id");
  const before = await repo.getWebhookEndpoint(ctx.institutionId, id);
  if (!before) throw notFound("Webhook endpoint");

  const updated = await repo.deactivateWebhookEndpoint(ctx.institutionId, id);
  if (!updated) throw notFound("Webhook endpoint");

  await auditApiWrite(ctx, "webhook_endpoint.deleted", "WebhookEndpoint", id, {
    before: serializeWebhookEndpoint(before),
    after: serializeWebhookEndpoint(updated),
  });
  return { data: serializeWebhookEndpoint(updated), requestId: ctx.requestId };
}

// ---------------------------------------------------------------------------
// External identity mapping
// ---------------------------------------------------------------------------

/**
 * `GET /api/v1/external-ids` — what a provider calls things here.
 *
 * The institution is the credential's, never the query string's, which is what
 * keeps two tenants' identical vendor ids apart. See
 * `modules/integrations/external-identity.ts`.
 */
export async function listExternalIdsEndpoint(ctx: ApiContext) {
  const request = page(ctx);
  const rows = await externalIdentity.listExternalIdentities(
    ctx.institutionId,
    {
      provider: ctx.url.searchParams.get("provider") ?? undefined,
      entityType: ctx.url.searchParams.get("entityType") ?? undefined,
    },
    { limit: request.limit, cursorId: request.cursorId },
  );
  return buildPage(rows.map(serializeExternalId), request, ctx.requestId);
}

/**
 * `POST /api/v1/external-ids` — record that a provider calls this record X.
 *
 * Idempotent by construction: replaying the same link returns the same row.
 * Re-pointing an external id at a different record is an update; giving one
 * record a *second* id from the same provider is a 409, because nothing here
 * can tell which of the two the external system now means.
 */
export async function createExternalIdEndpoint(ctx: ApiContext) {
  const body = await readJsonBody(ctx.request);
  const row = await externalIdentity.linkExternalId(ctx.institutionId, {
    provider: readString(body, "provider"),
    entityType: readString(body, "entityType"),
    externalId: readString(body, "externalId"),
    internalId: readString(body, "internalId"),
  });

  await auditApiWrite(ctx, "integration.externalId.linked", "ExternalIdentity", row.id, {
    after: {
      provider: row.provider,
      entityType: row.entityType,
      externalId: row.externalId,
      internalId: row.internalId,
    },
  });
  return { data: serializeExternalId(row), requestId: ctx.requestId };
}

/**
 * `DELETE /api/v1/external-ids` — forget a mapping.
 *
 * Removes the mapping and nothing else. Disconnecting an integration is not a
 * reason to delete a student, and this endpoint holds no authority to.
 */
export async function deleteExternalIdEndpoint(ctx: ApiContext) {
  const provider = ctx.url.searchParams.get("provider") ?? "";
  const entityType = ctx.url.searchParams.get("entityType") ?? "";
  const externalId = ctx.url.searchParams.get("externalId") ?? "";

  const removed = await externalIdentity.unlinkExternalId(ctx.institutionId, {
    provider,
    entityType,
    externalId,
  });
  if (!removed) throw notFound("External id mapping");

  await auditApiWrite(ctx, "integration.externalId.unlinked", "ExternalIdentity", externalId, {
    before: { provider, entityType, externalId },
  });
  return { data: { deleted: true }, requestId: ctx.requestId };
}

function serializeExternalId(row: externalIdentity.ExternalIdentityRecord) {
  return {
    id: row.id,
    provider: row.provider,
    entityType: row.entityType,
    externalId: row.externalId,
    internalId: row.internalId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** A required string field, with the module's usual "say which field" error. */
function readString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw invalidRequest(`\`${field}\` is required and must be a non-empty string.`);
  }
  return value;
}
