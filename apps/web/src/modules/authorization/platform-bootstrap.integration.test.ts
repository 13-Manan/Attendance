import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { hashPassword } from "../auth-tenancy/password.ts";
import { PERMISSIONS } from "./permissions.ts";
import {
  BootstrapError,
  PLATFORM_ADMIN_ROLE_KEY,
  bootstrapPlatformAdmin,
  inspectBootstrapState,
  inspectPlatformAdminState,
  runPlatformAdminBootstrap,
} from "./bootstrap.ts";

/**
 * Phase 22 — the first PLATFORM_SUPER_ADMIN, against real Postgres.
 *
 * A fake would get the load-bearing detail wrong. The unique index on
 * UserRoleAssignment(userId, roleId, institutionId, campusId) is NULL-distinct,
 * and a platform assignment is NULL in both scope columns, so the database will
 * happily accept a second identical row. Idempotency here is a property of the
 * check plus the advisory lock, not of a constraint, and only a real database
 * can show that the constraint is in fact absent.
 *
 * ## Why most of this runs inside a rolled-back transaction
 *
 * Platform state is global by definition — an account with no institution
 * cannot be namespaced behind a test-only institution id the way every other
 * suite here does. Clearing the platform tier to test the empty case would
 * destroy the dev fixture's own super admin. So the state-machine tests open a
 * transaction, empty the platform tier inside it, exercise the stage, assert,
 * and then roll the whole thing back. Nothing reaches the database's committed
 * state, and the assertions still run against real Postgres semantics.
 *
 * The committed entry point is covered separately, using only paths that write
 * nothing by design.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const TARGET_EMAIL = "phase22.platform@example.test";
const OTHER_EMAIL = "phase22.other@example.test";

/** Hashed once — scrypt is deliberately slow and this runs inside transactions. */
let passwordHash = "";
/** The plaintext behind it, so tests can prove it never appears anywhere. */
const PLAINTEXT = "phase22-not-a-real-password";

before(async () => {
  if (SKIP) return;
  passwordHash = await hashPassword(PLAINTEXT);

  const state = await inspectBootstrapState(prisma);
  assert.equal(
    state.systemRolesComplete,
    true,
    "this suite needs the system roles bootstrapped — run the seed or stage A first",
  );
});

