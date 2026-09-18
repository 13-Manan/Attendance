import { test } from "node:test";
import assert from "node:assert/strict";
import type { PrismaClient } from "@prisma/client";
import { hashPassword } from "../auth-tenancy/password.ts";
import { SYSTEM_ROLES } from "./permissions.ts";
import {
  BootstrapError,
  FIRST_ADMIN_ROLE_KEY,
  bootstrapFirstInstitutionAdmin,
  ensureSystemRolesAndPermissions,
  inspectBootstrapState,
  runFirstTenantBootstrap,
  runSystemBootstrap,
  type FirstTenantInput,
} from "./bootstrap.ts";

/**
 * An in-memory stand-in for the subset of Prisma this module uses.
 *
 * It enforces the two constraints the real schema enforces and that the
 * bootstrap depends on for correctness — the partial unique index on
 * Role(key) WHERE institutionId IS NULL, and User.email unique — so the
 * duplicate-protection tests below prove something rather than asserting
 * against a fake that would have allowed anything.
 *
 * It also records every delete, because "this must never delete a user or an
 * institution" is a property worth testing rather than reading.
 */
interface RoleRow {
  id: string;
  institutionId: string | null;
  key: string;
  name: string;
  isSystem: boolean;
}
interface PermissionRow {
  id: string;
  roleId: string;
  permission: string;
}

