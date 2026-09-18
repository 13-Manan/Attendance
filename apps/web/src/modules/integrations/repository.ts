import { prisma } from "@/lib/prisma";
import type { EnrollmentStatus, Prisma } from "@prisma/client";
import { prismaPageArgs, type PageRequest } from "./pagination";

/**
 * Data access for the public integration API and the Integration Center.
 *
 * ## Why this module has its own repository at all
 *
 * The existing per-domain repositories are shaped for the internal portals:
 * `listStudentsByInstitution` returns every row, unpaginated, ordered by
 * surname, because a roster screen renders a few hundred rows once. An ERP
 * walking 40,000 students needs a keyset page and a `updatedSince` filter, and
 * bolting those onto the internal functions would change behaviour under the
 * screens that already use them. This file adds; it does not modify.
 *
 * ## Two rules every function here obeys
 *
 * 1. **`institutionId` is a required parameter, never inferred.** There is no
 *    function in this file that can read across tenants, which means a caller
 *    that forgets the tenant does not compile rather than leaking a roster.
 * 2. **Ordering is `id asc`, always.** Cursor pagination is only correct over a
 *    unique, stable sort. Ordering students by surname would be prettier and
 *    would silently skip or repeat rows whenever two students share a surname
 *    across a page boundary. Presentation ordering belongs to the client.
 *
 * Thin by intent: no arithmetic, no authorization, no serialization. Scope
 * checks happen in `api-route.ts` before a handler runs; shaping happens in
 * `service.ts`. See ARCHITECTURE.md on the repository/service split.
 */

// ---------------------------------------------------------------------------
// Shared filter shapes
// ---------------------------------------------------------------------------

export interface TimeWindow {
  /** Rows changed at or after this instant. The incremental-sync watermark. */
  updatedSince?: Date;
}

export interface StudentFilters extends TimeWindow {
  status?: Prisma.EnumEnrollmentStatusFilter["equals"];
  /** Only students with an enrollment in this cohort. */
  cohortId?: string;
  studentCode?: string;
}

export interface AttendanceFilters extends TimeWindow {
  sessionId?: string;
  studentId?: string;
  cohortId?: string;
  /** Inclusive lower bound on the session's date. */
  from?: Date;
  /** Inclusive upper bound on the session's date. */
  to?: Date;
  result?: Prisma.EnumAttendanceResultFilter["equals"];
}

export interface SessionFilters {
  cohortId?: string;
  status?: Prisma.EnumSessionStatusFilter["equals"];
  from?: Date;
  to?: Date;
}

export interface EnrollmentFilters {
  cohortId?: string;
  studentId?: string;
  status?: Prisma.EnumEnrollmentStatusFilter["equals"];
}

// ---------------------------------------------------------------------------
// Students
// ---------------------------------------------------------------------------

/**
 * `updatedAt` rather than `createdAt` for the incremental window: a student
 * whose surname was corrected must reach the ERP on the next incremental run,
 * and filtering on creation would mean corrections never propagate at all.
 */
function studentWhere(institutionId: string, filters: StudentFilters): Prisma.StudentWhereInput {
  return {
    institutionId,
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.studentCode ? { studentCode: filters.studentCode } : {}),
    ...(filters.cohortId ? { enrollments: { some: { cohortId: filters.cohortId } } } : {}),
    ...(filters.updatedSince ? { updatedAt: { gte: filters.updatedSince } } : {}),
  };
}

export type ApiStudentRow = Prisma.StudentGetPayload<{
  include: { enrollments: { select: { cohortId: true; status: true } } };
}>;

export function listStudents(
  institutionId: string,
  page: PageRequest,
  filters: StudentFilters = {},
): Promise<ApiStudentRow[]> {
  return prisma.student.findMany({
    where: studentWhere(institutionId, filters),
    include: { enrollments: { select: { cohortId: true, status: true } } },
    orderBy: { id: "asc" },
    ...prismaPageArgs(page),
  });
}

