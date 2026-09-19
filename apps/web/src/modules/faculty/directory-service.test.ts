import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deactivateFaculty,
  getFacultyDirectory,
  inviteFaculty,
  reactivateFaculty,
  removeClassTeacher,
  resetFacultyPassword,
  setSubjectFaculty,
  updateFacultyDetails,
  type FacultyDeps,
} from "./directory-service.ts";
import { EMPTY_FACULTY_FILTERS } from "./directory-filters.ts";
import { FacultyError } from "./directory-types.ts";
import type { RecordAuditLogInput } from "../audit/types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Faculty administration: who may do it, whose institution it lands in, and
 * what must never come back out.
 *
 * The negative assertions are the ones that matter. A temporary password may
 * not reach an audit row, an administrator may not lock themselves out, and no
 * id arriving in a form may reach across a tenant boundary. Everything is
 * injected, so none of it needs a database.
 */

type Permissions = SessionUser["roles"][number]["permissions"];

const ALL: string[] = [
  "institution.read",
  "user.invite",
  "user.update",
  "user.deactivate",
  "cohort.manage",
];

function makeUser(
  overrides: { permissions?: string[]; institutionId?: string | null; userId?: string } = {},
): SessionUser {
  return {
    userId: overrides.userId ?? "user-admin",
    email: "admin@example.edu",
    name: "Admin",
    institutionId: overrides.institutionId === undefined ? "inst-1" : overrides.institutionId,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: "inst-1",
        campusId: null,
        permissions: (overrides.permissions ?? ALL) as Permissions,
      },
    ],
  };
}

const ADMIN = makeUser();
const READER = makeUser({ userId: "user-reader", permissions: ["institution.read"] });

type StaffRow = Awaited<ReturnType<NonNullable<FacultyDeps["getStaff"]>>>;

function staff(overrides: Partial<NonNullable<StaffRow>> = {}): NonNullable<StaffRow> {
  return {
    id: "user-teacher",
    name: "R Sharma",
    email: "r.sharma@example.edu",
    employeeCode: "T-14",
    status: "ACTIVE",
    departmentId: null,
    department: null,
    lastLoginAt: null,
    roleAssignments: [{ role: { key: "FACULTY" } }],
    ...overrides,
  };
}

type Unit = NonNullable<Awaited<ReturnType<NonNullable<FacultyDeps["getUnit"]>>>>;

interface Harness {
  audited: RecordAuditLogInput[];
  created: Array<Record<string, unknown>>;
  statuses: Array<{ id: string; status: string }>;
  passwords: Array<{ id: string; hash: string }>;
  endedSessions: string[];
  deletedLinks: string[];
  subjectWrites: Array<{ cohortSubjectId: string; facultyId: string | null }>;
  /** Every institution id any read or write was scoped to. */
  scopes: string[];
  updates: Array<Record<string, unknown>>;
  deps: FacultyDeps;
}