after(async () => {
  if (SKIP) return;
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Rollback harness
// ---------------------------------------------------------------------------

const ROLLBACK = Symbol("rollback");

/**
 * Runs `fn` in a transaction that is always rolled back, returning its value.
 *
 * The thrown sentinel is what aborts the transaction; a normal return would
 * commit it. An assertion failure inside `fn` throws too, which also rolls
 * back — a failing test cannot leave rows behind.
 */
async function inRollback<T>(fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>) {
  try {
    await prisma.$transaction(
      async (tx) => {
        const value = await fn(tx);
        throw Object.assign(new Error("rollback"), { [ROLLBACK]: true, value });
      },
      // RepeatableRead so that row counts taken inside are stable. The suite
      // runs in parallel with others that create and delete institutions and
      // users, and under the default ReadCommitted a count taken before and a
      // count taken after would be measuring their commits as well as this
      // test's own writes.
      { timeout: 20_000, isolationLevel: "RepeatableRead" },
    );
  } catch (error) {
    if (error && typeof error === "object" && ROLLBACK in error) {
      return (error as unknown as { value: T }).value;
    }
    throw error;
  }
  throw new Error("unreachable: the transaction should always have been rolled back");
}

/**
 * As above, with the platform tier emptied first — rolled back with the rest.
 *
 * Emptying it means deleting the institution-less users, which is every account
 * this bootstrap could have made. It does not cover one case, and the retry
 * below is why: role-escalation.integration.test.ts briefly commits a user who
 * *has* an institution and holds PLATFORM_SUPER_ADMIN, to prove a platform
 * actor may grant that role. While that row exists the tier genuinely is
 * inconsistent, and `inspectPlatformAdminState` is right to say so.
 *
 * Deleting that row here instead would mean reaching into another suite's
 * fixtures and taking a lock on a row it is actively using. Waiting is both
 * safer and more truthful: the state is transient, so observe it again.
 */
const TIER_ATTEMPTS = 8;

async function withEmptyPlatformTier<T>(
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
): Promise<Awaited<T>> {
  let lastProblems: string[] = [];
  // Captured in the closure rather than returned through inRollback, so the
  // generic does not have to survive a union and an Awaited<> round trip.
  let captured: Awaited<T> | undefined;
  let ran = false;

  for (let attempt = 0; attempt < TIER_ATTEMPTS; attempt += 1) {
    lastProblems = await inRollback(async (tx) => {
      await tx.session.deleteMany({ where: { user: { institutionId: null } } });
      await tx.userRoleAssignment.deleteMany({ where: { user: { institutionId: null } } });
      await tx.user.deleteMany({ where: { institutionId: null } });

      const state = await inspectPlatformAdminState(tx);
      if (state.problems.length > 0 || state.holders.length > 0) {
        // Another suite's row, not ours — everything ours was just deleted.
        return state.problems;
      }

      captured = await fn(tx);
      ran = true;
      return [];
    });

    if (ran) return captured as Awaited<T>;
    await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
  }

  // Persistently dirty is a real finding about the database, not a race.
  assert.fail(
    `the platform tier did not become clean in ${TIER_ATTEMPTS} attempts:\n  - ${lastProblems.join("\n  - ")}`,
  );
}

/**
 * A tenant to hang test rows off, created inside the rolled-back transaction.
 *
 * Deliberately not `findFirst` over the existing institutions: another suite
 * may delete the one this picked while the test is still running, and the
 * foreign key would then fail for a reason that has nothing to do with what is
 * being tested. An uncommitted institution is invisible to everyone else.
 */
async function scratchInstitution(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
): Promise<string> {
  const created = await tx.institution.create({
    data: { name: "Phase 22 Scratch", type: "SCHOOL" },
    select: { id: true },
  });
  return created.id;
}

const input = (overrides: Partial<{ name: string; email: string; passwordHash: string }> = {}) => ({
  name: "Platform Super Admin",
  email: TARGET_EMAIL,
  passwordHash,
  ...overrides,
});

// ---------------------------------------------------------------------------
// The account this creates
// ---------------------------------------------------------------------------

test("creates a platform admin whose user belongs to no institution", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const result = await bootstrapPlatformAdmin(tx, input());

    assert.equal(result.created, true);
    assert.equal(result.email, TARGET_EMAIL);
    assert.equal(result.roleKey, PLATFORM_ADMIN_ROLE_KEY);

    const user = await tx.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: { institutionId: true, campusId: true, status: true, email: true },
    });
    assert.equal(user.institutionId, null, "a platform account must belong to no institution");
    assert.equal(user.campusId, null);
    assert.equal(user.status, "ACTIVE");
    assert.equal(user.email, TARGET_EMAIL);
  });
});

test("the role assignment is PLATFORM_SUPER_ADMIN and institution-less", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const result = await bootstrapPlatformAdmin(tx, input());

    const assignments = await tx.userRoleAssignment.findMany({
      where: { userId: result.userId },
      select: {
        id: true,
        institutionId: true,
        campusId: true,
        role: { select: { key: true, institutionId: true } },
      },
    });

    assert.equal(assignments.length, 1, "exactly one role");
    assert.equal(assignments[0].id, result.roleAssignmentId);
    assert.equal(assignments[0].role.key, PLATFORM_ADMIN_ROLE_KEY);
    assert.equal(assignments[0].institutionId, null, "the assignment must be institution-less");
    assert.equal(assignments[0].campusId, null, "the assignment must not be narrowed to a campus");
    assert.equal(assignments[0].role.institutionId, null, "the platform role is a system role");
  });
});

test("creates no institution", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const before = await tx.institution.count();
    await bootstrapPlatformAdmin(tx, input());
    assert.equal(await tx.institution.count(), before, "the platform stage must create no tenant");
  });
});

test("the account can reach the platform-only permissions and every other one", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const result = await bootstrapPlatformAdmin(tx, input());

    const grants = await tx.rolePermission.findMany({
      where: { role: { assignments: { some: { userId: result.userId } } } },
      select: { permission: true },
    });
    const granted = grants.map((row) => row.permission).sort();

    assert.ok(granted.includes("platform.institution.create"));
    assert.ok(granted.includes("platform.institution.suspend"));
    assert.deepEqual(granted, [...PERMISSIONS].sort(), "the platform role carries the whole catalog");
  });
});