/**
 * Scoped by institution as well as id. `findUnique({ where: { id } })` would
 * be one query shorter and would let a key for institution A read a row from
 * institution B by guessing a cuid — the whole tenant boundary of the public
 * API is this `where` clause.
 */
export function getStudent(institutionId: string, id: string): Promise<ApiStudentRow | null> {
  return prisma.student.findFirst({
    where: { id, institutionId },
    include: { enrollments: { select: { cohortId: true, status: true } } },
  });
}

export function findStudentByCode(institutionId: string, studentCode: string): Promise<ApiStudentRow | null> {
  return prisma.student.findFirst({
    where: { institutionId, studentCode },
    include: { enrollments: { select: { cohortId: true, status: true } } },
  });
}

export interface StudentWriteInput {
  studentCode: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  status?: Prisma.EnumEnrollmentStatusFilter["equals"];
}

export function createStudentRow(institutionId: string, input: StudentWriteInput): Promise<ApiStudentRow> {
  return prisma.student.create({
    data: {
      institutionId,
      studentCode: input.studentCode,
      firstName: input.firstName,
      lastName: input.lastName,
      email: input.email ?? null,
      phone: input.phone ?? null,
      ...(input.status ? { status: input.status } : {}),
    },
    include: { enrollments: { select: { cohortId: true, status: true } } },
  });
}

/**
 * `updateMany`-then-read rather than `update`, because `update` takes a unique
 * `where` and cannot also require `institutionId`. Returning the count lets the
 * service tell "no such student" from "nothing changed".
 */
export async function updateStudentRow(
  institutionId: string,
  id: string,
  data: Partial<StudentWriteInput>,
): Promise<ApiStudentRow | null> {
  const result = await prisma.student.updateMany({
    where: { id, institutionId },
    data: {
      ...(data.studentCode !== undefined ? { studentCode: data.studentCode } : {}),
      ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
      ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
    },
  });
  if (result.count === 0) return null;
  return getStudent(institutionId, id);
}

// ---------------------------------------------------------------------------
// Classes (Cohort), sections and programs (AcademicUnit), subjects
// ---------------------------------------------------------------------------

export type ApiCohortRow = Prisma.CohortGetPayload<{
  include: {
    academicUnit: { select: { id: true; name: true; code: true; kind: true } };
    academicSession: { select: { id: true; name: true } };
    _count: { select: { enrollments: true } };
  };
}>;

export function listCohorts(institutionId: string, page: PageRequest): Promise<ApiCohortRow[]> {
  return prisma.cohort.findMany({
    where: { institutionId },
    include: {
      academicUnit: { select: { id: true, name: true, code: true, kind: true } },
      academicSession: { select: { id: true, name: true } },
      _count: { select: { enrollments: true } },
    },
    orderBy: { id: "asc" },
    ...prismaPageArgs(page),
  });
}

export function getCohort(institutionId: string, id: string): Promise<ApiCohortRow | null> {
  return prisma.cohort.findFirst({
    where: { id, institutionId },
    include: {
      academicUnit: { select: { id: true, name: true, code: true, kind: true } },
      academicSession: { select: { id: true, name: true } },
      _count: { select: { enrollments: true } },
    },
  });
}

export type ApiAcademicUnitRow = Prisma.AcademicUnitGetPayload<{
  select: {
    id: true;
    kind: true;
    name: true;
    code: true;
    parentId: true;
    campusId: true;
    sortOrder: true;
    createdAt: true;
  };
}>;

const ACADEMIC_UNIT_SELECT = {
  id: true,
  kind: true,
  name: true,
  code: true,
  parentId: true,
  campusId: true,
  sortOrder: true,
  createdAt: true,
} as const;

/**
 * Sections and programs are the same table with different `kind` values — see
 * the school/college note above `AcademicUnit` in schema.prisma. The public API
 * exposes them as two resources because that is the vocabulary an ERP speaks,
 * and the split is a `kind` filter rather than two tables.
 */
