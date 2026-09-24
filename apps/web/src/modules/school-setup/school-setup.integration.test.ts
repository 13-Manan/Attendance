import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import type { SessionUser } from "../auth-tenancy/types.ts";
import {
  addSection,
  createClass,
  getClassDetail,
  getSectionDetail,
  removeSection,
  renameSection,
  setSectionTeacher,
} from "./service.ts";

/**
 * School setup against a real Postgres.
 *
 * The duplicate checks are check-then-write and rely on the per-school
 * advisory lock to be atomic; an in-memory stub runs both callers in one
 * thread and cannot show whether that holds. Removal relies on RESTRICT
 * foreign keys. Both are properties of the database, so they are tested there.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const INSTITUTION = "setup-it-inst";
const ADMIN = "setup-it-admin";
const TEACHER = "setup-it-teacher";
const OPERATOR = "setup-it-operator";
const STOPPED = "setup-it-stopped";
const YEAR_NOW = "setup-it-year-now";
const YEAR_NEXT = "setup-it-year-next";

const actor: SessionUser = {
  userId: ADMIN,
  email: "setup-it-admin@test.local",
  name: "Setup Admin",
  institutionId: INSTITUTION,
  campusId: null,
  roles: [
    {
      key: "SCHOOL_ADMIN",
      name: "School Admin",
      institutionId: INSTITUTION,
      campusId: null,
      permissions: ["academicStructure.manage", "cohort.manage", "user.invite"],
    },
  ],
};

const school = { institutionType: async () => "SCHOOL" as const };

async function cleanup() {
  const where = { institutionId: INSTITUTION };
  await prisma.auditLog.deleteMany({ where });
  await prisma.cohortFaculty.deleteMany({ where: { cohort: where } });
  await prisma.enrollment.deleteMany({ where });
  await prisma.student.deleteMany({ where });
  await prisma.cohort.deleteMany({ where });
  await prisma.academicUnit.deleteMany({ where: { ...where, kind: "SECTION" } });
  await prisma.academicUnit.deleteMany({ where });
  await prisma.academicSession.deleteMany({ where });
  await prisma.user.deleteMany({ where });
  await prisma.institution.deleteMany({ where: { id: INSTITUTION } });
}

async function makeStaff(id: string, roleKey: string, status: "ACTIVE" | "INACTIVE" = "ACTIVE") {
  const role = await prisma.role.findFirstOrThrow({ where: { key: roleKey, institutionId: null } });
  await prisma.user.create({
    data: {
      id,
      institutionId: INSTITUTION,
      email: `${id}@test.local`,
      name: id,
      passwordHash: "x",
      status,
      roleAssignments: { create: { roleId: role.id, institutionId: INSTITUTION } },
    },
  });
}

before(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.institution.create({ data: { id: INSTITUTION, name: "Setup IT", type: "SCHOOL" } });
  await makeStaff(ADMIN, "SCHOOL_ADMIN");
  await makeStaff(TEACHER, "FACULTY");
  await makeStaff(OPERATOR, "ATTENDANCE_OPERATOR");
  await makeStaff(STOPPED, "FACULTY", "INACTIVE");
  await prisma.academicSession.createMany({
    data: [
      {
        id: YEAR_NOW,
        institutionId: INSTITUTION,
        name: "2026-27",
        startDate: new Date("2026-06-01T00:00:00Z"),
        endDate: new Date("2027-03-31T00:00:00Z"),
        isCurrent: true,
      },
      {
        id: YEAR_NEXT,
        institutionId: INSTITUTION,
        name: "2027-28",
        startDate: new Date("2027-06-01T00:00:00Z"),
        endDate: new Date("2028-03-31T00:00:00Z"),
      },
    ],
  });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

const sections = (...names: string[]) => names.map((name) => ({ name }));

test("two administrators adding the same class at once create it once", { skip: SKIP }, async () => {
  const results = await Promise.allSettled([
    createClass(actor, { yearId: YEAR_NOW, className: "Class 8", sections: sections("A", "B") }, school),
    createClass(actor, { yearId: YEAR_NOW, className: "class  8", sections: sections("A", "B") }, school),
  ]);
  const ok = results.filter((result) => result.status === "fulfilled");
  const refused = results.filter((result) => result.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(refused.length, 1);
  assert.match(String((refused[0] as PromiseRejectedResult).reason.message), /already set up for 2026-27/);

  assert.equal(await prisma.academicUnit.count({ where: { institutionId: INSTITUTION, kind: "GRADE" } }), 1);
  assert.equal(
    await prisma.cohort.count({ where: { institutionId: INSTITUTION, academicSessionId: YEAR_NOW } }),
    2,
  );
});

test("a name that reads as an existing class is refused", { skip: SKIP }, async () => {
  await assert.rejects(
    () => createClass(actor, { yearId: YEAR_NOW, className: "Grade 8", sections: sections("A") }, school),
    // Either spelling may have won the race in the test above.
    /already has "class 8", which reads as the same class/i,
  );
});

test("teacher eligibility: active staff whose role can take attendance only", { skip: SKIP }, async () => {
  const classId = (await prisma.academicUnit.findFirstOrThrow({
    where: { institutionId: INSTITUTION, kind: "GRADE" },
  })).id;
  const detail = await getClassDetail(actor, classId, YEAR_NOW, school);
  assert.ok(detail);
  const offered = detail.teachers.map((teacher) => teacher.id).sort();
  assert.deepEqual(offered, [ADMIN, TEACHER].sort());

  const sectionA = detail.sections.find((section) => section.name === "A")!;
  await assert.rejects(
    () => setSectionTeacher(actor, { sectionId: sectionA.id, teacherId: OPERATOR }, school),
    /can't take attendance with their current role/,
  );
  await assert.rejects(
    () => setSectionTeacher(actor, { sectionId: sectionA.id, teacherId: STOPPED }, school),
    /access has been stopped/,
  );
  await assert.rejects(
    () => setSectionTeacher(actor, { sectionId: sectionA.id, teacherId: "someone-else" }, school),
    /does not belong to this school/,
  );

  await setSectionTeacher(actor, { sectionId: sectionA.id, teacherId: TEACHER }, school);
  await assert.rejects(
    () => setSectionTeacher(actor, { sectionId: sectionA.id, teacherId: TEACHER }, school),
    /already teaches this section/,
  );
  const links = await prisma.cohortFaculty.findMany({ where: { cohortId: sectionA.id } });
  assert.deepEqual(links.map((link) => [link.userId, link.role]), [[TEACHER, "PRIMARY"]]);

  // Replacing keeps one PRIMARY.
  await setSectionTeacher(actor, { sectionId: sectionA.id, teacherId: ADMIN }, school);
  const after = await prisma.cohortFaculty.findMany({ where: { cohortId: sectionA.id } });
  assert.deepEqual(after.map((link) => [link.userId, link.role]), [[ADMIN, "PRIMARY"]]);
});

test("a duplicate section name is refused case-insensitively", { skip: SKIP }, async () => {
  const classId = (await prisma.academicUnit.findFirstOrThrow({
    where: { institutionId: INSTITUTION, kind: "GRADE" },
  })).id;
  await assert.rejects(
    () => addSection(actor, { classId, yearId: YEAR_NOW, name: "a" }, school),
    /already has a section called "A"/,
  );
});

test("a section with a student is protected; an empty one is removed and audited", { skip: SKIP }, async () => {
  const classId = (await prisma.academicUnit.findFirstOrThrow({
    where: { institutionId: INSTITUTION, kind: "GRADE" },
  })).id;
  const detail = (await getClassDetail(actor, classId, YEAR_NOW, school))!;
  const sectionA = detail.sections.find((section) => section.name === "A")!;
  const sectionB = detail.sections.find((section) => section.name === "B")!;

  // A student who was placed and has since left still protects the section.
  const student = await prisma.student.create({
    data: { institutionId: INSTITUTION, studentCode: "S1", firstName: "Asha", lastName: "K" },
  });
  await prisma.enrollment.create({
    data: { institutionId: INSTITUTION, studentId: student.id, cohortId: sectionA.id, status: "INACTIVE" },
  });
  const blocked = (await getSectionDetail(actor, sectionA.id, school))!;
  assert.equal(blocked.removal.allowed, false);
  await assert.rejects(() => removeSection(actor, sectionA.id, school), /Section A can't be removed/);
  assert.equal(await prisma.cohort.count({ where: { id: sectionA.id } }), 1);

  const removed = await removeSection(actor, sectionB.id, school);
  assert.deepEqual(removed, { classId, classRemoved: false, name: "B" });
  assert.equal(await prisma.cohort.count({ where: { id: sectionB.id } }), 0);
  const audit = await prisma.auditLog.findFirst({
    where: { institutionId: INSTITUTION, action: "cohort.deleted", entityId: sectionB.id },
  });
  assert.ok(audit, "removal is audited");
});

test("next year reuses the class and sections; renaming there leaves this year alone", { skip: SKIP }, async () => {
  const created = await createClass(
    actor,
    { yearId: YEAR_NEXT, className: "Class 8", sections: sections("A", "B", "C", "D") },
    school,
  );
  assert.equal(await prisma.academicUnit.count({ where: { institutionId: INSTITUTION, kind: "GRADE" } }), 1);

  const nowA = await prisma.cohort.findFirstOrThrow({
    where: { institutionId: INSTITUTION, academicSessionId: YEAR_NOW, name: "8-A" },
    include: { academicUnit: true },
  });
  const nextA = await prisma.cohort.findFirstOrThrow({
    where: { id: { in: created.sectionIds }, name: "8-A" },
  });
  // Same section row, two years.
  assert.equal(nextA.academicUnitId, nowA.academicUnitId);

  await renameSection(actor, { sectionId: nextA.id, name: "Rose" }, school);
  const nowAAfter = await prisma.cohort.findUniqueOrThrow({
    where: { id: nowA.id },
    include: { academicUnit: true },
  });
  const nextAAfter = await prisma.cohort.findUniqueOrThrow({
    where: { id: nextA.id },
    include: { academicUnit: true },
  });
  assert.equal(nowAAfter.name, "8-A");
  assert.equal(nowAAfter.academicUnit.name, "A");
  assert.equal(nextAAfter.name, "8-Rose");
  assert.equal(nextAAfter.academicUnit.name, "Rose");

  // An empty section next year can be removed; the class stays for this year.
  const nextD = await prisma.cohort.findFirstOrThrow({ where: { id: { in: created.sectionIds }, name: "8-D" } });
  const removed = await removeSection(actor, nextD.id, school);
  assert.equal(removed.classRemoved, false);
});
