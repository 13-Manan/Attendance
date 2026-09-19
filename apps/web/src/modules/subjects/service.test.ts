import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachSubjectToCohortForRequest,
  createSubjectForRequest,
  enrollStudentInSubjectForRequest,
  updateSubjectForRequest,
} from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Cohort } from "../cohorts/types.ts";
import type { Student } from "../students/types.ts";
import type { CohortSubject, StudentSubjectEnrollment, Subject } from "./types.ts";

function makeUser(overrides: Partial<SessionUser> & { permissions: string[]; roleKey?: string }): SessionUser {
  return {
    userId: overrides.userId ?? "user-1",
    email: overrides.email ?? "user@example.com",
    name: overrides.name ?? "Test User",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: overrides.campusId ?? null,
    roles: [
      {
        key: overrides.roleKey ?? "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: overrides.permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

test("a SCHOOL institution cannot create Subjects", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["academicStructure.manage"] });
  let called = false;
  await assert.rejects(
    () =>
      createSubjectForRequest(
        admin,
        { institutionId: "inst-A", code: "CS101", name: "DBMS" },
        {
          getInstitutionType: async () => "SCHOOL",
          createSubject: async () => {
            called = true;
            return {} as Subject;
          },
        },
      ),
    /subjects_are_college_only/,
  );
  assert.equal(called, false);
});

// The subject smuggle: caller belongs to inst-A, cohort belongs to inst-A,
// but the subject actually belongs to inst-B. Must be rejected before write.
test("attaching a Subject from another institution is denied", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["academicStructure.manage"] });
  let called = false;
  await assert.rejects(
    () =>
      attachSubjectToCohortForRequest(
        admin,
        { cohortId: "coh-1", subjectId: "subj-1" },
        {
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getSubjectById: async () => ({ id: "subj-1", institutionId: "inst-B" } as Subject),
          attachSubjectToCohort: async () => {
            called = true;
            return {} as CohortSubject;
          },
        },
      ),
    /cross_institution_subject/,
  );
  assert.equal(called, false);
});

test("attaching a Subject with a faculty from another institution is denied", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["academicStructure.manage"] });
  let called = false;
  await assert.rejects(
    () =>
      attachSubjectToCohortForRequest(
        admin,
        { cohortId: "coh-1", subjectId: "subj-1", facultyId: "user-x" },
        {
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getSubjectById: async () => ({ id: "subj-1", institutionId: "inst-A" } as Subject),
          getUserById: async () => ({ id: "user-x", institutionId: "inst-B" }),
          attachSubjectToCohort: async () => {
            called = true;
            return {} as CohortSubject;
          },
        },
      ),
    /cross_institution_faculty/,
  );
  assert.equal(called, false);
});

// Direct cross-tenant leak scenario: enrolling a student from inst-B into a
// college's subject in inst-A. Must be blocked so the vector-search scope
// (per-cohort enrolled students) can never quietly include another tenant's
// student.
test("enrolling a student from another institution into a subject is denied", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["enrollment.manage"] });
  let called = false;
  await assert.rejects(
    () =>
      enrollStudentInSubjectForRequest(
        admin,
        { studentId: "stu-x", cohortSubjectId: "cs-1" },
        {
          getCohortSubjectById: async () => ({ id: "cs-1", cohortId: "coh-1" } as CohortSubject),
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getStudentById: async () => ({ id: "stu-x", institutionId: "inst-B" } as Student),
          enrollStudentInSubject: async () => {
            called = true;
            return {} as StudentSubjectEnrollment;
          },
        },
      ),
    /cross_institution_student/,
  );
  assert.equal(called, false);
});

test("a faculty without enrollment.manage cannot enroll a student in a subject", async () => {
  const faculty = makeUser({
    roleKey: "FACULTY",
    institutionId: "inst-A",
    permissions: ["cohort.read", "student.read"],
  });
  await assert.rejects(
    () =>
      enrollStudentInSubjectForRequest(
        faculty,
        { studentId: "stu-1", cohortSubjectId: "cs-1" },
        {
          getCohortSubjectById: async () => ({ id: "cs-1", cohortId: "coh-1" } as CohortSubject),
          getCohortById: async () => ({ id: "coh-1", institutionId: "inst-A" } as Cohort),
          getStudentById: async () => ({ id: "stu-1", institutionId: "inst-A" } as Student),
          enrollStudentInSubject: async () => ({} as StudentSubjectEnrollment),
        },
      ),
    ForbiddenError,
  );
});

// ---------------------------------------------------------------------------
// Renaming
//
// The institution is not an argument, so the only way to reach another tenant's
// subject is by id — which is why the row is read and checked before anything
// is written. All three refusals below happen before the update, so the denial
// paths never touch the database.
// ---------------------------------------------------------------------------

test("renaming a subject from another institution is denied before the write", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["academicStructure.manage"] });
  let written = false;

  await assert.rejects(
    () =>
      updateSubjectForRequest(
        admin,
        { id: "sub-from-inst-B", code: "PHY301", name: "Quantum Mechanics" },
        {
          getSubjectById: async () =>
            ({ id: "sub-from-inst-B", institutionId: "inst-B" }) as Subject,
          updateSubject: async () => {
            written = true;
            return {} as Subject;
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(written, false);
});

test("renaming a subject that does not exist is refused", async () => {
  const admin = makeUser({ institutionId: "inst-A", permissions: ["academicStructure.manage"] });
  let written = false;

  await assert.rejects(
    () =>
      updateSubjectForRequest(
        admin,
        { id: "gone", code: "PHY301", name: "Quantum Mechanics" },
        {
          getSubjectById: async () => null,
          updateSubject: async () => {
            written = true;
            return {} as Subject;
          },
        },
      ),
    /subject_not_found/,
  );
  assert.equal(written, false);
});

test("a faculty cannot rename a subject", async () => {
  const faculty = makeUser({
    roleKey: "FACULTY",
    institutionId: "inst-A",
    permissions: ["cohort.read", "student.read"],
  });
  let read = false;

  await assert.rejects(
    () =>
      updateSubjectForRequest(
        faculty,
        { id: "sub-1", code: "PHY301", name: "Quantum Mechanics" },
        {
          getSubjectById: async () => {
            read = true;
            return { id: "sub-1", institutionId: "inst-A" } as Subject;
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(read, false, "the permission is checked before anything is read");
});
