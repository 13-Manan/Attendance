import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";

/**
 * Face enrollment, seen from an administrator's desk.
 *
 * ## What this module is for
 *
 * One question: which students can the recognition pipeline actually
 * recognise? Enrollment happens student by student on the student screens;
 * nobody standing there can see that a whole section was never enrolled, and
 * that section is the one where every capture returns "no match" on the first
 * morning of term.
 *
 * ## What it must never contain
 *
 * A vector, a photograph, or a URL to one. `FaceEmbedding.embedding` is an
 * `Unsupported("vector(512)")` column that the Prisma client cannot select,
 * and `sourceImageUrl` is not selected here either. Every query in this file
 * is a count or a group-by: the numbers describe the coverage, and nothing
 * leaves the database that could describe a face.
 *
 * ## Why it is read-only
 *
 * Enrollment and deactivation already exist, permission-gated, in
 * `service.ts`, with the quality gate and the audit rows that go with them. A
 * second write path from a coverage dashboard would be a way to add biometric
 * data without passing the gate.
 */

export interface CohortCoverage {
  cohortId: string;
  cohortName: string;
  termLabel: string | null;
  students: number;
  enrolled: number;
}

export interface ModelUsage {
  modelName: string;
  modelVersion: string;
  /** Samples, not students — a student may have several. */
  samples: number;
}

export interface UnenrolledStudent {
  id: string;
  studentCode: string;
  name: string;
}

export interface FaceCoverage {
  activeStudents: number;
  enrolledStudents: number;
  samples: number;
  cohorts: CohortCoverage[];
  models: ModelUsage[];
  /** A bounded sample of who is missing, so the number is actionable. */
  unenrolled: UnenrolledStudent[];
  unenrolledShown: number;
}

/** How many names to list. The count above it is the true total. */
const UNENROLLED_LIMIT = 100;

export interface CoverageDeps {
  countActiveStudents?: (institutionId: string) => Promise<number>;
  enrolledStudentIds?: (institutionId: string) => Promise<string[]>;
  modelUsage?: (institutionId: string) => Promise<ModelUsage[]>;
  cohortMembership?: (
    institutionId: string,
  ) => Promise<Array<{ cohortId: string; cohortName: string; termLabel: string | null; studentId: string }>>;
  studentsByIds?: (
    institutionId: string,
    limit: number,
  ) => Promise<Array<{ id: string; studentCode: string; firstName: string; lastName: string }>>;
}

async function countActiveStudents(institutionId: string): Promise<number> {
  return prisma.student.count({ where: { institutionId, status: "ACTIVE" } });
}

/**
 * The distinct students with at least one active sample.
 *
 * A `groupBy` on `studentId` rather than a `findMany`, so the embedding rows
 * themselves are never materialised — the result is a list of student ids and
 * nothing else.
 */
async function enrolledStudentIds(institutionId: string): Promise<string[]> {
  const rows = await prisma.faceEmbedding.groupBy({
    by: ["studentId"],
    where: { institutionId, isActive: true },
  });
  return rows.map((row) => row.studentId);
}

async function modelUsage(institutionId: string): Promise<ModelUsage[]> {
  const rows = await prisma.faceEmbedding.groupBy({
    by: ["modelName", "modelVersion"],
    where: { institutionId, isActive: true },
    _count: { _all: true },
  });
  return rows
    .map((row) => ({
      modelName: row.modelName,
      modelVersion: row.modelVersion,
      samples: row._count._all,
    }))
    .sort((a, b) => b.samples - a.samples);
}

async function cohortMembership(institutionId: string) {
  const rows = await prisma.enrollment.findMany({
    where: { institutionId, status: "ACTIVE" },
    select: {
      studentId: true,
      cohort: { select: { id: true, name: true, termLabel: true } },
    },
    take: 20000,
  });
  return rows.map((row) => ({
    cohortId: row.cohort.id,
    cohortName: row.cohort.name,
    termLabel: row.cohort.termLabel,
    studentId: row.studentId,
  }));
}