function harness(
  state: {
    rows?: Array<NonNullable<StaffRow>>;
    emailTaken?: boolean;
    units?: Unit[];
    link?: Awaited<ReturnType<NonNullable<FacultyDeps["getClassLink"]>>>;
    offering?: Awaited<ReturnType<NonNullable<FacultyDeps["getCohortSubject"]>>>;
  } = {},
): Harness {
  const rows = state.rows ?? [staff()];
  const units = state.units ?? [{ id: "unit-cs", name: "Computer Science", kind: "DEPARTMENT" }];
  const h: Harness = {
    audited: [],
    created: [],
    statuses: [],
    passwords: [],
    endedSessions: [],
    deletedLinks: [],
    subjectWrites: [],
    scopes: [],
    updates: [],
    deps: {},
  };
  h.deps = {
    searchStaff: async (institutionId) => {
      h.scopes.push(institutionId);
      return {
        rows,
        total: rows.length,
        totalAll: rows.length,
        activeAll: rows.filter((row) => row.status === "ACTIVE").length,
        page: 1,
      };
    },
    getStaff: async (institutionId, id) => {
      h.scopes.push(institutionId);
      return rows.find((row) => row.id === id) ?? null;
    },
    idsWithPassword: async (_institutionId, ids) =>
      ids.filter((id) => id === "user-teacher").slice(),
    listAssignable: async (institutionId) => {
      h.scopes.push(institutionId);
      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        status: row.status === "ACTIVE" ? ("ACTIVE" as const) : ("INACTIVE" as const),
      }));
    },
    listDepartments: async (institutionId) => {
      h.scopes.push(institutionId);
      return units
        .filter((unit) => unit.kind === "DEPARTMENT")
        .map((unit) => ({ id: unit.id, name: unit.name, code: null }));
    },
    getUnit: async (institutionId, unitId) => {
      h.scopes.push(institutionId);
      return units.find((unit) => unit.id === unitId) ?? null;
    },
    institutionType: async () => "COLLEGE",
    findByEmail: async () => (state.emailTaken ? { id: "user-elsewhere" } : null),
    findRole: async (_institutionId, key) => ({ id: `role-${key}`, key }),
    createStaff: async (input) => {
      h.created.push(input as unknown as Record<string, unknown>);
      return staff({ id: "user-new", name: input.name, email: input.email });
    },
    updateStaff: async (institutionId, id, data) => {
      h.scopes.push(institutionId);
      h.updates.push(data as unknown as Record<string, unknown>);
      const existing = rows.find((row) => row.id === id);
      return existing ? { ...existing, ...data } : null;
    },
    setStatus: async (_institutionId, id, status) => {
      h.statuses.push({ id, status });
      const existing = rows.find((row) => row.id === id);
      return existing ? { ...existing, status } : null;
    },
    setPassword: async (_institutionId, id, hash) => {
      h.passwords.push({ id, hash });
      return true;
    },
    endSessions: async (id) => {
      h.endedSessions.push(id);
    },
    listClassLinks: async () => [],
    listSubjectLinks: async () => [],
    listCohorts: async () => [],
    getClassLink: async () => state.link ?? null,
    deleteClassLink: async (linkId) => {
      h.deletedLinks.push(linkId);
    },
    getCohortSubject: async () => state.offering ?? null,
    setSubjectFaculty: async (cohortSubjectId, facultyId) => {
      h.subjectWrites.push({ cohortSubjectId, facultyId });
    },
    audit: async (input) => {
      h.audited.push(input);
    },
    newPassword: () => "TEMP_PLAINTEXT_PASSWORD",
    hashSecret: async (plain) => `scrypt-of:${plain}`,
  };
  return h;
}

/** Every string anywhere in a value, however deeply nested. */
function flatten(value: unknown): string {
  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------------------
// Authorization and tenancy
// ---------------------------------------------------------------------------

test("no entry point can be told which institution to work in", () => {
  // The signature is the guarantee: an institution id that a caller could pass
  // is an institution id a form could supply. Every one of these takes the
  // actor and the thing being acted on, and reads the tenant from the session.
  assert.equal(getFacultyDirectory.length, 1, "the actor, and nothing else");
  assert.equal(inviteFaculty.length, 2, "the actor and the new person's details");
  assert.equal(updateFacultyDetails.length, 3, "the actor, an id and the details");
  assert.equal(deactivateFaculty.length, 2, "the actor and an id");
  assert.equal(reactivateFaculty.length, 2, "the actor and an id");
  assert.equal(resetFacultyPassword.length, 2, "the actor and an id");
  assert.equal(removeClassTeacher.length, 2, "the actor and a link id");
  assert.equal(setSubjectFaculty.length, 3, "the actor, a subject and a teacher");
});

test("every read behind the directory is scoped to the session's institution", async () => {
  const h = harness();
  await getFacultyDirectory(ADMIN, EMPTY_FACULTY_FILTERS, h.deps);
  assert.ok(h.scopes.length > 0, "something was scoped");
  assert.deepEqual(
    [...new Set(h.scopes)],
    ["inst-1"],
    "no read reached outside the session's institution",
  );
});

test("inviting needs user.invite, not merely read access", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      inviteFaculty(READER, { name: "A Bose", email: "a@example.edu", roleKey: "FACULTY" }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.created.length, 0);
  assert.equal(h.audited.length, 0);
});