export function listAcademicUnits(
  institutionId: string,
  page: PageRequest,
  kinds: Prisma.EnumAcademicUnitKindFilter["in"],
): Promise<ApiAcademicUnitRow[]> {
  return prisma.academicUnit.findMany({
    where: { institutionId, ...(kinds ? { kind: { in: kinds } } : {}) },
    select: ACADEMIC_UNIT_SELECT,
    orderBy: { id: "asc" },
    ...prismaPageArgs(page),
  });
}

export function getAcademicUnit(
  institutionId: string,
  id: string,
  kinds: Prisma.EnumAcademicUnitKindFilter["in"],
): Promise<ApiAcademicUnitRow | null> {
  return prisma.academicUnit.findFirst({
    where: { id, institutionId, ...(kinds ? { kind: { in: kinds } } : {}) },
    select: ACADEMIC_UNIT_SELECT,
  });
}

export type ApiSubjectRow = Prisma.SubjectGetPayload<{
  select: { id: true; code: true; name: true; createdAt: true };
}>;

export function listSubjects(institutionId: string, page: PageRequest): Promise<ApiSubjectRow[]> {
  return prisma.subject.findMany({
    where: { institutionId },
    select: { id: true, code: true, name: true, createdAt: true },
    orderBy: { id: "asc" },
    ...prismaPageArgs(page),
  });
}

export function getSubject(institutionId: string, id: string): Promise<ApiSubjectRow | null> {
  return prisma.subject.findFirst({
    where: { id, institutionId },
    select: { id: true, code: true, name: true, createdAt: true },
  });
}

// ---------------------------------------------------------------------------
// Faculty
// ---------------------------------------------------------------------------

export type ApiFacultyRow = Prisma.UserGetPayload<{
  select: {
    id: true;
    name: true;
    email: true;
    employeeCode: true;
    status: true;
    campusId: true;
    createdAt: true;
  };
}>;

const FACULTY_SELECT = {
  id: true,
  name: true,
  email: true,
  employeeCode: true,
  status: true,
  campusId: true,
  createdAt: true,
} as const;

/**
 * "Faculty" is a role and a set of teaching links, not a table.
 *
 * A user counts if they hold a teaching role assignment *or* actually teach
 * something. Role alone would miss a visiting lecturer attached to a
 * `CohortSubject` without a role row; links alone would miss a newly appointed
 * teacher who has not been given a class yet. Either is a support ticket that
 * reads "our new teacher is missing from the ERP".
 *
 * Deliberately never selects `passwordHash`.
 */
const FACULTY_ROLE_KEYS = ["FACULTY", "CLASS_TEACHER"] as const;

function facultyWhere(institutionId: string): Prisma.UserWhereInput {
  return {
    institutionId,
    OR: [
      { roleAssignments: { some: { institutionId, role: { key: { in: [...FACULTY_ROLE_KEYS] } } } } },
      { facultyCohorts: { some: {} } },
      { subjectLinks: { some: {} } },
    ],
  };
}

export function listFaculty(institutionId: string, page: PageRequest): Promise<ApiFacultyRow[]> {
  return prisma.user.findMany({
    where: facultyWhere(institutionId),
    select: FACULTY_SELECT,
    orderBy: { id: "asc" },
    ...prismaPageArgs(page),
  });
}

export function getFaculty(institutionId: string, id: string): Promise<ApiFacultyRow | null> {
  return prisma.user.findFirst({
    where: { AND: [{ id }, facultyWhere(institutionId)] },
    select: FACULTY_SELECT,
  });
}

export interface CorrectionActor {
  id: string;
  name: string;
  email: string;
  status: string;
  permissions: string[];
}

/**
 * Resolves the human an external correction is made on behalf of.
 *
 * `AttendanceCorrection.changedByUserId` is `NOT NULL` and it is the only
 * answer the register has to "who changed this". An API key is not a person,
 * so a public-API correction must name one — accepted by email (what an ERP
 * knows) or by user id (what a prior API response returned). The permissions
 * come back flattened so the service can require `attendanceRecord.correct` of
 * the named user: an integration must not be able to launder a change through
 * an account that is not allowed to make it.
 */
