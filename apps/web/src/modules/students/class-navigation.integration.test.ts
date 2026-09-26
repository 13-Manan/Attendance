import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  getStudentClassForRequest,
  getStudentClassesForRequest,
  getStudentSectionForRequest,
  listSectionStudentsForRequest,
} from "./class-navigation-service";
import {
  assignStudentToClassForRequest,
  createStudentForRequest,
  getStudentForRequest,
  listStudentsForRequest,
  removeStudentFromClassForRequest,
} from "./directory-service";
import { EMPTY_STUDENT_FILTERS, type StudentFilters } from "./directory-filters";
import { studentSectionHref } from "./class-navigation-paths";
import { resolveStudentOrigin } from "./record-origin";

/**
 * Students by class and section, against the real database: the queries the
 * class-first Students pages run, and the existing workflows — adding a
 * student, moving one — whose results those pages have to reflect.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 *
 * The school: 2nd (sections A and B) and 10th (A) in the current year; 3rd
 * only last year. In 2nd-A now: Aarav and Bela on roll, Chand archived but
 * never taken out, Dev taken out (moved to 2nd-B). Esha was in 2nd-A last
 * year — and, as the directory has always counted it, that placement was
 * never ended, so she is not "unplaced"; Hana has never been placed. A second
 * school has its own "2nd", and a college has no classes of this kind at all.
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const P = "clsnav-";
const I1 = `${P}school-1`;
const I2 = `${P}school-2`;
const I3 = `${P}college`;
const Y_OLD = `${P}y2025`;
const Y_CUR = `${P}y2026`;

const id = (name: string) => `${P}${name}`;
const U2 = id("u-2nd");
const U10 = id("u-10th");
const U3 = id("u-3rd");
const C2A = id("c-2a");
const C2B = id("c-2b");
const C2A_OLD = id("c-2a-old");
const C10A = id("c-10a");
const C3A_OLD = id("c-3a-old");
const SESSION_2A = id("session-2a");
const EMBEDDING_AARAV = id("face-aarav");

const S = {
  aarav: id("s-aarav"),
  bela: id("s-bela"),
  chand: id("s-chand"),
  dev: id("s-dev"),
  esha: id("s-esha"),
  farid: id("s-farid"),
  hana: id("s-hana"),
  zoya: id("s-zoya"),
};

function admin(institutionId: string): SessionUser {
  return {
    userId: `${institutionId}-admin`,
    email: `${institutionId}-admin@test.local`,
    name: "Principal",
    institutionId,
    campusId: null,
    roles: [
      {
        key: "SCHOOL_ADMIN",
        name: "School Admin",
        institutionId,
        campusId: null,
        permissions: ["student.read", "student.create", "student.update", "enrollment.manage", "cohort.read"],
      },
    ],
  };
}
const A1 = admin(I1);
const A2 = admin(I2);
const A3 = admin(I3);

async function cleanup() {
  const institutions = { in: [I1, I2, I3] };
  await prisma.attendanceRecord.deleteMany({ where: { institutionId: institutions } });
  await prisma.attendanceSession.deleteMany({ where: { institutionId: institutions } });
  await prisma.faceEmbedding.deleteMany({ where: { institutionId: institutions } });
  await prisma.enrollment.deleteMany({ where: { institutionId: institutions } });
  await prisma.cohortFaculty.deleteMany({ where: { cohort: { institutionId: institutions } } });
  await prisma.student.deleteMany({ where: { institutionId: institutions } });
  await prisma.cohort.deleteMany({ where: { institutionId: institutions } });
  await prisma.academicUnit.deleteMany({ where: { institutionId: institutions, kind: "SECTION" } });
  await prisma.academicUnit.deleteMany({ where: { institutionId: institutions } });
  await prisma.academicSession.deleteMany({ where: { institutionId: institutions } });
  await prisma.auditLog.deleteMany({ where: { institutionId: institutions } });
  await prisma.user.deleteMany({ where: { institutionId: institutions } });
  await prisma.institution.deleteMany({ where: { id: institutions } });
}

async function unit(institutionId: string, unitId: string, kind: "GRADE" | "SECTION", name: string, parentId?: string, sortOrder = 0) {
  await prisma.academicUnit.create({ data: { id: unitId, institutionId, kind, name, parentId, sortOrder } });
}

async function cohort(institutionId: string, cohortId: string, unitId: string, yearId: string, name: string) {
  await prisma.cohort.create({ data: { id: cohortId, institutionId, academicUnitId: unitId, academicSessionId: yearId, name } });
}

async function student(institutionId: string, studentId: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  await prisma.student.create({
    data: { id: studentId, institutionId, studentCode: studentId, firstName: studentId.slice(P.length + 2), lastName: "Test", status },
  });
}

async function place(institutionId: string, studentId: string, cohortId: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  await prisma.enrollment.create({ data: { institutionId, studentId, cohortId, status } });
}

async function teacher(institutionId: string, userId: string, name: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  await prisma.user.create({
    data: { id: userId, institutionId, email: `${userId}@test.local`, name, passwordHash: "x", status },
  });
}

before(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: I1, name: "School One", type: "SCHOOL" },
      { id: I2, name: "School Two", type: "SCHOOL" },
      { id: I3, name: "A College", type: "COLLEGE" },
    ],
  });
  for (const institutionId of [I1, I2, I3]) {
    await prisma.user.create({
      data: { id: `${institutionId}-admin`, institutionId, email: `${institutionId}-admin@test.local`, name: "Principal", passwordHash: "x", status: "ACTIVE" },
    });
  }
  await prisma.academicSession.createMany({
    data: [
      { id: Y_OLD, institutionId: I1, name: "2025-26", startDate: new Date("2025-04-01T00:00:00Z"), endDate: new Date("2026-03-31T00:00:00Z"), isCurrent: false },
      { id: Y_CUR, institutionId: I1, name: "2026-27", startDate: new Date("2026-04-01T00:00:00Z"), endDate: new Date("2027-03-31T00:00:00Z"), isCurrent: true },
      { id: id("y2-cur"), institutionId: I2, name: "2026-27", startDate: new Date("2026-04-01T00:00:00Z"), endDate: new Date("2027-03-31T00:00:00Z"), isCurrent: true },
    ],
  });

  // School one.
  await unit(I1, U2, "GRADE", "2nd");
  await unit(I1, U10, "GRADE", "10th");
  await unit(I1, U3, "GRADE", "3rd");
  await unit(I1, id("u-2nd-a"), "SECTION", "A", U2, 0);
  await unit(I1, id("u-2nd-b"), "SECTION", "B", U2, 1);
  await unit(I1, id("u-10th-a"), "SECTION", "A", U10, 0);
  await unit(I1, id("u-3rd-a"), "SECTION", "A", U3, 0);
  await cohort(I1, C2A, id("u-2nd-a"), Y_CUR, "2-A");
  await cohort(I1, C2B, id("u-2nd-b"), Y_CUR, "2-B");
  await cohort(I1, C2A_OLD, id("u-2nd-a"), Y_OLD, "2-A");
  await cohort(I1, C10A, id("u-10th-a"), Y_CUR, "10-A");
  await cohort(I1, C3A_OLD, id("u-3rd-a"), Y_OLD, "3-A");

  await teacher(I1, id("t-sharma"), "Mrs. Sharma");
  await teacher(I1, id("t-kumar"), "Mr. Kumar");
  await teacher(I1, id("t-helper"), "Ms. Helper");
  await teacher(I1, id("t-gone"), "Mrs. Gone", "INACTIVE");
  await prisma.cohortFaculty.createMany({
    data: [
      { cohortId: C2A, userId: id("t-helper"), role: "ASSISTANT" },
      { cohortId: C2A, userId: id("t-sharma"), role: "PRIMARY" },
      { cohortId: C2B, userId: id("t-kumar"), role: "PRIMARY" },
      { cohortId: C10A, userId: id("t-gone"), role: "PRIMARY" },
    ],
  });

  await student(I1, S.aarav);
  await student(I1, S.bela);
  await student(I1, S.chand, "INACTIVE");
  await student(I1, S.dev);
  await student(I1, S.esha);
  await student(I1, S.farid);
  await student(I1, S.hana);
  await place(I1, S.aarav, C2A);
  await place(I1, S.bela, C2A);
  await place(I1, S.chand, C2A);
  await place(I1, S.dev, C2A, "INACTIVE");
  await place(I1, S.dev, C2B);
  await place(I1, S.esha, C2A_OLD);
  await place(I1, S.farid, C10A);

  // Aarav's history, which a move must leave alone.
  const vector = `[${Array.from({ length: 128 }, (_, i) => (i === 0 ? 1 : 0)).join(",")}]`;
  await prisma.$executeRaw`
    INSERT INTO "FaceEmbedding" (id, "institutionId", "studentId", embedding, "modelName", "modelVersion", "embeddingDim", "isActive")
    VALUES (${EMBEDDING_AARAV}, ${I1}, ${S.aarav}, ${vector}::vector, 'clsnav-model', '1', 128, TRUE)`;
  await prisma.attendanceSession.create({
    data: { id: SESSION_2A, institutionId: I1, cohortId: C2A, facultyId: id("t-sharma"), sessionDate: new Date("2026-09-20T00:00:00Z"), status: "FINALIZED" },
  });
  await prisma.attendanceRecord.create({
    data: { institutionId: I1, sessionId: SESSION_2A, studentId: S.aarav, aiResult: "PRESENT", finalResult: "PRESENT", matchedEmbeddingId: EMBEDDING_AARAV },
  });

  // School two: its own 2nd-A, with its own student.
  await unit(I2, id("u2-2nd"), "GRADE", "2nd");
  await unit(I2, id("u2-2nd-a"), "SECTION", "A", id("u2-2nd"));
  await cohort(I2, id("c2-2a"), id("u2-2nd-a"), id("y2-cur"), "2-A");
  await student(I2, S.zoya);
  await place(I2, S.zoya, id("c2-2a"));
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

async function sectionIds(actor: SessionUser, sectionId: string, filters: Partial<StudentFilters> = {}) {
  const page = await listSectionStudentsForRequest(actor, sectionId, { ...EMPTY_STUDENT_FILTERS, ...filters });
  return page.rows.map((row) => row.id).sort();
}

// ---------------------------------------------------------------------------

test("the classes are this school's, for the current academic year, counted on roll", { skip: SKIP }, async () => {
  const view = await getStudentClassesForRequest(A1);
  assert.ok(view);
  assert.equal(view.year?.id, Y_CUR);
  assert.deepEqual(view.classes.map((c) => c.name), ["2nd", "10th"], "3rd has no sections this year");
  const second = view.classes.find((c) => c.name === "2nd")!;
  assert.equal(second.sectionCount, 2);
  // Aarav, Bela, Dev. Not Chand (archived), not Esha (last year).
  assert.equal(second.studentCount, 3);
  assert.equal(view.classes.find((c) => c.name === "10th")!.studentCount, 1);
});

test("another academic year shows that year's classes and no other's", { skip: SKIP }, async () => {
  const view = await getStudentClassesForRequest(A1, Y_OLD);
  assert.equal(view?.year?.id, Y_OLD);
  assert.deepEqual(view?.classes.map((c) => c.name), ["2nd", "3rd"]);
  assert.equal(view?.classes.find((c) => c.name === "2nd")!.studentCount, 1, "Esha only");
});

test("a class shows only its sections, each with its class teacher and students on roll", { skip: SKIP }, async () => {
  const view = await getStudentClassForRequest(A1, U2);
  assert.ok(view);
  assert.deepEqual(view.sections.map((s) => s.label), ["Section A", "Section B"]);
  const [a, b] = view.sections;
  assert.equal(a!.id, C2A);
  assert.deepEqual(a!.classTeacher, { name: "Mrs. Sharma", active: true }, "the PRIMARY teacher, not the assistant");
  assert.equal(a!.studentCount, 2);
  assert.equal(b!.classTeacher?.name, "Mr. Kumar");
  assert.equal(b!.studentCount, 1);

  const tenth = await getStudentClassForRequest(A1, U10);
  assert.deepEqual(tenth?.sections[0]!.classTeacher, { name: "Mrs. Gone", active: false });
});

test("a section lists only its own students, by the directory's rules", { skip: SKIP }, async () => {
  // Every status by default, as in the directory: Chand is archived but was
  // never taken out, and shows as archived. Dev (moved to B), Esha (last
  // year's 2-A), Farid (10th) and Zoya (another school) are not here.
  assert.deepEqual(await sectionIds(A1, C2A), [S.aarav, S.bela, S.chand].sort());
  assert.deepEqual(await sectionIds(A1, C2A, { status: "ACTIVE" }), [S.aarav, S.bela].sort());
  assert.deepEqual(await sectionIds(A1, C2B), [S.dev]);

  const page = await listSectionStudentsForRequest(A1, C2A, EMPTY_STUDENT_FILTERS);
  assert.equal(page.totalAll, 3, "counted over the section, not the school");
  assert.equal(page.activeAll, 2);
  // Search and sort are the directory's own.
  assert.deepEqual(await sectionIds(A1, C2A, { q: "bela" }), [S.bela]);
  const byCodeDesc = await listSectionStudentsForRequest(A1, C2A, { ...EMPTY_STUDENT_FILTERS, sort: "code_desc" });
  assert.deepEqual(byCodeDesc.rows.map((r) => r.id), [S.chand, S.bela, S.aarav]);
});

test("another school's classes and sections are not found, and show none of its students", { skip: SKIP }, async () => {
  assert.equal(await getStudentClassForRequest(A2, U2), null);
  assert.equal(await getStudentSectionForRequest(A2, U2, C2A), null);
  assert.deepEqual(await sectionIds(A2, C2A), [], "a crafted section id reaches no one");
  // School two sees its own 2nd, with only its own student.
  const two = await getStudentClassesForRequest(A2);
  assert.deepEqual(two?.classes.map((c) => [c.name, c.studentCount]), [["2nd", 1]]);
});

test("a section reached through another class is not found", { skip: SKIP }, async () => {
  assert.equal(await getStudentSectionForRequest(A1, U10, C2A), null);
  assert.equal((await getStudentSectionForRequest(A1, U2, C2A))?.section.label, "Section A");
});

test("a college has no class-first view", { skip: SKIP }, async () => {
  assert.equal(await getStudentClassesForRequest(A3), null);
});

test("a student added from a section is placed in it and listed there", { skip: SKIP }, async () => {
  // What the Add student form submits: blank optional fields arrive as "".
  const created = await createStudentForRequest(A1, {
    studentCode: id("new-1"),
    firstName: "Gita",
    lastName: "Test",
    email: "",
    phone: "",
    campusId: "",
    admissionNumber: "",
    admissionDate: "",
    cohortId: C2A,
  });
  assert.ok((await sectionIds(A1, C2A)).includes(created.id));
  const section = await getStudentSectionForRequest(A1, U2, C2A);
  assert.equal(section?.section.studentCount, 3, "Aarav, Bela and Gita on roll");
  const record = await getStudentForRequest(A1, created.id);
  assert.deepEqual(record.classes.map((c) => c.cohortId), [C2A]);
});

test("moving a student A → B with the existing placement controls moves them between the lists", { skip: SKIP }, async () => {
  const before = await getStudentForRequest(A1, S.aarav);
  await assignStudentToClassForRequest(A1, { studentId: S.aarav, cohortId: C2B });
  await removeStudentFromClassForRequest(A1, { studentId: S.aarav, cohortId: C2A });

  assert.equal((await sectionIds(A1, C2A)).includes(S.aarav), false, "gone from A");
  assert.ok((await sectionIds(A1, C2B)).includes(S.aarav), "in B");

  // The same student: one row, the same code, history kept, face and
  // attendance untouched.
  assert.equal(await prisma.student.count({ where: { studentCode: S.aarav } }), 1);
  const after = await getStudentForRequest(A1, S.aarav);
  assert.equal(after.id, before.id);
  assert.equal(after.studentCode, before.studentCode);
  assert.deepEqual(after.classes.map((c) => c.cohortId), [C2B]);
  assert.ok(after.allClasses.some((c) => c.cohortId === C2A && c.status !== "ACTIVE"), "2nd-A is in their history");
  const face = await prisma.faceEmbedding.findUnique({ where: { id: EMBEDDING_AARAV }, select: { isActive: true, studentId: true } });
  assert.deepEqual(face, { isActive: true, studentId: S.aarav });
  const register = await prisma.attendanceRecord.findUnique({
    where: { sessionId_studentId: { sessionId: SESSION_2A, studentId: S.aarav } },
    select: { finalResult: true, matchedEmbeddingId: true },
  });
  assert.deepEqual(register, { finalResult: "PRESENT", matchedEmbeddingId: EMBEDDING_AARAV });

  const view = await getStudentClassForRequest(A1, U2);
  assert.deepEqual(view?.sections.map((s) => [s.label, s.studentCount]), [
    ["Section A", 2],
    ["Section B", 2],
  ]);
});

test("the whole-school directory is unchanged: search, status, class filter and sort", { skip: SKIP }, async () => {
  const all = await listStudentsForRequest(A1, EMPTY_STUDENT_FILTERS);
  // Aarav, Bela, Chand (archived), Dev, Esha, Farid, Hana and Gita (added above).
  assert.equal(all.totalAll, 8, "the tally is still institution-wide");
  assert.equal(all.activeAll, 7);
  const search = await listStudentsForRequest(A1, { ...EMPTY_STUDENT_FILTERS, q: "farid" });
  assert.deepEqual(search.rows.map((r) => r.id), [S.farid]);
  const archived = await listStudentsForRequest(A1, { ...EMPTY_STUDENT_FILTERS, status: "INACTIVE" });
  assert.deepEqual(archived.rows.map((r) => r.id), [S.chand]);
  const classFilter = await listStudentsForRequest(A1, { ...EMPTY_STUDENT_FILTERS, cohortId: C2B });
  assert.deepEqual(classFilter.rows.map((r) => r.id).sort(), [S.aarav, S.dev].sort());
  const unplaced = await listStudentsForRequest(A1, { ...EMPTY_STUDENT_FILTERS, cohortId: "none" });
  assert.deepEqual(unplaced.rows.map((r) => r.id), [S.hana]);
  const sorted = await listStudentsForRequest(A1, { ...EMPTY_STUDENT_FILTERS, cohortId: C2A, sort: "code" });
  const codes = sorted.rows.map((r) => r.studentCode);
  assert.deepEqual(codes, [id("new-1"), S.bela, S.chand], "Gita, Bela, Chand — by code");
});

// ---------------------------------------------------------------------------
// "Back to …" from a student's record: the list it was opened from, named
// through that list's own checks, or nothing — never another school's name.
// ---------------------------------------------------------------------------

test("a record opened from a section leads back to it, by name, filters kept", { skip: SKIP }, async () => {
  const section = `${studentSectionHref(U2, C2A)}?q=aarav`;
  assert.deepEqual(await resolveStudentOrigin(A1, section), { label: "2nd · Section A", href: section });
});

test("another school's section, or one reached through the wrong class, is no origin", { skip: SKIP }, async () => {
  assert.equal(await resolveStudentOrigin(A2, studentSectionHref(U2, C2A)), null);
  assert.equal(await resolveStudentOrigin(A1, studentSectionHref(U10, C2A)), null);
  assert.equal(await resolveStudentOrigin(A3, studentSectionHref(U2, C2A)), null);
  assert.equal(await resolveStudentOrigin(A1, studentSectionHref(U2, id("no-such-section"))), null);
});

test("a class roster is an origin only for someone who may open it", { skip: SKIP }, async () => {
  const roster = `/dashboard/academic/cohorts/${C2A}`;
  const { name } = await prisma.cohort.findUniqueOrThrow({ where: { id: C2A }, select: { name: true } });
  assert.deepEqual(await resolveStudentOrigin(A1, roster), { label: name, href: roster });
  assert.equal(await resolveStudentOrigin(A2, roster), null, "another school's roster");

  const readOnly: SessionUser = { ...A1, roles: [{ ...A1.roles[0], permissions: ["student.read"] }] };
  assert.equal(await resolveStudentOrigin(readOnly, roster), null, "no cohort.read");
  assert.equal(await resolveStudentOrigin(readOnly, studentSectionHref(U2, C2A)), null, "no cohort.read");
});