test("a reader may still see the directory", async () => {
  const h = harness();
  const view = await getFacultyDirectory(READER, EMPTY_FACULTY_FILTERS, h.deps);
  assert.equal(view.members.length, 1);
});

test("an account with no institution cannot administer staff", async () => {
  const h = harness();
  await assert.rejects(
    () => getFacultyDirectory(makeUser({ institutionId: null }), EMPTY_FACULTY_FILTERS, h.deps),
    FacultyError,
  );
});

test("restoring an account needs the permission to grant access, not merely to stop it", async () => {
  const h = harness({ rows: [staff({ status: "INACTIVE" })] });
  const stopper = makeUser({
    userId: "user-stopper",
    permissions: ["institution.read", "user.deactivate"],
  });
  await assert.rejects(() => reactivateFaculty(stopper, "user-teacher", h.deps), ForbiddenError);
});

test("the institution written is the session's, never one from the form", async () => {
  const h = harness();
  await inviteFaculty(
    ADMIN,
    { name: "A Bose", email: "a@example.edu", roleKey: "FACULTY" },
    h.deps,
  );
  assert.equal(h.created[0].institutionId, "inst-1");
  assert.equal(h.audited[0].institutionId, "inst-1");
});

test("a staff member from another institution cannot be given a subject here", async () => {
  const h = harness({
    offering: {
      id: "cs-1",
      institutionId: "inst-1",
      cohortName: "BSc 2A",
      subjectCode: "CS101",
      facultyId: null,
    },
  });
  await assert.rejects(
    () => setSubjectFaculty(ADMIN, "cs-1", "user-from-another-college", h.deps),
    FacultyError,
  );
  assert.equal(h.subjectWrites.length, 0);
});

test("a subject in another institution cannot be reassigned", async () => {
  const h = harness({
    offering: {
      id: "cs-1",
      institutionId: "inst-2",
      cohortName: "Theirs",
      subjectCode: "CS101",
      facultyId: null,
    },
  });
  await assert.rejects(() => setSubjectFaculty(ADMIN, "cs-1", null, h.deps), FacultyError);
  assert.equal(h.subjectWrites.length, 0);
});

test("a class-teacher link in another institution cannot be removed", async () => {
  const h = harness({
    link: {
      id: "link-1",
      userId: "user-theirs",
      cohortId: "cohort-theirs",
      institutionId: "inst-2",
      role: "PRIMARY",
    },
  });
  await assert.rejects(() => removeClassTeacher(ADMIN, "link-1", h.deps), FacultyError);
  assert.equal(h.deletedLinks.length, 0);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("an address already in use is refused before anything is written", async () => {
  const h = harness({ emailTaken: true });
  await assert.rejects(
    () =>
      inviteFaculty(
        ADMIN,
        { name: "A Bose", email: "taken@example.edu", roleKey: "FACULTY" },
        h.deps,
      ),
    FacultyError,
  );
  assert.equal(h.created.length, 0);
});

test("an email is stored lower-cased, so one person cannot become two accounts", async () => {
  const h = harness();
  await inviteFaculty(
    ADMIN,
    { name: "A Bose", email: "  A.Bose@Example.edu ", roleKey: "FACULTY" },
    h.deps,
  );
  assert.equal(h.created[0].email, "a.bose@example.edu");
});

test("a role this screen does not offer is refused, not quietly downgraded", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      inviteFaculty(
        ADMIN,
        { name: "A Bose", email: "a@example.edu", roleKey: "INSTITUTION_ADMIN" },
        h.deps,
      ),
    FacultyError,
  );
  assert.equal(h.created.length, 0);
});

test("an empty employee code is stored as absent rather than as an empty string", async () => {
  const h = harness();
  await inviteFaculty(
    ADMIN,
    { name: "A Bose", email: "a@example.edu", employeeCode: "   ", roleKey: "FACULTY" },
    h.deps,
  );
  assert.equal(h.created[0].employeeCode, null);
});

// ---------------------------------------------------------------------------
// Passwords
// ---------------------------------------------------------------------------