export async function findCorrectionActor(
  institutionId: string,
  identifier: string,
): Promise<CorrectionActor | null> {
  const user = await prisma.user.findFirst({
    where: {
      institutionId,
      OR: [{ id: identifier }, { email: identifier.toLowerCase() }],
    },
    select: {
      id: true,
      name: true,
      email: true,
      status: true,
      roleAssignments: {
        where: { institutionId },
        select: { role: { select: { permissions: { select: { permission: true } } } } },
      },
    },
  });
  if (!user) return null;

  const permissions = new Set<string>();
  for (const assignment of user.roleAssignments) {
    for (const entry of assignment.role.permissions) permissions.add(entry.permission);
  }
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    status: user.status,
    permissions: [...permissions],
  };
}

// ---------------------------------------------------------------------------
// Enrollments
// ---------------------------------------------------------------------------

export type ApiEnrollmentRow = Prisma.EnrollmentGetPayload<{
  select: {
    id: true;
    studentId: true;
    cohortId: true;
    status: true;
    enrolledAt: true;
    unenrolledAt: true;
    student: { select: { studentCode: true } };
  };
}>;

const ENROLLMENT_SELECT = {
  id: true,
  studentId: true,
  cohortId: true,
  status: true,
  enrolledAt: true,
  unenrolledAt: true,
  student: { select: { studentCode: true } },
} as const;

