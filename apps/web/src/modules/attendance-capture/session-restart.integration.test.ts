import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "../auth-tenancy/types.ts";
import { cancelCaptureSession, startOrResumeCaptureSession } from "./service.ts";
import { createAttendanceSessionForRequest } from "../sessions/service.ts";
import { findSessionForDay } from "../offline-sync/repository.ts";

/**
 * "Discard session" followed by "Start attendance", against a real Postgres.
 *
 * The rule under test lives in the WHERE clause of the "today's session"
 * lookups, which every unit test replaces with a stub — so the stubbed suites
 * passed while a discarded session locked the class out for the rest of the
 * day. This suite runs the real service, repository and SQL.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const SCHOOL = "restart-it-school";
const COLLEGE = "restart-it-college";
const TEACHER = "restart-it-teacher";
const LECTURER = "restart-it-lecturer";
const CLASS_A = "restart-it-class-a";
const CLASS_B = "restart-it-class-b";
const COLLEGE_COHORT = "restart-it-college-cohort";
const COLLEGE_SUBJECT = "restart-it-college-subject";

const MONDAY = new Date("2026-03-09T04:00:00Z");
const TUESDAY = new Date("2026-03-10T04:00:00Z");

const CAPTURE_PERMISSIONS = ["attendanceSession.create", "attendanceSession.capture"];

function staff(userId: string, institutionId: string): SessionUser {
  return {
    userId,
    email: `${userId}@test.local`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [
      {
        key: "FACULTY",
        name: "Faculty",
        institutionId,
        campusId: null,
        permissions: CAPTURE_PERMISSIONS as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

const teacher = staff(TEACHER, SCHOOL);
const lecturer = staff(LECTURER, COLLEGE);

const on = (at: Date) => ({ now: () => at });

async function cleanup() {
  const where = { institutionId: { in: [SCHOOL, COLLEGE] } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.attendanceSession.deleteMany({ where });
  await prisma.cohortSubject.deleteMany({ where: { cohort: where } });
  await prisma.subject.deleteMany({ where });
  await prisma.cohortFaculty.deleteMany({ where: { cohort: where } });
  await prisma.cohort.deleteMany({ where });
  await prisma.academicUnit.deleteMany({ where });
  await prisma.academicSession.deleteMany({ where });
  await prisma.user.deleteMany({ where });
  await prisma.institution.deleteMany({ where: { id: { in: [SCHOOL, COLLEGE] } } });
}

async function makeInstitution(id: string, type: "SCHOOL" | "COLLEGE", userId: string) {
  await prisma.institution.create({ data: { id, name: id, type } });
  await prisma.user.create({
    data: { id: userId, institutionId: id, email: `${userId}@test.local`, name: userId, passwordHash: "x" },
  });
  await prisma.academicSession.create({
    data: {
      id: `${id}-year`,
      institutionId: id,
      name: "2025-26",
      startDate: new Date("2025-06-01T00:00:00Z"),
      endDate: new Date("2026-05-31T00:00:00Z"),
      isCurrent: true,
    },
  });
  await prisma.academicUnit.create({
    data: { id: `${id}-unit`, institutionId: id, kind: "GRADE", name: "Grade 8" },
  });
}

async function makeCohort(id: string, institutionId: string, facultyId: string) {
  await prisma.cohort.create({
    data: {
      id,
      institutionId,
      academicUnitId: `${institutionId}-unit`,
      academicSessionId: `${institutionId}-year`,
      name: id,
    },
  });
  await prisma.cohortFaculty.create({ data: { cohortId: id, userId: facultyId } });
}

before(async () => {
  if (SKIP) return;
  await cleanup();
  await makeInstitution(SCHOOL, "SCHOOL", TEACHER);
  await makeCohort(CLASS_A, SCHOOL, TEACHER);
  await makeCohort(CLASS_B, SCHOOL, TEACHER);
  await makeInstitution(COLLEGE, "COLLEGE", LECTURER);
  await makeCohort(COLLEGE_COHORT, COLLEGE, LECTURER);
  const subject = await prisma.subject.create({
    data: { institutionId: COLLEGE, code: "PHY101", name: "Physics" },
  });
  await prisma.cohortSubject.create({
    data: { id: COLLEGE_SUBJECT, cohortId: COLLEGE_COHORT, subjectId: subject.id, facultyId: LECTURER },
  });
});

beforeEach(async () => {
  if (SKIP) return;
  await prisma.auditLog.deleteMany({ where: { institutionId: { in: [SCHOOL, COLLEGE] } } });
  await prisma.attendanceSession.deleteMany({ where: { institutionId: { in: [SCHOOL, COLLEGE] } } });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

async function liveSessionsFor(cohortId: string) {
  return prisma.attendanceSession.count({ where: { cohortId, status: { not: "CANCELLED" } } });
}

test("start → discard → start again opens a fresh session the same day", { skip: SKIP }, async () => {
  const first = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  assert.equal(first.resumed, false);
  assert.equal(first.session.status, "CAPTURING");

  await cancelCaptureSession(teacher, first.session.id);

  const second = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  assert.equal(second.resumed, false, "a discarded session must not be resumed");
  assert.notEqual(second.session.id, first.session.id);
  assert.equal(second.session.status, "CAPTURING");

  // The discarded row survives for the audit trail, untouched.
  const discarded = await prisma.attendanceSession.findUniqueOrThrow({ where: { id: first.session.id } });
  assert.equal(discarded.status, "CANCELLED");
  assert.equal(await liveSessionsFor(CLASS_A), 1);
});

test("discarding repeatedly never leaves more than one live session", { skip: SKIP }, async () => {
  for (let i = 0; i < 3; i++) {
    const started = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
    assert.equal(started.resumed, false);
    await cancelCaptureSession(teacher, started.session.id);
  }
  const last = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  assert.equal(last.resumed, false);
  assert.equal(await liveSessionsFor(CLASS_A), 1);
  assert.equal(await prisma.attendanceSession.count({ where: { cohortId: CLASS_A } }), 4);
});

test("a live session is still resumed, not duplicated", { skip: SKIP }, async () => {
  const first = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  const again = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  assert.equal(again.resumed, true);
  assert.equal(again.session.id, first.session.id);

  await assert.rejects(
    () => createAttendanceSessionForRequest(teacher, { cohortId: CLASS_A, sessionDate: MONDAY }),
    /daily_session_already_exists/,
  );
  assert.equal(await liveSessionsFor(CLASS_A), 1);
});

test("a live session behind a discarded one is resumed, not duplicated", { skip: SKIP }, async () => {
  const discarded = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  await cancelCaptureSession(teacher, discarded.session.id);
  const live = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  const again = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  assert.equal(again.resumed, true);
  assert.equal(again.session.id, live.session.id);
});

test("a finalized register still blocks a second session that day", { skip: SKIP }, async () => {
  const started = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  await prisma.attendanceSession.update({ where: { id: started.session.id }, data: { status: "FINALIZED" } });

  await assert.rejects(
    () => startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY)),
    /session_locked:FINALIZED/,
  );
  await assert.rejects(
    () => createAttendanceSessionForRequest(teacher, { cohortId: CLASS_A, sessionDate: MONDAY }),
    /daily_session_already_exists/,
  );
  // Discard on a finalized register is a no-op, so it cannot be used to
  // side-step the block either.
  await cancelCaptureSession(teacher, started.session.id);
  await assert.rejects(
    () => startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY)),
    /session_locked:FINALIZED/,
  );
});

test("a discard affects only its own class and day", { skip: SKIP }, async () => {
  const classB = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_B }, on(MONDAY));
  const classATuesday = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(TUESDAY));
  const classAMonday = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  await cancelCaptureSession(teacher, classAMonday.session.id);

  const bAgain = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_B }, on(MONDAY));
  assert.equal(bAgain.resumed, true);
  assert.equal(bAgain.session.id, classB.session.id);

  const tuesdayAgain = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(TUESDAY));
  assert.equal(tuesdayAgain.resumed, true);
  assert.equal(tuesdayAgain.session.id, classATuesday.session.id);

  const mondayFresh = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  assert.equal(mondayFresh.resumed, false);
  assert.notEqual(mondayFresh.session.id, classAMonday.session.id);
  assert.notEqual(mondayFresh.session.id, classB.session.id);
});

test("subject-wise: a discarded lecture does not block starting it again", { skip: SKIP }, async () => {
  const input = { cohortId: COLLEGE_COHORT, cohortSubjectId: COLLEGE_SUBJECT };
  const first = await startOrResumeCaptureSession(lecturer, input, on(MONDAY));
  await cancelCaptureSession(lecturer, first.session.id);

  const second = await startOrResumeCaptureSession(lecturer, input, on(MONDAY));
  assert.equal(second.resumed, false);
  assert.notEqual(second.session.id, first.session.id);

  const third = await startOrResumeCaptureSession(lecturer, input, on(MONDAY));
  assert.equal(third.resumed, true);
  assert.equal(third.session.id, second.session.id);
});

test("offline sync resolves the day to the live session, not the discarded one", { skip: SKIP }, async () => {
  const discarded = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  await cancelCaptureSession(teacher, discarded.session.id);

  // Only the discarded one exists: returned as-is, so the sync service keeps
  // refusing with `session_cancelled` exactly as before.
  const alone = await findSessionForDay(CLASS_A, null, MONDAY);
  assert.equal(alone?.id, discarded.session.id);

  const live = await startOrResumeCaptureSession(teacher, { cohortId: CLASS_A }, on(MONDAY));
  const resolved = await findSessionForDay(CLASS_A, null, MONDAY);
  assert.equal(resolved?.id, live.session.id);
});