test("the temporary password is returned once and never reaches the audit log", async () => {
  const h = harness();
  const invited = await inviteFaculty(
    ADMIN,
    { name: "A Bose", email: "a@example.edu", roleKey: "FACULTY" },
    h.deps,
  );

  assert.equal(invited.password, "TEMP_PLAINTEXT_PASSWORD");
  assert.equal(h.created[0].passwordHash, "scrypt-of:TEMP_PLAINTEXT_PASSWORD");
  assert.equal(
    flatten(h.created[0]).includes('"TEMP_PLAINTEXT_PASSWORD"'),
    false,
    "the plaintext is not written to the database",
  );

  const row = h.audited[0];
  assert.equal(row.action, "user.created");
  assert.equal(flatten(row).includes("TEMP_PLAINTEXT_PASSWORD"), false);
  assert.equal(flatten(row).includes("scrypt-of"), false, "not even the hash is audited");
});

test("a reset issues a new password, ends every session, and audits neither", async () => {
  const h = harness();
  const issued = await resetFacultyPassword(ADMIN, "user-teacher", h.deps);

  assert.equal(issued.password, "TEMP_PLAINTEXT_PASSWORD");
  assert.deepEqual(h.passwords, [
    { id: "user-teacher", hash: "scrypt-of:TEMP_PLAINTEXT_PASSWORD" },
  ]);
  const row = h.audited[0];
  assert.equal(row.action, "user.updated");
  assert.equal(flatten(row).includes("TEMP_PLAINTEXT_PASSWORD"), false);
  assert.equal((row.afterJson as { passwordReset: boolean }).passwordReset, true);
});

test("no read path returns anything password-shaped", async () => {
  const h = harness();
  const view = await getFacultyDirectory(ADMIN, EMPTY_FACULTY_FILTERS, h.deps);
  assert.equal(Object.hasOwn(view.members[0], "passwordHash"), false);
  assert.equal(view.members[0].canSignIn, true, "whether one is set is still knowable");
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

test("an administrator cannot deactivate their own account", async () => {
  const h = harness({ rows: [staff({ id: "user-admin" })] });
  await assert.rejects(() => deactivateFaculty(ADMIN, "user-admin", h.deps), FacultyError);
  assert.equal(h.statuses.length, 0);
});

test("deactivating ends the open sessions rather than waiting for the cookie to expire", async () => {
  const h = harness();
  await deactivateFaculty(ADMIN, "user-teacher", h.deps);
  assert.deepEqual(h.statuses, [{ id: "user-teacher", status: "INACTIVE" }]);
  assert.deepEqual(h.endedSessions, ["user-teacher"]);
  assert.equal(h.audited[0].action, "user.deactivated");
});

test("deactivating an already stopped account is refused rather than silently repeated", async () => {
  const h = harness({ rows: [staff({ status: "INACTIVE" })] });
  await assert.rejects(() => deactivateFaculty(ADMIN, "user-teacher", h.deps), FacultyError);
  assert.equal(h.audited.length, 0);
});

test("a stopped account cannot be handed a subject", async () => {
  const h = harness({
    rows: [staff({ status: "INACTIVE" })],
    offering: {
      id: "cs-1",
      institutionId: "inst-1",
      cohortName: "BSc 2A",
      subjectCode: "CS101",
      facultyId: null,
    },
  });
  await assert.rejects(() => setSubjectFaculty(ADMIN, "cs-1", "user-teacher", h.deps), FacultyError);
  assert.equal(h.subjectWrites.length, 0);
});

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

test("a department the institution does not have is refused before the account exists", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      inviteFaculty(
        ADMIN,
        {
          name: "A Bose",
          email: "a@example.edu",
          departmentId: "unit-from-another-college",
          roleKey: "FACULTY",
        },
        h.deps,
      ),
    FacultyError,
  );
  assert.equal(h.created.length, 0, "nothing was written");
});

test("a unit that is not a department cannot be one", async () => {
  // The foreign key is satisfied — the row exists and is in this institution —
  // and it is still wrong. Postgres cannot express "and its kind is DEPARTMENT",
  // so the service is the only thing standing between a form and a semester in
  // the department column.
  const h = harness({
    units: [{ id: "unit-sem3", name: "Semester 3", kind: "SEMESTER" }],
  });
  await assert.rejects(
    () =>
      inviteFaculty(
        ADMIN,
        { name: "A Bose", email: "a@example.edu", departmentId: "unit-sem3", roleKey: "FACULTY" },
        h.deps,
      ),
    (error: unknown) => {
      assert.ok(error instanceof FacultyError);
      assert.match(error.message, /not a department/);
      return true;
    },
  );
  assert.equal(h.created.length, 0);
});