function createFakeDb() {
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}_${++sequence}`;

  const roles: RoleRow[] = [];
  const rolePermissions: PermissionRow[] = [];
  const institutions: { id: string; name: string; type: string; timezone: string }[] = [];
  const users: { id: string; institutionId: string | null; email: string; passwordHash: string }[] = [];
  const assignments: {
    id: string;
    userId: string;
    roleId: string;
    institutionId: string | null;
    campusId: string | null;
  }[] = [];

  const deletions: string[] = [];
  const rawQueries: string[] = [];

  const db = {
    _store: { roles, rolePermissions, institutions, users, assignments, deletions, rawQueries },

    $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
      rawQueries.push(strings.join("?") + ` [${values.join(",")}]`);
      return Promise.resolve(1);
    },

    $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      return callback(db);
    },

    role: {
      findFirst({ where }: { where: { institutionId: string | null; key: string } }) {
        return Promise.resolve(
          roles.find((r) => r.institutionId === where.institutionId && r.key === where.key) ?? null,
        );
      },
      create({ data }: { data: Omit<RoleRow, "id"> }) {
        if (data.institutionId === null && roles.some((r) => r.institutionId === null && r.key === data.key)) {
          // role_key_platform_unique
          return Promise.reject(new Error("unique violation: role_key_platform_unique"));
        }
        const row = { ...data, id: nextId("role") };
        roles.push(row);
        return Promise.resolve(row);
      },
      update({ where, data }: { where: { id: string }; data: { name: string } }) {
        const row = roles.find((r) => r.id === where.id);
        if (!row) return Promise.reject(new Error("role not found"));
        row.name = data.name;
        return Promise.resolve(row);
      },
    },

    rolePermission: {
      findMany({ where }: { where: { roleId: string } }) {
        return Promise.resolve(rolePermissions.filter((p) => p.roleId === where.roleId));
      },
      createMany({ data }: { data: { roleId: string; permission: string }[] }) {
        for (const row of data) {
          const clash = rolePermissions.some(
            (p) => p.roleId === row.roleId && p.permission === row.permission,
          );
          if (!clash) rolePermissions.push({ ...row, id: nextId("perm") });
        }
        return Promise.resolve({ count: data.length });
      },
      deleteMany({ where }: { where: { id: { in: string[] } } }) {
        for (const id of where.id.in) {
          const index = rolePermissions.findIndex((p) => p.id === id);
          if (index >= 0) {
            deletions.push(`rolePermission:${id}`);
            rolePermissions.splice(index, 1);
          }
        }
        return Promise.resolve({ count: where.id.in.length });
      },
    },

    institution: {
      count: () => Promise.resolve(institutions.length),
      create({ data }: { data: { name: string; type: string; timezone: string } }) {
        const row = { ...data, id: nextId("inst") };
        institutions.push(row);
        return Promise.resolve(row);
      },
    },

    user: {
      count: () => Promise.resolve(users.length),
      create({ data }: { data: { institutionId: string | null; email: string; passwordHash: string } }) {
        if (users.some((u) => u.email === data.email)) {
          return Promise.reject(new Error("unique violation: User_email_key"));
        }
        const row = { ...data, id: nextId("user") };
        users.push(row);
        return Promise.resolve(row);
      },
    },

    userRoleAssignment: {
      count: () => Promise.resolve(assignments.length),
      create({
        data,
      }: {
        data: { userId: string; roleId: string; institutionId: string | null; campusId: string | null };
      }) {
        const row = { ...data, id: nextId("ura") };
        assignments.push(row);
        return Promise.resolve(row);
      },
    },
  };

  return db;
}

type FakeDb = ReturnType<typeof createFakeDb>;
const asClient = (db: FakeDb) => db as unknown as PrismaClient;

async function validTenantInput(overrides: Partial<FirstTenantInput> = {}): Promise<FirstTenantInput> {
  return {
    institutionName: "Springfield Public School",
    institutionType: "SCHOOL",
    timezone: "Asia/Kolkata",
    adminName: "Asha Menon",
    adminEmail: "asha.menon@example.edu",
    adminPasswordHash: await hashPassword("a-sufficiently-long-password"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stage A — system roles and permissions
// ---------------------------------------------------------------------------

test("stage A creates every catalog role with exactly its catalog permissions", async () => {
  const db = createFakeDb();
  const result = await ensureSystemRolesAndPermissions(asClient(db));

  assert.equal(result.rolesCreated, SYSTEM_ROLES.length);
  assert.equal(db._store.roles.length, SYSTEM_ROLES.length);

  for (const roleDef of SYSTEM_ROLES) {
    const role = db._store.roles.find((r) => r.key === roleDef.key && r.institutionId === null);
    assert.ok(role, `${roleDef.key} should exist`);
    const granted = db._store.rolePermissions
      .filter((p) => p.roleId === role.id)
      .map((p) => p.permission)
      .sort();
    assert.deepEqual(granted, [...roleDef.permissions].sort());
  }
});

test("stage A is idempotent: a second run creates nothing and changes nothing", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));
  const permissionIdsAfterFirst = db._store.rolePermissions.map((p) => p.id).sort();

  const second = await ensureSystemRolesAndPermissions(asClient(db));

  assert.equal(second.rolesCreated, 0);
  assert.equal(db._store.roles.length, SYSTEM_ROLES.length);
  assert.equal(
    second.roles.every((r) => r.permissionsAdded === 0 && r.permissionsRemoved === 0),
    true,
  );
  // Rows that were already correct keep their identity — this is the
  // difference from the old delete-then-recreate convergence.
  assert.deepEqual(db._store.rolePermissions.map((p) => p.id).sort(), permissionIdsAfterFirst);
  assert.deepEqual(db._store.deletions, []);
});

test("stage A adds a missing grant and removes a stale one, preserving the valid rows", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));

  const facultyRole = db._store.roles.find((r) => r.key === "FACULTY")!;
  const survivor = db._store.rolePermissions.find(
    (p) => p.roleId === facultyRole.id && p.permission === "cohort.read",
  )!;

  // Drift in both directions.
  const dropped = db._store.rolePermissions.findIndex(
    (p) => p.roleId === facultyRole.id && p.permission === "student.read",
  );
  db._store.rolePermissions.splice(dropped, 1);
  db._store.rolePermissions.push({
    id: "perm_stale",
    roleId: facultyRole.id,
    permission: "institution.update",
  });

  const result = await ensureSystemRolesAndPermissions(asClient(db));
  const faculty = result.roles.find((r) => r.key === "FACULTY")!;

  assert.equal(faculty.permissionsAdded, 1);
  assert.equal(faculty.permissionsRemoved, 1);

  const granted = db._store.rolePermissions
    .filter((p) => p.roleId === facultyRole.id)
    .map((p) => p.permission);
  assert.ok(granted.includes("student.read"));
  assert.ok(!granted.includes("institution.update"));

  // The correct grant was never touched.
  const stillThere = db._store.rolePermissions.find((p) => p.id === survivor.id);
  assert.ok(stillThere, "an already-correct grant should keep its row");
  assert.deepEqual(db._store.deletions, ["rolePermission:perm_stale"]);
});

test("stage A leaves an institution's own roles completely alone", async () => {
  const db = createFakeDb();
  db._store.roles.push({
    id: "role_custom",
    institutionId: "inst_existing",
    key: "FACULTY",
    name: "Renamed By The Institution",
    isSystem: false,
  });
  db._store.rolePermissions.push({
    id: "perm_custom",
    roleId: "role_custom",
    permission: "institution.update",
  });

  await ensureSystemRolesAndPermissions(asClient(db));

  const custom = db._store.roles.find((r) => r.id === "role_custom")!;
  assert.equal(custom.name, "Renamed By The Institution");
  assert.ok(db._store.rolePermissions.some((p) => p.id === "perm_custom"));
});

test("runSystemBootstrap takes the advisory lock before writing", async () => {
  const db = createFakeDb();
  await runSystemBootstrap(asClient(db));
  assert.equal(db._store.rawQueries.length, 1);
  assert.match(db._store.rawQueries[0], /pg_advisory_xact_lock/);
});

// ---------------------------------------------------------------------------
// Stage B — first institution and administrator
// ---------------------------------------------------------------------------

test("stage B creates exactly one institution, one admin and one role assignment", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));

  const result = await bootstrapFirstInstitutionAdmin(asClient(db), await validTenantInput());

  assert.equal(db._store.institutions.length, 1);
  assert.equal(db._store.users.length, 1);
  assert.equal(db._store.assignments.length, 1);

  const assignment = db._store.assignments[0];
  const adminRole = db._store.roles.find((r) => r.key === FIRST_ADMIN_ROLE_KEY && r.institutionId === null)!;

  assert.equal(assignment.roleId, adminRole.id);
  assert.equal(assignment.userId, result.adminUserId);
  // Institution-scoped, not platform-wide and not narrowed to a campus.
  assert.equal(assignment.institutionId, result.institutionId);
  assert.equal(assignment.campusId, null);
  // The admin belongs to the institution that was just created.
  assert.equal(db._store.users[0].institutionId, result.institutionId);
  assert.equal(result.roleKey, FIRST_ADMIN_ROLE_KEY);
});

test("stage B stores the supplied hash and never a plaintext", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));
  const input = await validTenantInput();

  await bootstrapFirstInstitutionAdmin(asClient(db), input);

  const stored = db._store.users[0].passwordHash;
  assert.equal(stored, input.adminPasswordHash);
  assert.ok(stored.startsWith("scrypt$"));
  assert.ok(!stored.includes("a-sufficiently-long-password"));
});

test("stage B refuses a value that is not a hash from the application's hasher", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));
  const input = await validTenantInput({ adminPasswordHash: "hunter2-in-the-clear" });

  await assert.rejects(
    () => bootstrapFirstInstitutionAdmin(asClient(db), input),
    (error: Error) => error instanceof BootstrapError && /password/i.test(error.message),
  );
  assert.equal(db._store.users.length, 0);
});

test("stage B refuses to run twice — the second attempt creates nothing", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));
  await bootstrapFirstInstitutionAdmin(asClient(db), await validTenantInput());

  await assert.rejects(
    async () =>
      bootstrapFirstInstitutionAdmin(
        asClient(db),
        await validTenantInput({
          institutionName: "A Second College",
          adminEmail: "someone.else@example.edu",
        }),
      ),
    (error: Error) => error instanceof BootstrapError && /not empty/i.test(error.message),
  );

  assert.equal(db._store.institutions.length, 1);
  assert.equal(db._store.users.length, 1);
  assert.equal(db._store.assignments.length, 1);
});

test("stage B refuses when the system roles have not been bootstrapped", async () => {
  const db = createFakeDb();
  await assert.rejects(
    async () => bootstrapFirstInstitutionAdmin(asClient(db), await validTenantInput()),
    (error: Error) => error instanceof BootstrapError && /stage A/i.test(error.message),
  );
  assert.equal(db._store.institutions.length, 0);
});

test("stage B refuses when the roles exist but their grants are incomplete", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));
  // Simulate a half-applied catalog change.
  db._store.rolePermissions.splice(0, 1);

  await assert.rejects(
    async () => bootstrapFirstInstitutionAdmin(asClient(db), await validTenantInput()),
    (error: Error) => error instanceof BootstrapError && /out of date|missing/i.test(error.message),
  );
  assert.equal(db._store.institutions.length, 0);
});

test("stage B refuses a partially initialised database (a user with no institution)", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));
  db._store.users.push({
    id: "user_orphan",
    institutionId: null,
    email: "orphan@example.edu",
    passwordHash: "scrypt$1$2$3$4$5",
  });

  await assert.rejects(
    async () => bootstrapFirstInstitutionAdmin(asClient(db), await validTenantInput()),
    (error: Error) => error instanceof BootstrapError && /not empty/i.test(error.message),
  );
  assert.equal(db._store.institutions.length, 0);
});

test("stage B rejects missing or malformed input before touching the database", async () => {
  const cases: [string, Partial<FirstTenantInput>][] = [
    ["empty institution name", { institutionName: "   " }],
    ["unknown institution type", { institutionType: "ACADEMY" as "SCHOOL" }],
    ["empty admin name", { adminName: "" }],
    ["malformed email", { adminEmail: "not-an-address" }],
    ["email with whitespace", { adminEmail: "a b@example.edu" }],
    ["unrecognised time zone", { timezone: "Mars/Olympus_Mons" }],
  ];

  for (const [label, overrides] of cases) {
    const db = createFakeDb();
    await ensureSystemRolesAndPermissions(asClient(db));
    await assert.rejects(
      async () => bootstrapFirstInstitutionAdmin(asClient(db), await validTenantInput(overrides)),
      (error: Error) => error instanceof BootstrapError,
      `should reject: ${label}`,
    );
    assert.equal(db._store.institutions.length, 0, `should write nothing for: ${label}`);
    assert.equal(db._store.users.length, 0, `should write nothing for: ${label}`);
  }
});

test("stage B normalises the email so the account can actually be signed in to", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));
  const result = await bootstrapFirstInstitutionAdmin(
    asClient(db),
    await validTenantInput({ adminEmail: "  Asha.Menon@Example.edu  " }),
  );
  assert.equal(result.adminEmail, "asha.menon@example.edu");
  assert.equal(db._store.users[0].email, "asha.menon@example.edu");
});

test("stage B defaults the time zone to the schema default when none is given", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));
  const result = await bootstrapFirstInstitutionAdmin(
    asClient(db),
    await validTenantInput({ timezone: undefined }),
  );
  assert.equal(result.timezone, "UTC");
});

test("the first admin's role carries the permissions an administrator needs", async () => {
  const db = createFakeDb();
  await ensureSystemRolesAndPermissions(asClient(db));
  await bootstrapFirstInstitutionAdmin(asClient(db), await validTenantInput());

  const assignment = db._store.assignments[0];
  const granted = db._store.rolePermissions
    .filter((p) => p.roleId === assignment.roleId)
    .map((p) => p.permission);

  for (const required of ["institution.read", "user.invite", "student.create", "role.assign"]) {
    assert.ok(granted.includes(required), `admin should hold ${required}`);
  }
  // The platform-only permissions are not an institution admin's to hold.
  assert.ok(!granted.includes("platform.institution.create"));
});

test("runFirstTenantBootstrap takes the advisory lock before writing", async () => {
  const db = createFakeDb();
  await runSystemBootstrap(asClient(db));
  db._store.rawQueries.length = 0;

  await runFirstTenantBootstrap(asClient(db), await validTenantInput());

  assert.equal(db._store.rawQueries.length, 1);
  assert.match(db._store.rawQueries[0], /pg_advisory_xact_lock/);
});

// ---------------------------------------------------------------------------
// Non-destructiveness and inspection
// ---------------------------------------------------------------------------

test("no bootstrap path ever deletes a user, an institution or a role", async () => {
  const db = createFakeDb();
  await runSystemBootstrap(asClient(db));
  await runFirstTenantBootstrap(asClient(db), await validTenantInput());
  await runSystemBootstrap(asClient(db)); // re-run after the tenant exists

  assert.equal(db._store.institutions.length, 1);
  assert.equal(db._store.users.length, 1);
  assert.equal(db._store.roles.length, SYSTEM_ROLES.length);
  assert.equal(
    db._store.deletions.every((entry) => entry.startsWith("rolePermission:")),
    true,
    "only stale permission grants may ever be deleted",
  );
});

test("inspect reports an empty database as ready and writes nothing", async () => {
  const db = createFakeDb();
  const state = await inspectBootstrapState(asClient(db));

  assert.equal(state.institutionCount, 0);
  assert.equal(state.systemRolesComplete, false);
  assert.equal(state.tenantSlateClean, true);
  assert.equal(db._store.roles.length, 0);
  assert.deepEqual(db._store.deletions, []);
});

test("inspect reports a fully bootstrapped database as no longer clean", async () => {
  const db = createFakeDb();
  await runSystemBootstrap(asClient(db));
  await runFirstTenantBootstrap(asClient(db), await validTenantInput());

  const state = await inspectBootstrapState(asClient(db));
  assert.equal(state.systemRolesComplete, true);
  assert.equal(state.tenantSlateClean, false);
  assert.equal(state.institutionCount, 1);
  assert.equal(state.userCount, 1);
  assert.equal(state.roleAssignmentCount, 1);
});