export function listEnrollments(
  institutionId: string,
  page: PageRequest,
  filters: EnrollmentFilters = {},
): Promise<ApiEnrollmentRow[]> {
  return prisma.enrollment.findMany({
    where: {
      institutionId,
      ...(filters.cohortId ? { cohortId: filters.cohortId } : {}),
      ...(filters.studentId ? { studentId: filters.studentId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    },
    select: ENROLLMENT_SELECT,
    orderBy: { id: "asc" },
    ...prismaPageArgs(page),
  });
}

export function getEnrollment(institutionId: string, id: string): Promise<ApiEnrollmentRow | null> {
  return prisma.enrollment.findFirst({
    where: { id, institutionId },
    select: ENROLLMENT_SELECT,
  });
}

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

export type ApiAttendanceRow = Prisma.AttendanceRecordGetPayload<{
  select: {
    id: true;
    sessionId: true;
    studentId: true;
    finalResult: true;
    isManuallyCorrected: true;
    createdAt: true;
    updatedAt: true;
    student: { select: { studentCode: true } };
    session: {
      select: {
        sessionDate: true;
        status: true;
        cohortId: true;
        cohortSubjectId: true;
        institutionId: true;
      };
    };
  };
}>;

/**
 * The select list is the privacy boundary, and it is a denylist made into an
 * allowlist.
 *
 * Absent on purpose: `aiConfidence`, `aiResult` and `matchedEmbeddingId`. A
 * confidence score is a claim about how well a face matched a stored biometric
 * template; publishing it to an external system exports an inference about
 * biometric data through the back door, and `matchedEmbeddingId` is a direct
 * handle on a `FaceEmbedding` row. The API's answer to "was this student
 * present" is `finalResult` — the human-authoritative value — and whether a
 * human changed it. That is the same rule the classroom UI follows.
 */
const ATTENDANCE_SELECT = {
  id: true,
  sessionId: true,
  studentId: true,
  finalResult: true,
  isManuallyCorrected: true,
  createdAt: true,
  updatedAt: true,
  student: { select: { studentCode: true } },
  session: {
    select: {
      sessionDate: true,
      status: true,
      cohortId: true,
      cohortSubjectId: true,
      institutionId: true,
    },
  },
} as const;

function attendanceWhere(institutionId: string, filters: AttendanceFilters): Prisma.AttendanceRecordWhereInput {
  const sessionFilter: Prisma.AttendanceSessionWhereInput = {
    ...(filters.cohortId ? { cohortId: filters.cohortId } : {}),
    ...(filters.from || filters.to
      ? {
          sessionDate: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };

  return {
    institutionId,
    ...(filters.sessionId ? { sessionId: filters.sessionId } : {}),
    ...(filters.studentId ? { studentId: filters.studentId } : {}),
    ...(filters.result ? { finalResult: filters.result } : {}),
    ...(filters.updatedSince ? { updatedAt: { gte: filters.updatedSince } } : {}),
    ...(Object.keys(sessionFilter).length > 0 ? { session: sessionFilter } : {}),
  };
}

export function listAttendanceRecords(
  institutionId: string,
  page: PageRequest,
  filters: AttendanceFilters = {},
): Promise<ApiAttendanceRow[]> {
  return prisma.attendanceRecord.findMany({
    where: attendanceWhere(institutionId, filters),
    select: ATTENDANCE_SELECT,
    orderBy: { id: "asc" },
    ...prismaPageArgs(page),
  });
}

export function getAttendanceRecord(institutionId: string, id: string): Promise<ApiAttendanceRow | null> {
  return prisma.attendanceRecord.findFirst({
    where: { id, institutionId },
    select: ATTENDANCE_SELECT,
  });
}

export function findAttendanceRecord(
  institutionId: string,
  sessionId: string,
  studentId: string,
): Promise<ApiAttendanceRow | null> {
  return prisma.attendanceRecord.findFirst({
    where: { institutionId, sessionId, studentId },
    select: ATTENDANCE_SELECT,
  });
}

export type ApiSessionRow = Prisma.AttendanceSessionGetPayload<{
  select: {
    id: true;
    cohortId: true;
    cohortSubjectId: true;
    facultyId: true;
    sessionDate: true;
    startedAt: true;
    endedAt: true;
    status: true;
    _count: { select: { attendanceRecords: true } };
  };
}>;

/**
 * `metadata` is not selected. It carries review-workflow internals and
 * offline-sync bookkeeping written by other modules for their own use; an
 * external system reading it would couple itself to a private structure that
 * changes without an API version bump.
 */
const SESSION_SELECT = {
  id: true,
  cohortId: true,
  cohortSubjectId: true,
  facultyId: true,
  sessionDate: true,
  startedAt: true,
  endedAt: true,
  status: true,
  _count: { select: { attendanceRecords: true } },
} as const;

export function listAttendanceSessions(
  institutionId: string,
  page: PageRequest,
  filters: SessionFilters = {},
): Promise<ApiSessionRow[]> {
  return prisma.attendanceSession.findMany({
    where: {
      institutionId,
      ...(filters.cohortId ? { cohortId: filters.cohortId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.from || filters.to
        ? {
            sessionDate: {
              ...(filters.from ? { gte: filters.from } : {}),
              ...(filters.to ? { lte: filters.to } : {}),
            },
          }
        : {}),
    },
    select: SESSION_SELECT,
    orderBy: { id: "asc" },
    ...prismaPageArgs(page),
  });
}

export function getAttendanceSession(institutionId: string, id: string): Promise<ApiSessionRow | null> {
  return prisma.attendanceSession.findFirst({
    where: { id, institutionId },
    select: SESSION_SELECT,
  });
}

/**
 * Applies an external correction to one record and appends the trail row, in
 * one transaction.
 *
 * Two facts make the transaction non-negotiable. `AttendanceCorrection` is
 * append-only and is the *only* record of who changed what; a committed record
 * update with a failed trail insert is a silently altered register. And
 * `isManuallyCorrected` is what the UI reads to show that a human overrode the
 * AI — leaving it unset would present an externally-corrected record as the
 * model's own confident output, which is exactly the confusion the product
 * forbids.
 *
 * `changedByUserId` is required by the schema, so a public-API correction must
 * name a real user. The service resolves and validates that; this function
 * does not invent one.
 */
export async function applyAttendanceCorrection(input: {
  institutionId: string;
  recordId: string;
  previousResult: Prisma.EnumAttendanceResultFilter["equals"];
  newResult: NonNullable<Prisma.EnumAttendanceResultFilter["equals"]>;
  changedByUserId: string;
  reason: string | null;
}): Promise<ApiAttendanceRow | null> {
  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.attendanceRecord.updateMany({
      where: { id: input.recordId, institutionId: input.institutionId },
      data: { finalResult: input.newResult, isManuallyCorrected: true },
    });
    if (result.count === 0) return false;

    await tx.attendanceCorrection.create({
      data: {
        attendanceRecordId: input.recordId,
        previousResult: input.previousResult ?? "NOT_EVALUATED",
        newResult: input.newResult,
        changedByUserId: input.changedByUserId,
        reason: input.reason,
        source: "PUBLIC_API",
      },
    });
    return true;
  });

  if (!updated) return null;
  return getAttendanceRecord(input.institutionId, input.recordId);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export interface AttendanceTotalsRow {
  finalResult: string;
  count: number;
}

/**
 * Counts by outcome for a window, grouped rather than fetched.
 *
 * `/reports` must not become "page through every record and add them up on the
 * client" — that is the same table scan the paginated endpoint already offers,
 * with worse ergonomics and no bound on the work. `NEEDS_REVIEW` and
 * `NOT_EVALUATED` are returned as their own buckets, never folded into absent
 * or present: a report that silently resolves an unreviewed record is the
 * failure mode this product is built to avoid.
 */
export async function attendanceTotals(
  institutionId: string,
  filters: AttendanceFilters = {},
): Promise<AttendanceTotalsRow[]> {
  const grouped = await prisma.attendanceRecord.groupBy({
    by: ["finalResult"],
    where: attendanceWhere(institutionId, filters),
    _count: { _all: true },
  });
  return grouped.map((row) => ({ finalResult: row.finalResult, count: row._count._all }));
}

/** Per-student totals for the same window, used by the roster-shaped report. */
export async function attendanceTotalsByStudent(
  institutionId: string,
  filters: AttendanceFilters = {},
  limit: number,
): Promise<Array<{ studentId: string; finalResult: string; count: number }>> {
  const grouped = await prisma.attendanceRecord.groupBy({
    by: ["studentId", "finalResult"],
    where: attendanceWhere(institutionId, filters),
    _count: { _all: true },
    // Bounded so a report over a whole academic year cannot pull an unbounded
    // result set into memory. The service reports the truncation rather than
    // presenting a partial total as a complete one.
    take: limit,
    orderBy: { studentId: "asc" },
  });
  return grouped.map((row) => ({
    studentId: row.studentId,
    finalResult: row.finalResult,
    count: row._count._all,
  }));
}

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------

export type ApiWebhookRow = Prisma.WebhookEndpointGetPayload<{
  select: { id: true; url: true; eventTypes: true; isActive: true; createdAt: true };
}>;

/**
 * `secret` is never in this select. It is returned exactly once, by the
 * service, in the response to the call that created it — the same one-time
 * reveal the API-key flow uses, for the same reason: a secret a UI can re-read
 * is a secret that ends up in a screenshot.
 */
const WEBHOOK_SELECT = {
  id: true,
  url: true,
  eventTypes: true,
  isActive: true,
  createdAt: true,
} as const;

export function listWebhookEndpoints(institutionId: string, page: PageRequest): Promise<ApiWebhookRow[]> {
  return prisma.webhookEndpoint.findMany({
    where: { institutionId },
    select: WEBHOOK_SELECT,
    orderBy: { id: "asc" },
    ...prismaPageArgs(page),
  });
}

export function getWebhookEndpoint(institutionId: string, id: string): Promise<ApiWebhookRow | null> {
  return prisma.webhookEndpoint.findFirst({
    where: { id, institutionId },
    select: WEBHOOK_SELECT,
  });
}

export function createWebhookEndpoint(input: {
  institutionId: string;
  url: string;
  secret: string;
  eventTypes: string[];
}): Promise<ApiWebhookRow> {
  return prisma.webhookEndpoint.create({
    data: {
      institutionId: input.institutionId,
      url: input.url,
      secret: input.secret,
      eventTypes: input.eventTypes,
    },
    select: WEBHOOK_SELECT,
  });
}

export async function updateWebhookEndpoint(
  institutionId: string,
  id: string,
  data: { url?: string; eventTypes?: string[]; isActive?: boolean },
): Promise<ApiWebhookRow | null> {
  const result = await prisma.webhookEndpoint.updateMany({
    where: { id, institutionId },
    data: {
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.eventTypes !== undefined ? { eventTypes: data.eventTypes } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });
  if (result.count === 0) return null;
  return getWebhookEndpoint(institutionId, id);
}

/**
 * Deactivates rather than deletes.
 *
 * A deleted endpoint takes its delivery history's referent with it — the
 * `AuditLog` rows that record every attempt would point at an id nothing
 * explains. "Why did our ERP stop receiving events on the 3rd?" is a question
 * an administrator should be able to answer six months later.
 */
export async function deactivateWebhookEndpoint(institutionId: string, id: string): Promise<ApiWebhookRow | null> {
  return updateWebhookEndpoint(institutionId, id, { isActive: false });
}

// ---------------------------------------------------------------------------
// Institution settings — where connections, mappings and schedules live
// ---------------------------------------------------------------------------

export function getInstitutionSettings(institutionId: string): Promise<{ id: string; settings: unknown } | null> {
  return prisma.institution.findUnique({
    where: { id: institutionId },
    select: { id: true, settings: true },
  });
}

/**
 * Writes the whole settings object back.
 *
 * `Institution.settings` is one JSON column, so there is no partial update to
 * make: the caller reads, transforms with the pure codecs in `connections.ts`
 * (which are written to preserve every key they do not own — `academicUnitLabels`,
 * `confidenceThresholds`, `attendanceMode` — and are tested for exactly that),
 * and writes back.
 *
 * The read-modify-write is not transactional against a concurrent editor, and
 * that is an accepted cost: the writers are administrators on an Integration
 * Center page, not a request path, and the failure mode is one admin's
 * connection edit overwriting another's in the same second. Recorded here so
 * the next person finds a decision rather than a bug.
 */
export async function writeInstitutionSettings(
  institutionId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await prisma.institution.update({
    where: { id: institutionId },
    data: { settings: settings as Prisma.InputJsonValue },
  });
}

/**
 * The existing-roster snapshot an import is diffed against.
 *
 * Keyed lookup by code rather than a full roster read: an institution may have
 * tens of thousands of students and an import file names a known set, so
 * `WHERE studentCode IN (...)` reads exactly the rows the diff can possibly
 * touch. Chunked by the caller — a 20,000-element `IN` list is a query plan
 * nobody wants to explain.
 */
export function listStudentsByCodes(
  institutionId: string,
  codes: readonly string[],
): Promise<Array<{
  id: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: EnrollmentStatus;
}>> {
  if (codes.length === 0) return Promise.resolve([]);
  return prisma.student.findMany({
    where: { institutionId, studentCode: { in: [...codes] } },
    select: {
      id: true,
      studentCode: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      status: true,
    },
  });
}

/**
 * Resolves a cohort by its academic unit's code — the `class_code` half of the
 * brief's field mapping. Institution-scoped like everything else here.
 */
export function findCohortByCode(institutionId: string, code: string): Promise<{ id: string } | null> {
  return prisma.cohort.findFirst({
    where: { institutionId, academicUnit: { code } },
    select: { id: true },
    orderBy: { id: "asc" },
  });
}

export function findSubjectByCode(institutionId: string, code: string): Promise<{ id: string } | null> {
  return prisma.subject.findFirst({
    where: { institutionId, code },
    select: { id: true },
  });
}
