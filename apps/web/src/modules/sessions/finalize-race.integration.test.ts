import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { transitionSessionStatus } from "./repository.ts";

/**
 * Phase 14 — the register closes once, however many people press Confirm.
 *
 * There was already a test called "two teachers pressing Confirm at once close
 * the register once". It runs against the in-memory store in
 * `attendance-review/attendance-engine.test.ts`, and an in-memory store
 * executes both callers in a single thread, one after the other: it proves the
 * code path, and it cannot prove the guard, because there is no concurrency
 * for the guard to survive. The Phase 10 correction race was found exactly
 * this way — the stub was green while Postgres let four writers through.
 *
 * So this runs the real compare-and-set against the real database. Postgres is
 * where `updateMany({ where: { status: from } })` either is atomic or is not.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const INSTITUTION = "race-inst";
const FACULTY = "race-faculty";
const COHORT = "race-cohort";
const SESSION = "race-session";
const UNIT = "race-unit";
const TERM = "race-term";

async function cleanup() {
  await prisma.attendanceSession.deleteMany({ where: { institutionId: INSTITUTION } });
  await prisma.cohort.deleteMany({ where: { institutionId: INSTITUTION } });
  await prisma.academicSession.deleteMany({ where: { institutionId: INSTITUTION } });
  await prisma.academicUnit.deleteMany({ where: { institutionId: INSTITUTION } });
  await prisma.user.deleteMany({ where: { institutionId: INSTITUTION } });
  await prisma.institution.deleteMany({ where: { id: INSTITUTION } });
}

before(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.institution.create({
    data: { id: INSTITUTION, name: "Race Test", type: "SCHOOL" },
  });
  await prisma.user.create({
    data: {
      id: FACULTY,
      institutionId: INSTITUTION,
      email: "race-faculty@test.local",
      name: "Faculty",
      passwordHash: "x",
      status: "ACTIVE",
    },
  });
  await prisma.academicUnit.create({
    data: { id: UNIT, institutionId: INSTITUTION, kind: "GRADE", name: "Race Grade" },
  });
  await prisma.academicSession.create({
    data: {
      id: TERM,
      institutionId: INSTITUTION,
      name: "2026-27",
      startDate: new Date("2026-04-01T00:00:00Z"),
      endDate: new Date("2027-03-31T00:00:00Z"),
    },
  });
  await prisma.cohort.create({
    data: {
      id: COHORT,
      institutionId: INSTITUTION,
      academicUnitId: UNIT,
      academicSessionId: TERM,
      name: "Race Class",
    },
  });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

async function freshSession(status: "REVIEW" | "OPEN" = "REVIEW") {
  await prisma.attendanceSession.deleteMany({ where: { id: SESSION } });
  await prisma.attendanceSession.create({
    data: {
      id: SESSION,
      institutionId: INSTITUTION,
      cohortId: COHORT,
      facultyId: FACULTY,
      sessionDate: new Date("2026-09-20T00:00:00Z"),
      status,
    },
  });
}

test("concurrent finalization closes the register exactly once", { skip: SKIP }, async () => {
  await freshSession("REVIEW");

  // Eight callers, launched together rather than awaited in turn. Anything
  // less than genuine parallelism here reproduces the stub's blind spot.
  const attempts = await Promise.allSettled(
    Array.from({ length: 8 }, () => transitionSessionStatus(SESSION, "REVIEW", "FINALIZED")),
  );

  const won = attempts.filter((a) => a.status === "fulfilled");
  const lost = attempts.filter((a) => a.status === "rejected");

  assert.equal(won.length, 1, `${won.length} callers believed they closed the register`);
  assert.equal(lost.length, 7);
  for (const failure of lost) {
    assert.match(
      String((failure as PromiseRejectedResult).reason?.message),
      /session_status_conflict/,
      "a loser must be told it lost, not given a silent success",
    );
  }

  const row = await prisma.attendanceSession.findUniqueOrThrow({ where: { id: SESSION } });
  assert.equal(row.status, "FINALIZED");
});

test("a finalized register cannot be reopened by a late caller", { skip: SKIP }, async () => {
  // The losing seven above must not succeed on a retry either: the guard is
  // the stored status, not a one-shot latch.
  await assert.rejects(
    () => transitionSessionStatus(SESSION, "REVIEW", "FINALIZED"),
    /session_status_conflict/,
  );
  const row = await prisma.attendanceSession.findUniqueOrThrow({ where: { id: SESSION } });
  assert.equal(row.status, "FINALIZED");
});

test("racing two different destinations still yields one winner", { skip: SKIP }, async () => {
  // Finalize versus reopen-to-review, arriving together. Whichever lands, the
  // other must be refused — the session must not end up in a state neither
  // caller asked for.
  await freshSession("REVIEW");

  const results = await Promise.allSettled([
    transitionSessionStatus(SESSION, "REVIEW", "FINALIZED"),
    transitionSessionStatus(SESSION, "REVIEW", "PROCESSING"),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const row = await prisma.attendanceSession.findUniqueOrThrow({ where: { id: SESSION } });
  assert.ok(["FINALIZED", "PROCESSING"].includes(row.status));
});

test("a transition from the wrong starting state is refused", { skip: SKIP }, async () => {
  await freshSession("OPEN");
  await assert.rejects(
    () => transitionSessionStatus(SESSION, "REVIEW", "FINALIZED"),
    /session_status_conflict/,
    "an OPEN session must not be closable by claiming it was in REVIEW",
  );
  const row = await prisma.attendanceSession.findUniqueOrThrow({ where: { id: SESSION } });
  assert.equal(row.status, "OPEN", "and the status must be untouched");
});
