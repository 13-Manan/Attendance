import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addSection,
  createClass,
  getClassesOverview,
  inviteTeacherForSection,
  removalCheck,
  removeSection,
  setSectionTeacher,
} from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import { SchoolSetupError } from "./types.ts";

/**
 * The refusals that happen before the database is touched: permission,
 * tenancy, institution type and input validation. What happens inside the
 * transaction is covered against Postgres in `school-setup.integration.test.ts`.
 */

function makeUser(permissions: string[], institutionId: string | null = "inst-A"): SessionUser {
  return {
    userId: "user-1",
    email: "admin@example.com",
    name: "Admin",
    institutionId,
    campusId: null,
    roles: [
      {
        key: "SCHOOL_ADMIN",
        name: "School Admin",
        institutionId,
        campusId: null,
        permissions: permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

const ADMIN = makeUser(["academicStructure.manage", "cohort.manage", "user.invite"]);
const school = { institutionType: async () => "SCHOOL" as const };
const college = { institutionType: async () => "COLLEGE" as const };

test("a user without cohort.manage cannot create a class", async () => {
  await assert.rejects(
    () =>
      createClass(
        makeUser(["academicStructure.manage"]),
        { yearId: "y", className: "Class 8", sections: [{ name: "A" }] },
        school,
      ),
    ForbiddenError,
  );
});

test("a college is refused: the school setup never writes to a college", async () => {
  await assert.rejects(
    () => createClass(ADMIN, { yearId: "y", className: "Class 8", sections: [{ name: "A" }] }, college),
    /for schools only/,
  );
  await assert.rejects(() => getClassesOverview(ADMIN, undefined, college), SchoolSetupError);
});

test("a platform account is refused before any lookup", async () => {
  let asked = false;
  await assert.rejects(
    () =>
      createClass(
        makeUser(["academicStructure.manage", "cohort.manage"], null),
        { yearId: "y", className: "Class 8", sections: [{ name: "A" }] },
        {
          institutionType: async () => {
            asked = true;
            return "SCHOOL";
          },
        },
      ),
    /not linked to a single school/,
  );
  assert.equal(asked, false);
});

test("an empty class name and duplicate section names are refused before writing", async () => {
  await assert.rejects(
    () => createClass(ADMIN, { yearId: "y", className: "  ", sections: [{ name: "A" }] }, school),
    /Enter a class name/,
  );
  await assert.rejects(
    () =>
      createClass(
        ADMIN,
        { yearId: "y", className: "Class 8", sections: [{ name: "A" }, { name: "b" }, { name: "B" }] },
        school,
      ),
    /"b" is used for more than one section/,
  );
  await assert.rejects(
    () => createClass(ADMIN, { yearId: "y", className: "Class 8", sections: [] }, school),
    /at least one section/,
  );
});

test("an empty section name is refused when adding a section", async () => {
  await assert.rejects(
    () => addSection(ADMIN, { classId: "c", yearId: "y", name: " " }, school),
    /Enter a section name/,
  );
});

test("assigning a teacher needs cohort.manage and a chosen teacher", async () => {
  await assert.rejects(
    () =>
      setSectionTeacher(makeUser(["academicStructure.manage"]), { sectionId: "s", teacherId: "t" }, school),
    ForbiddenError,
  );
  await assert.rejects(
    () => setSectionTeacher(ADMIN, { sectionId: "s", teacherId: " " }, school),
    /Choose a teacher/,
  );
});

test("adding a teacher's account needs user.invite as well", async () => {
  let invited = false;
  await assert.rejects(
    () =>
      inviteTeacherForSection(
        makeUser(["academicStructure.manage", "cohort.manage"]),
        { sectionId: "s", name: "N", email: "n@example.com" },
        {
          ...school,
          invite: async () => {
            invited = true;
            throw new Error("unreachable");
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(invited, false);
});

test("removing a section needs the structure permissions", async () => {
  await assert.rejects(() => removeSection(makeUser(["cohort.manage"]), "s", school), ForbiddenError);
});

test("removalCheck allows only a section nothing has happened in", () => {
  const none = { students: 0, currentStudents: 0, registers: 0, subjects: 0, externalLinks: 0 };
  const open = { name: "2027-28", isActive: true };
  assert.deepEqual(removalCheck(none, open), { allowed: true, reasons: [] });

  const busy = removalCheck(
    { students: 9, currentStudents: 8, registers: 1, subjects: 2, externalLinks: 1 },
    { name: "2026-27", isActive: false },
  );
  assert.equal(busy.allowed, false);
  assert.equal(busy.reasons.length, 5);
  assert.match(busy.reasons[0], /archived/);
  assert.match(busy.reasons[1], /9 students have been placed in this section \(8 still in it\)/);
  assert.match(busy.reasons[2], /Attendance has been taken for this section 1 time/);
  assert.match(busy.reasons[3], /2 subjects are set up/);
  assert.match(busy.reasons[4], /integration/);

  // A student who has since left still blocks: their history points here.
  const left = removalCheck({ ...none, students: 1 }, open);
  assert.equal(left.allowed, false);
  assert.match(left.reasons[0], /1 student has been placed in this section \(0 still in it\)/);
});
