import { prisma } from "@/lib/prisma";

/**
 * Data access for retention enforcement. Thin by convention — every decision
 * about *whether* a row may be touched is in `service.ts`; this file only
 * knows how to find and remove rows once that decision is made.
 *
 * ## Why every function takes an institutionId
 *
 * Because this is the module that deletes things. Everywhere else in the
 * codebase an unscoped read is a leak; here an unscoped write is one
 * institution erasing another's biometric data, and the sweep is the one
 * operation that could plausibly be triggered on a schedule with no user
 * attached. The parameter is required on every function, there is no unscoped
 * variant, and the service resolves it from the session rather than accepting
 * it from a caller — the same rule `modules/integrations/repository.ts` states
 * for reads, applied where the consequence is worse.
 */

export interface ExpiringTemplateRow {
  id: string;
  studentId: string;
  isActive: boolean;
  createdAt: Date;
  studentStatus: string;
}

/**
 * Every template in the institution, with the owning student's status.
 *
 * One query rather than a query per student: the sweep has to make the same
 * three decisions about each row, and the row count is bounded by
 * `MAX_SAMPLES_PER_STUDENT` (5) times the roster. The vector column is not
 * selected — the sweep decides by date and status and has no use for the
 * biometric value itself, which is the one part of the row that must not be
 * read into a process that is about to log a summary.
 */
export function listTemplatesForRetention(
  institutionId: string,
): Promise<ExpiringTemplateRow[]> {
  return prisma.faceEmbedding
    .findMany({
      where: { institutionId },
      select: {
        id: true,
        studentId: true,
        isActive: true,
        createdAt: true,
        student: { select: { status: true } },
      },
    })
    .then((rows) =>
      rows.map((row) => ({
        id: row.id,
        studentId: row.studentId,
        isActive: row.isActive,
        createdAt: row.createdAt,
        studentStatus: row.student.status,
      })),
    );
}

/** Soft delete. The row stays; recognition stops seeing it (`isActive` is in
 * every candidate query's WHERE clause). */
export async function deactivateTemplates(
  institutionId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await prisma.faceEmbedding.updateMany({
    // `institutionId` as well as the id list: `updateMany` takes a filter, so
    // there is no extra round trip in re-asserting the tenant, and the
    // assertion is what makes a bug in the caller's id list harmless.
    where: { id: { in: ids }, institutionId },
    data: { isActive: false },
  });
  return result.count;
}

/**
 * Hard delete. The biometric template is gone from the database.
 *
 * ## The two statements, and why the first one is not optional
 *
 * `AttendanceRecord.matchedEmbeddingId` points at these rows. The relation is
 * optional, so Prisma's generated foreign key is `ON DELETE SET NULL` and the
 * delete would in principle succeed on its own — but "in principle" is doing
 * real work in that sentence: the referential action is decided by whichever
 * migration created the constraint, this repository has never been run against
 * a migrated database (see README's status note), and a retention sweep that
 * throws a foreign-key error is a retention policy that silently does not run.
 *
 * Clearing the pointer explicitly first makes the outcome the same whatever
 * the constraint says. It is also the correct end state on its own terms: what
 * is being erased is the biometric template, not the attendance record. The
 * record keeps its date, its `finalResult`, its corrections and the faculty
 * member accountable for it; it loses only the advisory pointer to a template
 * that no longer exists. A register must not develop holes because a student
 * exercised a right to erasure.
 *
 * Both statements run in one transaction so a failure cannot leave records
 * pointing at deleted rows.
 */
export async function deleteTemplates(
  institutionId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const [, deleted] = await prisma.$transaction([
    prisma.attendanceRecord.updateMany({
      where: { institutionId, matchedEmbeddingId: { in: ids } },
      data: { matchedEmbeddingId: null },
    }),
    prisma.faceEmbedding.deleteMany({
      where: { id: { in: ids }, institutionId },
    }),
  ]);
  return deleted.count;
}

/** Ids of this student's templates. Used by the explicit erasure workflow,
 * which deletes every template a student has regardless of age or status. */
export async function listTemplateIdsForStudent(
  institutionId: string,
  studentId: string,
): Promise<string[]> {
  const rows = await prisma.faceEmbedding.findMany({
    where: { institutionId, studentId },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

export interface ClassroomImageRow {
  id: string;
  capturedAt: Date;
}

/**
 * Stored classroom photographs for one institution.
 *
 * `SessionImage` has no `institutionId` of its own, so the tenant is resolved
 * through the session it belongs to. Today this returns nothing for every
 * institution — no code path writes a `SessionImage` row, which is the
 * strongest form of the classroom-image guarantee. The sweep queries anyway,
 * because "nothing writes it" is a statement about the code as it is now, and
 * a retention policy that only works while a table stays empty is not one.
 */
export function listClassroomImagesForRetention(
  institutionId: string,
): Promise<ClassroomImageRow[]> {
  return prisma.sessionImage.findMany({
    where: { session: { institutionId } },
    select: { id: true, capturedAt: true },
  });
}

export async function deleteClassroomImages(
  institutionId: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await prisma.sessionImage.deleteMany({
    where: { id: { in: ids }, session: { institutionId } },
  });
  return result.count;
}

export function getInstitutionSettings(
  institutionId: string,
): Promise<{ id: string; settings: unknown } | null> {
  return prisma.institution.findUnique({
    where: { id: institutionId },
    select: { id: true, settings: true },
  });
}

/**
 * Writes the whole settings object back.
 *
 * Same read-modify-write shape, and the same accepted cost, as
 * `modules/integrations/repository.ts#writeInstitutionSettings`: one JSON
 * column, no partial update, and the writers are administrators on a settings
 * page rather than a request path. The codec in `policy.ts` preserves every
 * key it does not own and is tested for exactly that, so saving a retention
 * policy cannot erase an integration connection.
 */
export async function writeInstitutionSettings(
  institutionId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await prisma.institution.update({
    where: { id: institutionId },
    data: { settings: settings as never },
  });
}