test("stores the supplied hash and refuses a plaintext outright", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const result = await bootstrapPlatformAdmin(tx, input());
    const user = await tx.user.findUniqueOrThrow({
      where: { id: result.userId },
      select: { passwordHash: true },
    });

    assert.equal(user.passwordHash, passwordHash);
    assert.ok(user.passwordHash?.startsWith("scrypt$"));
    assert.equal(user.passwordHash?.includes(PLAINTEXT), false);
    // Nothing the caller gets back carries the secret either.
    assert.equal(JSON.stringify(result).includes(PLAINTEXT), false);
    assert.equal(JSON.stringify(result).includes(passwordHash), false);
  });

  // The module cannot be handed a plaintext even by mistake: the shape check
  // rejects anything the application's own hasher did not produce.
  await withEmptyPlatformTier(async (tx) => {
    await assert.rejects(
      () => bootstrapPlatformAdmin(tx, input({ passwordHash: PLAINTEXT })),
      (error: Error) => error instanceof BootstrapError && /password/i.test(error.message),
    );
    assert.equal(await tx.user.count({ where: { email: TARGET_EMAIL } }), 0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

test("a second run reports already-configured and writes nothing", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const first = await bootstrapPlatformAdmin(tx, input());

    const usersAfterFirst = await tx.user.count();
    const assignmentsAfterFirst = await tx.userRoleAssignment.count();

    const second = await bootstrapPlatformAdmin(tx, input());

    assert.equal(second.created, false);
    assert.equal(second.userId, first.userId, "the same account, not a new one");
    assert.equal(second.roleAssignmentId, first.roleAssignmentId);
    assert.equal(await tx.user.count(), usersAfterFirst, "no duplicate user");
    assert.equal(
      await tx.userRoleAssignment.count(),
      assignmentsAfterFirst,
      "no duplicate role assignment — the NULL-distinct unique index would not have caught one",
    );
  });
});

test("a re-run with a different password leaves the stored hash untouched", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const created = await bootstrapPlatformAdmin(tx, input());
    const otherHash = await hashPassword("a-completely-different-password");

    const second = await bootstrapPlatformAdmin(tx, input({ passwordHash: otherHash }));
    assert.equal(second.created, false);

    const user = await tx.user.findUniqueOrThrow({
      where: { id: created.userId },
      select: { passwordHash: true },
    });
    assert.equal(user.passwordHash, passwordHash, "re-running must not rotate the password");
  });
});

test("a differently-cased address is the same account, not a second one", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const first = await bootstrapPlatformAdmin(tx, input());
    const second = await bootstrapPlatformAdmin(tx, input({ email: TARGET_EMAIL.toUpperCase() }));

    assert.equal(second.created, false);
    assert.equal(second.userId, first.userId);
  });
});

// ---------------------------------------------------------------------------
// Fail closed — every one of these must leave the database exactly as found
// ---------------------------------------------------------------------------

test("refuses a second platform admin under a different address", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    await bootstrapPlatformAdmin(tx, input());
    const usersBefore = await tx.user.count();

    await assert.rejects(
      () => bootstrapPlatformAdmin(tx, input({ email: OTHER_EMAIL })),
      (error: Error) =>
        error instanceof BootstrapError && /already the platform administrator/i.test(error.message),
    );

    assert.equal(await tx.user.count(), usersBefore, "nothing may be written");
    assert.equal(await tx.user.count({ where: { email: OTHER_EMAIL } }), 0);
  });
});

test("refuses when the address already belongs to somebody inside an institution", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const institutionId = await scratchInstitution(tx);
    const tenant = await tx.user.create({
      data: {
        institutionId,
        name: "Already Here",
        email: TARGET_EMAIL,
        passwordHash,
        status: "ACTIVE",
      },
      select: { id: true, institutionId: true },
    });

    await assert.rejects(
      () => bootstrapPlatformAdmin(tx, input()),
      (error: Error) => error instanceof BootstrapError && /already belongs to an account/i.test(error.message),
    );

    // The existing account is untouched — not promoted, not re-scoped.
    const after = await tx.user.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { institutionId: true, roleAssignments: { select: { id: true } } },
    });
    assert.equal(after.institutionId, institutionId, "the tenant account keeps its institution");
    assert.equal(after.roleAssignments.length, 0, "it must not have been granted anything");
  });
});

