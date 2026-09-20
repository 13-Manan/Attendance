import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import {
  linkExternalId,
  listExternalIdentities,
  listExternalIdsFor,
  resolveExternalId,
  unlinkExternalId,
} from "./external-identity.ts";
import { applyAttendanceCorrection } from "./repository.ts";
import { ApiError } from "./api-route.ts";

/**
 * Phase 10 — external identifiers, and the public-API correction race.
 *
 * Against a real database, because both things being tested are database
 * guarantees. The mapping's whole design rests on two composite unique
 * indexes, and the correction fix is a compare-and-set: stub either and the
 * test passes while the product stays broken. Phase 6 learned this the
 * expensive way — the in-memory stores serialise, so a concurrency defect is
 * invisible to a unit suite no matter how many cases it has.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const INST_A = "ext-inst-a";
const INST_B = "ext-inst-b";

async function seed() {
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: INST_A, name: "Institution A", type: "SCHOOL" },
      { id: INST_B, name: "Institution B", type: "SCHOOL" },
    ],
  });

  // The same external id in both tenants, naming two different people. This
  // is the collision the composite key exists for, so the fixture has to
  // actually contain it rather than describe it.
  for (const [inst, code] of [
    [INST_A, "A-1"],
    [INST_B, "B-1"],
  ] as const) {
    await prisma.student.create({
      data: {
        id: `stu-${inst}`,
        institutionId: inst,
        studentCode: code,
        firstName: "Test",
        lastName: "Student",
        status: "ACTIVE",
      },
    });
  }

  await prisma.student.create({
    data: {
      id: "stu-a-second",
      institutionId: INST_A,
      studentCode: "A-2",
      firstName: "Second",
      lastName: "Student",
      status: "ACTIVE",
    },
  });
}

async function cleanup() {
  for (const inst of [INST_A, INST_B]) {
    await prisma.externalIdentity.deleteMany({ where: { institutionId: inst } });
    await prisma.attendanceCorrection.deleteMany({
      where: { attendanceRecord: { institutionId: inst } },
    });
    await prisma.attendanceRecord.deleteMany({ where: { institutionId: inst } });
    await prisma.attendanceSession.deleteMany({ where: { institutionId: inst } });
    await prisma.enrollment.deleteMany({ where: { institutionId: inst } });
    await prisma.student.deleteMany({ where: { institutionId: inst } });
    await prisma.cohort.deleteMany({ where: { institutionId: inst } });
    await prisma.academicUnit.deleteMany({ where: { institutionId: inst } });
    await prisma.academicSession.deleteMany({ where: { institutionId: inst } });
    await prisma.user.deleteMany({ where: { institutionId: inst } });
    await prisma.institution.deleteMany({ where: { id: inst } });
  }
}

before(async () => {
  if (SKIP) return;
  await seed();
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// The collision the whole design turns on
// ---------------------------------------------------------------------------

test("the same vendor id in two institutions names two different students", { skip: SKIP }, async () => {
  const key = { provider: "erp-x", entityType: "STUDENT", externalId: "STU-10092" };

  await linkExternalId(INST_A, { ...key, internalId: `stu-${INST_A}` });
  await linkExternalId(INST_B, { ...key, internalId: `stu-${INST_B}` });

  assert.equal(await resolveExternalId(INST_A, key), `stu-${INST_A}`);
  assert.equal(await resolveExternalId(INST_B, key), `stu-${INST_B}`);
});

test("an institution cannot resolve another institution's mapping", { skip: SKIP }, async () => {
  await linkExternalId(INST_A, {
    provider: "erp-only-a",
    entityType: "STUDENT",
    externalId: "ONLY-IN-A",
    internalId: `stu-${INST_A}`,
  });
  assert.equal(
    await resolveExternalId(INST_B, {
      provider: "erp-only-a",
      entityType: "STUDENT",
      externalId: "ONLY-IN-A",
    }),
    null,
  );
});

test("a mapping cannot be created against another institution's record", { skip: SKIP }, async () => {
  // The tenancy check that makes a mapping trustworthy: without it this side
  // table would be a way to name a record the caller may not touch.
  await assert.rejects(
    () =>
      linkExternalId(INST_B, {
        provider: "erp-x",
        entityType: "STUDENT",
        externalId: "SMUGGLED",
        internalId: `stu-${INST_A}`,
      }),
    (error: unknown) => error instanceof ApiError && error.code === "not_found",
    "and it reads as not-found, so it cannot be used to probe for ids elsewhere",
  );
});

// ---------------------------------------------------------------------------
// Idempotency and the two unique keys
// ---------------------------------------------------------------------------

test("replaying an identical link is idempotent", { skip: SKIP }, async () => {
  const input = {
    provider: "sis",
    entityType: "STUDENT",
    externalId: "REPLAY-1",
    internalId: `stu-${INST_A}`,
  };
  const first = await linkExternalId(INST_A, input);
  const second = await linkExternalId(INST_A, input);
  assert.equal(second.id, first.id, "the same row, not a second one");
  assert.equal(
    (await prisma.externalIdentity.count({ where: { institutionId: INST_A, externalId: "REPLAY-1" } })),
    1,
  );
});

test("re-pointing an external id at another student updates in place", { skip: SKIP }, async () => {
  // Students are merged and re-keyed in real school offices. Forcing a delete
  // first would leave a window with no mapping at all.
  // Its own provider: `sis` is already bound to this student by the
  // idempotency test above, and the reverse unique key would rightly refuse.
  const key = { provider: "merge-sis", entityType: "STUDENT", externalId: "MOVES" };
  await linkExternalId(INST_A, { ...key, internalId: `stu-${INST_A}` });
  await linkExternalId(INST_A, { ...key, internalId: "stu-a-second" });

  assert.equal(await resolveExternalId(INST_A, key), "stu-a-second");
  assert.equal(
    await prisma.externalIdentity.count({ where: { institutionId: INST_A, externalId: "MOVES" } }),
    1,
  );
});

test("one student cannot hold two ids from the same provider", { skip: SKIP }, async () => {
  await linkExternalId(INST_A, {
    provider: "dup-guard",
    entityType: "STUDENT",
    externalId: "FIRST",
    internalId: `stu-${INST_A}`,
  });
  await assert.rejects(
    () =>
      linkExternalId(INST_A, {
        provider: "dup-guard",
        entityType: "STUDENT",
        externalId: "SECOND",
        internalId: `stu-${INST_A}`,
      }),
    (error: unknown) => error instanceof ApiError && error.code === "conflict",
    "because nothing here can tell which id the external system now means",
  );
});

test("the same id under two providers is fine", { skip: SKIP }, async () => {
  // An institution running an ERP and an LMS at once. Separate id spaces.
  await linkExternalId(INST_A, {
    provider: "erp-two",
    entityType: "STUDENT",
    externalId: "SHARED-42",
    internalId: `stu-${INST_A}`,
  });
  await linkExternalId(INST_A, {
    provider: "lms-two",
    entityType: "STUDENT",
    externalId: "SHARED-42",
    internalId: `stu-${INST_A}`,
  });
  const all = await listExternalIdsFor(INST_A, "STUDENT", `stu-${INST_A}`);
  assert.ok(all.filter((row) => row.externalId === "SHARED-42").length === 2);
});

test("provider names are matched case-insensitively, external ids are not", { skip: SKIP }, async () => {
  await linkExternalId(INST_A, {
    provider: "CaseErp",
    entityType: "STUDENT",
    externalId: "Case-Sensitive-1",
    internalId: `stu-${INST_A}`,
  });
  // "ERP-X" and "erp-x" are the same system typed twice.
  assert.equal(
    await resolveExternalId(INST_A, {
      provider: "caseerp",
      entityType: "STUDENT",
      externalId: "Case-Sensitive-1",
    }),
    `stu-${INST_A}`,
  );
  // The external id is the other system's own string; case-folding it would be
  // this platform deciding what their identifier means.
  assert.equal(
    await resolveExternalId(INST_A, {
      provider: "caseerp",
      entityType: "STUDENT",
      externalId: "case-sensitive-1",
    }),
    null,
  );
});

test("unlinking removes the mapping and nothing else", { skip: SKIP }, async () => {
  const key = { provider: "temp", entityType: "STUDENT", externalId: "GOES-AWAY" };
  await linkExternalId(INST_A, { ...key, internalId: `stu-${INST_A}` });

  assert.equal(await unlinkExternalId(INST_A, key), true);
  assert.equal(await resolveExternalId(INST_A, key), null);
  assert.equal(await unlinkExternalId(INST_A, key), false, "removing it twice is not an error");
  assert.ok(
    await prisma.student.findUnique({ where: { id: `stu-${INST_A}` } }),
    "the student is untouched — disconnecting an integration does not delete people",
  );
});

test("a listing is scoped to the caller's institution", { skip: SKIP }, async () => {
  const rows = await listExternalIdentities(INST_B);
  assert.ok(rows.length > 0);
  assert.ok(
    rows.every((row) => row.internalId === `stu-${INST_B}`),
    "nothing from institution A appears in institution B's list",
  );
});

test("an unknown entity type is refused rather than silently ignored", { skip: SKIP }, async () => {
  await assert.rejects(
    () =>
      linkExternalId(INST_A, {
        provider: "erp-x",
        entityType: "TIMETABLE",
        externalId: "X",
        internalId: `stu-${INST_A}`,
      }),
    (error: unknown) => error instanceof ApiError && error.code === "invalid_request",
  );
});

// ---------------------------------------------------------------------------
// The known follow-up: the public-API correction race
// ---------------------------------------------------------------------------

let seededSessions = 0;

/** Re-runnable: each test that needs a record calls this fresh. */
async function seedAttendanceRecord(): Promise<string> {
  await prisma.academicSession.upsert({
    where: { id: "ext-as" },
    create: {
      id: "ext-as",
      institutionId: INST_A,
      name: "2026-27",
      startDate: new Date("2026-06-01T00:00:00.000Z"),
      endDate: new Date("2027-05-31T00:00:00.000Z"),
    },
    update: {},
  });
  await prisma.academicUnit.upsert({
    where: { id: "ext-unit" },
    create: { id: "ext-unit", institutionId: INST_A, kind: "GRADE", name: "Grade 8" },
    update: {},
  });
  await prisma.cohort.upsert({
    where: { id: "ext-cohort" },
    create: {
      id: "ext-cohort",
      institutionId: INST_A,
      academicUnitId: "ext-unit",
      academicSessionId: "ext-as",
      name: "8A",
    },
    update: {},
  });
  await prisma.user.upsert({
    where: { id: "ext-user" },
    create: {
      id: "ext-user",
      institutionId: INST_A,
      email: "ext@test.local",
      name: "Teacher",
      passwordHash: "x",
      status: "ACTIVE",
    },
    update: {},
  });
  const session = await prisma.attendanceSession.create({
    data: {
      institutionId: INST_A,
      cohortId: "ext-cohort",
      facultyId: "ext-user",
      sessionDate: new Date(Date.UTC(2026, 8, 1 + seededSessions++)),
      startedAt: new Date("2026-09-21T09:00:00.000Z"),
      status: "FINALIZED",
    },
  });
  const record = await prisma.attendanceRecord.create({
    data: {
      institutionId: INST_A,
      sessionId: session.id,
      studentId: `stu-${INST_A}`,
      aiResult: "PRESENT",
      finalResult: "PRESENT",
    },
  });
  return record.id;
}