async function activeStudentsForListing(institutionId: string, limit: number) {
  return prisma.student.findMany({
    where: { institutionId, status: "ACTIVE" },
    select: { id: true, studentCode: true, firstName: true, lastName: true },
    orderBy: [{ studentCode: "asc" }],
    // Over-read deliberately: the enrolled ones are filtered out in memory, so
    // the page can still fill its list when most students are already done.
    take: limit,
  });
}

function deps(overrides: CoverageDeps) {
  return {
    countActiveStudents: overrides.countActiveStudents ?? countActiveStudents,
    enrolledStudentIds: overrides.enrolledStudentIds ?? enrolledStudentIds,
    modelUsage: overrides.modelUsage ?? modelUsage,
    cohortMembership: overrides.cohortMembership ?? cohortMembership,
    studentsByIds: overrides.studentsByIds ?? activeStudentsForListing,
  };
}

/** Pure: turns the five reads into the view model. Exported for the test. */
export function summarise(
  activeStudents: number,
  enrolledIds: readonly string[],
  models: readonly ModelUsage[],
  membership: ReadonlyArray<{
    cohortId: string;
    cohortName: string;
    termLabel: string | null;
    studentId: string;
  }>,
  candidates: ReadonlyArray<{
    id: string;
    studentCode: string;
    firstName: string;
    lastName: string;
  }>,
): FaceCoverage {
  const enrolled = new Set(enrolledIds);

  const byCohort = new Map<string, CohortCoverage>();
  for (const row of membership) {
    const existing = byCohort.get(row.cohortId) ?? {
      cohortId: row.cohortId,
      cohortName: row.cohortName,
      termLabel: row.termLabel,
      students: 0,
      enrolled: 0,
    };
    existing.students += 1;
    if (enrolled.has(row.studentId)) existing.enrolled += 1;
    byCohort.set(row.cohortId, existing);
  }

  const missing = candidates.filter((student) => !enrolled.has(student.id));

  return {
    activeStudents,
    enrolledStudents: enrolled.size,
    samples: models.reduce((total, model) => total + model.samples, 0),
    // Worst coverage first: this list is a to-do, and a section at 12% should
    // not be below one at 100% because of its name.
    cohorts: [...byCohort.values()].sort(
      (a, b) => a.enrolled / (a.students || 1) - b.enrolled / (b.students || 1),
    ),
    models: [...models],
    unenrolled: missing.slice(0, UNENROLLED_LIMIT).map((student) => ({
      id: student.id,
      studentCode: student.studentCode,
      name: `${student.firstName} ${student.lastName}`.trim(),
    })),
    unenrolledShown: Math.min(missing.length, UNENROLLED_LIMIT),
  };
}

/**
 * Institution-wide coverage.
 *
 * Gated on `faceEmbedding.manage` rather than `institution.read`: this is the
 * biometric module, and who is and is not enrolled is information about
 * students' bodies being processed, not a configuration page. The tenant comes
 * from the session — this function takes no institution id.
 */
export async function getFaceCoverage(
  actor: SessionUser,
  overrides: CoverageDeps = {},
): Promise<FaceCoverage> {
  const d = deps(overrides);
  requirePermission(actor, "faceEmbedding.manage");
  if (!actor.institutionId) {
    throw new Error("face_coverage_requires_institution");
  }
  const institutionId = actor.institutionId;

  const [activeStudents, enrolledIds, models, membership, candidates] = await Promise.all([
    d.countActiveStudents(institutionId),
    d.enrolledStudentIds(institutionId),
    d.modelUsage(institutionId),
    d.cohortMembership(institutionId),
    d.studentsByIds(institutionId, 1000),
  ]);

  return summarise(activeStudents, enrolledIds, models, membership, candidates);
}