test("fails closed when the platform role is held by a user inside an institution", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const institutionId = await scratchInstitution(tx);
    const role = await tx.role.findFirstOrThrow({
      where: { institutionId: null, key: PLATFORM_ADMIN_ROLE_KEY },
      select: { id: true },
    });
    const impostor = await tx.user.create({
      data: {
        institutionId,
        name: "Wrongly Promoted",
        email: OTHER_EMAIL,
        passwordHash,
        status: "ACTIVE",
      },
      select: { id: true },
    });
    await tx.userRoleAssignment.create({
      data: { userId: impostor.id, roleId: role.id, institutionId: null, campusId: null },
    });

    await assert.rejects(
      () => bootstrapPlatformAdmin(tx, input()),
      (error: Error) =>
        error instanceof BootstrapError && /must belong to none/i.test(error.message),
    );
    assert.equal(await tx.user.count({ where: { email: TARGET_EMAIL } }), 0);
  });
});

test("fails closed when a platform assignment is scoped to an institution", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const institutionId = await scratchInstitution(tx);
    const role = await tx.role.findFirstOrThrow({
      where: { institutionId: null, key: PLATFORM_ADMIN_ROLE_KEY },
      select: { id: true },
    });
    const user = await tx.user.create({
      data: { institutionId: null, name: "Mis-scoped", email: TARGET_EMAIL, passwordHash, status: "ACTIVE" },
      select: { id: true },
    });
    await tx.userRoleAssignment.create({
      data: { userId: user.id, roleId: role.id, institutionId, campusId: null },
    });

    await assert.rejects(
      () => bootstrapPlatformAdmin(tx, input()),
      (error: Error) =>
        error instanceof BootstrapError && /must be institution-less/i.test(error.message),
    );
  });
});

test("fails closed on two platform accounts rather than picking one", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const role = await tx.role.findFirstOrThrow({
      where: { institutionId: null, key: PLATFORM_ADMIN_ROLE_KEY },
      select: { id: true },
    });
    for (const email of [TARGET_EMAIL, OTHER_EMAIL]) {
      const user = await tx.user.create({
        data: { institutionId: null, name: "Platform", email, passwordHash, status: "ACTIVE" },
        select: { id: true },
      });
      await tx.userRoleAssignment.create({
        data: { userId: user.id, roleId: role.id, institutionId: null, campusId: null },
      });
    }

    await assert.rejects(
      () => bootstrapPlatformAdmin(tx, input()),
      (error: Error) => error instanceof BootstrapError && /2 accounts already hold/i.test(error.message),
    );
  });
});

test("fails closed on duplicate assignments the unique index cannot catch", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    const role = await tx.role.findFirstOrThrow({
      where: { institutionId: null, key: PLATFORM_ADMIN_ROLE_KEY },
      select: { id: true },
    });
    const user = await tx.user.create({
      data: { institutionId: null, name: "Platform", email: TARGET_EMAIL, passwordHash, status: "ACTIVE" },
      select: { id: true },
    });

    // Two byte-identical rows. Postgres accepts both because the index is
    // NULL-distinct — which is precisely why this state has to be detected.
    for (let i = 0; i < 2; i += 1) {
      await tx.userRoleAssignment.create({
        data: { userId: user.id, roleId: role.id, institutionId: null, campusId: null },
      });
    }

    await assert.rejects(
      () => bootstrapPlatformAdmin(tx, input()),
      (error: Error) => error instanceof BootstrapError && /2 separate/i.test(error.message),
    );
  });
});