test("a valid department is stored and audited", async () => {
  const h = harness();
  await inviteFaculty(
    ADMIN,
    { name: "A Bose", email: "a@example.edu", departmentId: "unit-cs", roleKey: "FACULTY" },
    h.deps,
  );
  assert.equal(h.created[0].departmentId, "unit-cs");
  assert.equal((h.audited[0].afterJson as { departmentId: string }).departmentId, "unit-cs");
});

test("an edit that does not mention a department leaves the stored one alone", async () => {
  // What a school's edit form sends: no field at all. Reading that as "clear
  // it" would unassign every department the moment an institution changed type.
  const h = harness({ rows: [staff({ departmentId: "unit-cs" })] });
  await updateFacultyDetails(ADMIN, "user-teacher", { name: "R Sharma" }, h.deps);
  assert.equal(
    Object.hasOwn(h.updates[0], "departmentId"),
    false,
    "the column was not part of the write",
  );
});

test("an edit that sends an empty department clears it", async () => {
  const h = harness({ rows: [staff({ departmentId: "unit-cs" })] });
  await updateFacultyDetails(
    ADMIN,
    "user-teacher",
    { name: "R Sharma", departmentId: "" },
    h.deps,
  );
  assert.equal(h.updates[0].departmentId, null);
});

test("a bad department on an edit is refused before the account is written", async () => {
  const h = harness({ rows: [staff({ departmentId: "unit-cs" })] });
  await assert.rejects(
    () =>
      updateFacultyDetails(
        ADMIN,
        "user-teacher",
        { name: "R Sharma", departmentId: "unit-theirs" },
        h.deps,
      ),
    FacultyError,
  );
  assert.equal(h.updates.length, 0, "nothing was written");
  assert.equal(h.audited.length, 0, "and nothing was audited");
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test("an edit audits both the old and the new details", async () => {
  const h = harness();
  await updateFacultyDetails(ADMIN, "user-teacher", { name: "R Sharma-Iyer" }, h.deps);
  const row = h.audited[0];
  assert.equal(row.action, "user.updated");
  assert.equal(row.actorUserId, "user-admin");
  assert.deepEqual(row.beforeJson, {
    name: "R Sharma",
    employeeCode: "T-14",
    departmentId: null,
  });
  assert.deepEqual(row.afterJson, {
    name: "R Sharma-Iyer",
    employeeCode: null,
    departmentId: null,
  });
});

test("clearing a subject's teacher records who it was before", async () => {
  const h = harness({
    offering: {
      id: "cs-1",
      institutionId: "inst-1",
      cohortName: "BSc 2A",
      subjectCode: "CS101",
      facultyId: "user-teacher",
    },
  });
  await setSubjectFaculty(ADMIN, "cs-1", null, h.deps);
  assert.deepEqual(h.subjectWrites, [{ cohortSubjectId: "cs-1", facultyId: null }]);
  const row = h.audited[0];
  assert.equal(row.action, "cohort_subject.faculty_assigned");
  assert.deepEqual(row.beforeJson, { facultyId: "user-teacher" });
  assert.equal((row.afterJson as { facultyId: string | null }).facultyId, null);
});

test("removing a class-teacher link records what it was", async () => {
  const h = harness({
    link: {
      id: "link-1",
      userId: "user-teacher",
      cohortId: "cohort-1",
      institutionId: "inst-1",
      role: "PRIMARY",
    },
  });
  await removeClassTeacher(ADMIN, "link-1", h.deps);
  assert.deepEqual(h.deletedLinks, ["link-1"]);
  const row = h.audited[0];
  assert.equal(row.action, "cohort_faculty.removed");
  assert.deepEqual(row.beforeJson, {
    cohortId: "cohort-1",
    userId: "user-teacher",
    role: "PRIMARY",
  });
});