test("concurrent API corrections apply once and report the rest as conflicts", { skip: SKIP }, async () => {
  const recordId = await seedAttendanceRecord();

  // Measured before the fix: four concurrent calls produced four correction
  // rows, every one claiming it had changed PRESENT to ABSENT. Only the first
  // ever saw a PRESENT row; the other three recorded a transition that never
  // happened, against three real people's names.
  const outcomes = await Promise.all(
    Array.from({ length: 4 }, () =>
      applyAttendanceCorrection({
        institutionId: INST_A,
        recordId,
        previousResult: "PRESENT",
        newResult: "ABSENT",
        changedByUserId: "ext-user",
        reason: "concurrency regression",
      }),
    ),
  );

  const statuses = outcomes.map((outcome) => outcome.status).sort();
  assert.deepEqual(statuses, ["applied", "conflict", "conflict", "conflict"]);

  const corrections = await prisma.attendanceCorrection.findMany({
    where: { attendanceRecordId: recordId },
  });
  assert.equal(corrections.length, 1, "exactly one correction row");
  assert.equal(corrections[0].previousResult, "PRESENT", "and it tells the truth about the before");

  const record = await prisma.attendanceRecord.findUnique({ where: { id: recordId } });
  assert.equal(record?.finalResult, "ABSENT");
  assert.equal(record?.isManuallyCorrected, true);
});

test("a correction against a stale previousResult is refused, not forced", { skip: SKIP }, async () => {
  const recordId = await seedAttendanceRecord();
  await applyAttendanceCorrection({
    institutionId: INST_A,
    recordId,
    previousResult: "PRESENT",
    newResult: "ABSENT",
    changedByUserId: "ext-user",
    reason: "first",
  });

  // A second integration still believes the record is PRESENT.
  const stale = await applyAttendanceCorrection({
    institutionId: INST_A,
    recordId,
    previousResult: "PRESENT",
    newResult: "PRESENT",
    changedByUserId: "ext-user",
    reason: "stale view",
  });

  assert.equal(stale.status, "conflict");
  const record = await prisma.attendanceRecord.findUnique({ where: { id: recordId } });
  assert.equal(record?.finalResult, "ABSENT", "the earlier decision stands");
});

test("a correction for a record in another institution is not found", { skip: SKIP }, async () => {
  const recordId = await seedAttendanceRecord();
  const outcome = await applyAttendanceCorrection({
    institutionId: INST_B,
    recordId,
    previousResult: "PRESENT",
    newResult: "ABSENT",
    changedByUserId: "ext-user",
    reason: "cross tenant",
  });
  assert.equal(outcome.status, "not_found");
});