test("fails closed on a half-finished run: a user with no institution and no role", { skip: SKIP }, async () => {
  await withEmptyPlatformTier(async (tx) => {
    await tx.user.create({
      data: { institutionId: null, name: "Orphan", email: TARGET_EMAIL, passwordHash, status: "ACTIVE" },
    });

    await assert.rejects(
      () => bootstrapPlatformAdmin(tx, input()),
      (error: Error) =>
        error instanceof BootstrapError && /stopped between the two writes/i.test(error.message),
    );
    assert.equal(await tx.userRoleAssignment.count({ where: { institutionId: null } }), 0);
  });
});

test("rejects malformed input before touching the database at all", { skip: SKIP }, async () => {
  const exploding = new Proxy(
    {},
    {
      get() {
        throw new Error("the database must not be reached for malformed input");
      },
    },
  ) as Parameters<typeof bootstrapPlatformAdmin>[0];

  for (const [label, overrides] of [
    ["empty name", { name: "   " }],
    ["empty email", { email: "" }],
    ["malformed email", { email: "not-an-address" }],
    ["email with whitespace", { email: "a b@example.test" }],
    ["plaintext password", { passwordHash: "hunter2-in-the-clear" }],
  ] as const) {
    await assert.rejects(
      () => bootstrapPlatformAdmin(exploding, input(overrides)),
      (error: Error) => error instanceof BootstrapError,
      `should reject before any query: ${label}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The committed entry point — only paths that write nothing by design
// ---------------------------------------------------------------------------

/**
 * Snapshots the platform tier alone, never a global row count.
 *
 * Whole-table counts cannot be asserted on here: the suite runs in parallel
 * with others that create and delete their own institutions and users, so a
 * total taken before and after would be measuring them as much as this. Rows
 * with no institution are nobody else's — no other suite creates one — so this
 * is both stable under concurrency and the thing actually being claimed.
 */
async function platformTierSnapshot() {
  const users = await prisma.user.findMany({
    where: { institutionId: null },
    select: { id: true, email: true, status: true, passwordHash: true },
    orderBy: { id: "asc" },
  });
  const assignments = await prisma.userRoleAssignment.findMany({
    where: { user: { institutionId: null } },
    select: { id: true, userId: true, roleId: true, institutionId: true, campusId: true },
    orderBy: { id: "asc" },
  });
  return { users, assignments };
}

test("runPlatformAdminBootstrap reports the live platform admin without writing", { skip: SKIP }, async () => {
  const state = await inspectPlatformAdminState(prisma);
  if (state.holders.length !== 1 || state.problems.length > 0) {
    // Nothing to assert against on a database with no platform tier yet; the
    // rolled-back tests above cover the state machine itself.
    return;
  }

  const before = await platformTierSnapshot();

  const result = await runPlatformAdminBootstrap(prisma, {
    name: "Platform Super Admin",
    email: state.holders[0].email,
    passwordHash,
  });

  assert.equal(result.created, false, "an existing correct platform admin is never recreated");
  assert.equal(result.userId, state.holders[0].userId);
  assert.equal(result.roleKey, PLATFORM_ADMIN_ROLE_KEY);

  // Every platform row identical, including the stored hash: no new account,
  // no new assignment, and the password supplied for this run was not applied.
  assert.deepEqual(await platformTierSnapshot(), before);
  assert.notEqual(
    before.users.find((user) => user.id === result.userId)?.passwordHash,
    passwordHash,
    "the supplied password must not have been applied",
  );
});

test("runPlatformAdminBootstrap refuses a second address and writes nothing", { skip: SKIP }, async () => {
  const state = await inspectPlatformAdminState(prisma);
  if (state.holders.length !== 1 || state.problems.length > 0) return;

  const before = await platformTierSnapshot();

  await assert.rejects(
    () => runPlatformAdminBootstrap(prisma, { name: "Second", email: OTHER_EMAIL, passwordHash }),
    (error: Error) =>
      error instanceof BootstrapError && /already the platform administrator/i.test(error.message),
  );

  assert.deepEqual(await platformTierSnapshot(), before);
  assert.equal(await prisma.user.count({ where: { email: OTHER_EMAIL } }), 0);
});

test("inspectPlatformAdminState writes nothing", { skip: SKIP }, async () => {
  const before = await platformTierSnapshot();
  await inspectPlatformAdminState(prisma);
  assert.deepEqual(await platformTierSnapshot(), before);
});
