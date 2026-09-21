import type { Prisma, PrismaClient } from "@prisma/client";
import { SYSTEM_ROLES } from "./permissions.ts";

/**
 * Production bootstrap — the two writes a brand-new database needs before
 * anybody can sign in, and nothing else.
 *
 * There are two stages, deliberately separate because they have different
 * risk profiles:
 *
 *   Stage A  ensureSystemRolesAndPermissions() — the platform Role and
 *            RolePermission rows. Pure system data derived from
 *            permissions.ts, identical in every environment, idempotent, and
 *            safe to re-run after the catalog changes. No tenant data.
 *
 *   Stage B  bootstrapFirstInstitutionAdmin() — exactly one Institution, one
 *            User and one UserRoleAssignment, from values a human supplies at
 *            the moment of execution. Runs once, refuses if the database is
 *            not demonstrably empty, and creates nothing else.
 *
 * Why this file rather than prisma/seed.ts: the seed is excluded from the
 * production migration image on purpose (apps/web/Dockerfile.migrate), so it
 * cannot be the delivery mechanism for rows production genuinely requires.
 * Stage A lives here and the seed now calls it, so there is one implementation
 * and one permission catalog, not two that can drift.
 *
 * Nothing here reads the environment, opens a client, prompts, or logs. It
 * takes a Prisma client (or a transaction client) and returns a result the
 * caller reports on. That keeps it unit-testable without a database, and
 * keeps every credential in the calling script.
 *
 * IMPORTANT: this module never sees a plaintext password. Stage B takes an
 * already-computed `adminPasswordHash` from modules/auth-tenancy/password.ts,
 * so a plaintext credential cannot be logged, returned, or accidentally
 * persisted by anything in here.
 */

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Serialises concurrent bootstrap attempts.
 *
 * Stage B's "is this database empty?" check and its writes must not interleave
 * with another run's, or two operators could each observe an empty database
 * and each create a first institution. A transaction-scoped Postgres advisory
 * lock makes the second run wait for the first to commit, after which it sees
 * the institution the first created and refuses. Released automatically when
 * the transaction ends, including on failure — there is no lock to leak.
 *
 * The key is an arbitrary constant; it only has to be stable and unused
 * elsewhere in this database.
 */
export const BOOTSTRAP_LOCK_KEY = 4820260919;

export async function acquireBootstrapLock(db: Client): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY}::bigint)`;
}

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

// ---------------------------------------------------------------------------
// Stage A — system roles and permissions
// ---------------------------------------------------------------------------

export interface SystemRoleSyncEntry {
  key: string;
  created: boolean;
  permissionsAdded: number;
  permissionsRemoved: number;
  permissionCount: number;
}

export interface SystemRoleSyncResult {
  roles: SystemRoleSyncEntry[];
  rolesCreated: number;
}

/**
 * Converges the platform-wide (institutionId: null) roles and their grants to
 * exactly what permissions.ts declares.
 *
 * Idempotent and non-destructive:
 *
 *   - Roles are matched with findFirst, not upsert. The compound unique is
 *     (institutionId, key) and SQL equality never matches NULL, so an upsert
 *     keyed on it could never find a platform-wide role and would try to
 *     create a duplicate on every run — caught by the partial unique index
 *     `role_key_platform_unique` (see the init migration), but as an error
 *     rather than as convergence.
 *
 *   - Permissions are diffed, not deleted-and-recreated. Grants that are still
 *     correct keep their row, their id and their createdAt; only genuinely
 *     stale grants are removed and genuinely missing ones added. The end state
 *     is the same as the old delete-then-insert, without a window in which a
 *     role that should have a permission does not.
 *
 *   - Roles this catalog does not mention are left completely alone, including
 *     an institution's own roles (institutionId set). Nothing here deletes a
 *     Role, a User, or an Institution under any circumstances.
 */
export async function ensureSystemRolesAndPermissions(db: Client): Promise<SystemRoleSyncResult> {
  const entries: SystemRoleSyncEntry[] = [];

  for (const roleDef of SYSTEM_ROLES) {
    const existing = await db.role.findFirst({
      where: { institutionId: null, key: roleDef.key },
      select: { id: true },
    });

    const role = existing
      ? await db.role.update({
          where: { id: existing.id },
          data: { name: roleDef.name },
          select: { id: true },
        })
      : await db.role.create({
          data: { institutionId: null, key: roleDef.key, name: roleDef.name, isSystem: true },
          select: { id: true },
        });

    const current = await db.rolePermission.findMany({
      where: { roleId: role.id },
      select: { id: true, permission: true },
    });

    const wanted = new Set<string>(roleDef.permissions);
    const held = new Set(current.map((row) => row.permission));

    const toAdd = [...wanted].filter((permission) => !held.has(permission));
    const toRemove = current.filter((row) => !wanted.has(row.permission)).map((row) => row.id);

    if (toAdd.length > 0) {
      await db.rolePermission.createMany({
        data: toAdd.map((permission) => ({ roleId: role.id, permission })),
        skipDuplicates: true,
      });
    }
    if (toRemove.length > 0) {
      await db.rolePermission.deleteMany({ where: { id: { in: toRemove } } });
    }

    entries.push({
      key: roleDef.key,
      created: !existing,
      permissionsAdded: toAdd.length,
      permissionsRemoved: toRemove.length,
      permissionCount: roleDef.permissions.length,
    });
  }

  return { roles: entries, rolesCreated: entries.filter((entry) => entry.created).length };
}

// ---------------------------------------------------------------------------
// State inspection — what a bootstrap is allowed to assume
// ---------------------------------------------------------------------------

/** The role the first administrator is granted. */
export const FIRST_ADMIN_ROLE_KEY = "INSTITUTION_ADMIN";

export interface SystemRoleStatus {
  key: string;
  present: boolean;
  missingPermissions: string[];
  extraPermissions: string[];
}

export interface BootstrapState {
  institutionCount: number;
  userCount: number;
  roleAssignmentCount: number;
  systemRoles: SystemRoleStatus[];
  /** Every catalog role exists and grants exactly its catalog permissions. */
  systemRolesComplete: boolean;
  /** No institution, no user, no role assignment — Stage B may proceed. */
  tenantSlateClean: boolean;
}

/** Read-only. Writes nothing, and is safe to run against production. */
export async function inspectBootstrapState(db: Client): Promise<BootstrapState> {
  const [institutionCount, userCount, roleAssignmentCount] = await Promise.all([
    db.institution.count(),
    db.user.count(),
    db.userRoleAssignment.count(),
  ]);

  const systemRoles: SystemRoleStatus[] = [];
  for (const roleDef of SYSTEM_ROLES) {
    const role = await db.role.findFirst({
      where: { institutionId: null, key: roleDef.key },
      select: { id: true },
    });

    if (!role) {
      systemRoles.push({
        key: roleDef.key,
        present: false,
        missingPermissions: [...roleDef.permissions],
        extraPermissions: [],
      });
      continue;
    }

    const grants = await db.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permission: true },
    });
    const held = new Set(grants.map((row) => row.permission));
    const wanted = new Set<string>(roleDef.permissions);

    systemRoles.push({
      key: roleDef.key,
      present: true,
      missingPermissions: [...wanted].filter((permission) => !held.has(permission)),
      extraPermissions: [...held].filter((permission) => !wanted.has(permission)),
    });
  }

  const systemRolesComplete = systemRoles.every(
    (status) =>
      status.present && status.missingPermissions.length === 0 && status.extraPermissions.length === 0,
  );

  return {
    institutionCount,
    userCount,
    roleAssignmentCount,
    systemRoles,
    systemRolesComplete,
    tenantSlateClean: institutionCount === 0 && userCount === 0 && roleAssignmentCount === 0,
  };
}

// ---------------------------------------------------------------------------
// Stage B — the first institution and its administrator
// ---------------------------------------------------------------------------

const MAX_NAME = 120;
const MAX_EMAIL = 254;

export type InstitutionTypeInput = "SCHOOL" | "COLLEGE";

export interface FirstTenantInput {
  institutionName: string;
  institutionType: InstitutionTypeInput;
  /** IANA zone. Defaults to the schema default when omitted. */
  timezone?: string;
  adminName: string;
  adminEmail: string;
  /** Already hashed by modules/auth-tenancy/password.ts. Never a plaintext. */
  adminPasswordHash: string;
}

export interface FirstTenantResult {
  institutionId: string;
  institutionName: string;
  institutionType: InstitutionTypeInput;
  timezone: string;
  adminUserId: string;
  adminEmail: string;
  roleKey: string;
  roleAssignmentId: string;
}

/** Mirrors the normalisation in modules/faculty/directory-policy.ts. */
function requireName(raw: string, field: string): string {
  const name = String(raw ?? "").trim();
  if (name === "") throw new BootstrapError(`${field} is required.`);
  if (name.length > MAX_NAME) {
    throw new BootstrapError(`${field} must be ${MAX_NAME} characters or fewer.`);
  }
  return name;
}

/**
 * Lower-cased for the same reason the faculty directory lower-cases: User.email
 * is unique and case-sensitive in Postgres, so a capitalised address here would
 * be a second account nobody can sign in to.
 */
function requireEmail(raw: string): string {
  const email = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (email === "") throw new BootstrapError("Administrator email is required.");
  if (email.length > MAX_EMAIL) {
    throw new BootstrapError(`The email address must be ${MAX_EMAIL} characters or fewer.`);
  }
  if (/\s/.test(email) || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    throw new BootstrapError(`"${email}" does not look like an email address.`);
  }
  return email;
}

function requireType(raw: string): InstitutionTypeInput {
  const type = String(raw ?? "").trim().toUpperCase();
  if (type === "SCHOOL" || type === "COLLEGE") return type;
  throw new BootstrapError(`Institution type must be SCHOOL or COLLEGE, not "${raw}".`);
}

/**
 * Checked rather than trusted: the zone drives every attendance date boundary,
 * and a typo would misfile registers for as long as it went unnoticed.
 */
function requireTimezone(raw: string | undefined): string {
  const timezone = String(raw ?? "").trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new BootstrapError(`"${timezone}" is not a recognised IANA time zone (e.g. Asia/Kolkata).`);
  }
  return timezone;
}

/**
 * Defensive: proves the caller ran the password through the application's own
 * hasher rather than passing a plaintext straight through. modules/auth-tenancy
 * /password.ts encodes its parameters into the stored value, so the prefix is a
 * reliable shape check.
 */
function requirePasswordHash(raw: string): string {
  const hash = String(raw ?? "");
  if (!hash.startsWith("scrypt$") || hash.split("$").length !== 6) {
    throw new BootstrapError(
      "adminPasswordHash is not a hash produced by modules/auth-tenancy/password.ts. " +
        "Refusing to store it.",
    );
  }
  return hash;
}

/**
 * Creates exactly one Institution, one User and one UserRoleAssignment.
 *
 * Refuses unless the database is in the one state this is designed for: system
 * roles fully converged, and no institution, user or role assignment at all.
 * Any other shape — a half-finished earlier run, a second tenant, an admin
 * without an assignment — is reported rather than repaired, because every one
 * of those has more than one plausible fix and choosing between them is an
 * operator's decision, not this script's.
 *
 * Caller must run this inside a transaction that already holds the bootstrap
 * advisory lock (see runFirstTenantBootstrap), so the state check above cannot
 * race another run.
 */
export async function bootstrapFirstInstitutionAdmin(
  db: Client,
  input: FirstTenantInput,
): Promise<FirstTenantResult> {
  const institutionName = requireName(input.institutionName, "Institution name");
  const institutionType = requireType(input.institutionType);
  const timezone = requireTimezone(input.timezone);
  const adminName = requireName(input.adminName, "Administrator name");
  const adminEmail = requireEmail(input.adminEmail);
  const adminPasswordHash = requirePasswordHash(input.adminPasswordHash);

  const state = await inspectBootstrapState(db);

  if (!state.systemRolesComplete) {
    const broken = state.systemRoles
      .filter((s) => !s.present || s.missingPermissions.length > 0 || s.extraPermissions.length > 0)
      .map((s) => (s.present ? `${s.key} (grants out of date)` : `${s.key} (missing)`));
    throw new BootstrapError(
      `The platform roles are not in the state this expects: ${broken.join(", ")}. ` +
        `Run the system bootstrap (stage A) first, then retry.`,
    );
  }

  if (!state.tenantSlateClean) {
    throw new BootstrapError(
      `This database is not empty: ${state.institutionCount} institution(s), ` +
        `${state.userCount} user(s), ${state.roleAssignmentCount} role assignment(s). ` +
        `First-tenant bootstrap only runs against a database with none of the three. ` +
        `Nothing was written — inspect the state and decide deliberately.`,
    );
  }

  const adminRole = await db.role.findFirst({
    where: { institutionId: null, key: FIRST_ADMIN_ROLE_KEY },
    select: { id: true, key: true },
  });
  if (!adminRole) {
    // Unreachable while systemRolesComplete holds; kept so a future catalog
    // edit that drops the key fails loudly instead of creating a roleless admin.
    throw new BootstrapError(`The ${FIRST_ADMIN_ROLE_KEY} role does not exist. Run stage A first.`);
  }

  const institution = await db.institution.create({
    data: { name: institutionName, type: institutionType, timezone },
    select: { id: true },
  });

  const admin = await db.user.create({
    data: {
      institutionId: institution.id,
      // Institution-wide, not scoped to a campus: the first administrator has
      // to be able to create the campuses, so they cannot belong to one yet.
      campusId: null,
      name: adminName,
      email: adminEmail,
      passwordHash: adminPasswordHash,
      status: "ACTIVE",
    },
    select: { id: true },
  });

  const assignment = await db.userRoleAssignment.create({
    data: {
      userId: admin.id,
      roleId: adminRole.id,
      institutionId: institution.id,
      campusId: null,
    },
    select: { id: true },
  });

  return {
    institutionId: institution.id,
    institutionName,
    institutionType,
    timezone,
    adminUserId: admin.id,
    adminEmail,
    roleKey: adminRole.key,
    roleAssignmentId: assignment.id,
  };
}

// ---------------------------------------------------------------------------
// Stage C — the platform super administrator
// ---------------------------------------------------------------------------

/**
 * The role the platform administrator is granted. Distinct from
 * FIRST_ADMIN_ROLE_KEY above, and deliberately so: that one names the most
 * powerful role *inside* one institution, this one names the role that is
 * outside all of them.
 *
 * ## How stage C coexists with stage B
 *
 * They are alternative first writes, not sequential ones, and the asymmetry is
 * inherited rather than invented here:
 *
 *   tenant → platform    works. Stage C does not care whether institutions
 *                        exist; it only cares about the platform tier.
 *   platform → tenant    refuses. Stage B requires `tenantSlateClean`, and a
 *                        platform account is a User and a UserRoleAssignment,
 *                        so the slate is no longer clean. That refusal is the
 *                        behaviour already asserted by the "partially
 *                        initialised database (a user with no institution)"
 *                        test, and it is left exactly as it was.
 *
 * Closing stage B by running stage C first costs nothing now: a platform
 * administrator creates institutions and their administrators through the
 * application (modules/platform/administrators.ts), which stage B cannot do
 * more than once anyway. Stage B remains for a single-tenant install that
 * wants no platform tier at all.
 *
 * ## Why idempotency is checked rather than constrained
 *
 * `@@unique([userId, roleId, institutionId, campusId])` cannot help here.
 * Postgres treats NULLs as distinct in a unique index, and a platform
 * assignment is NULL in both scope columns, so two identical rows would both
 * insert. The advisory lock the entry point takes is what actually makes a
 * concurrent second run wait, observe the first, and report rather than write.
 */
export const PLATFORM_ADMIN_ROLE_KEY = "PLATFORM_SUPER_ADMIN";

export interface PlatformAdminInput {
  name: string;
  email: string;
  /** Already hashed by modules/auth-tenancy/password.ts. Never a plaintext. */
  passwordHash: string;
}

export interface PlatformAdminResult {
  userId: string;
  email: string;
  status: string;
  roleKey: string;
  roleAssignmentId: string;
  /** false when the account was already present and correct — nothing was written. */
  created: boolean;
}

/** One PLATFORM_SUPER_ADMIN assignment, with everything needed to judge it. */
export interface PlatformAdminHolder {
  userId: string;
  email: string;
  status: string;
  /** Null is the only correct value — an institution makes this a tenant account. */
  userInstitutionId: string | null;
  assignmentId: string;
  assignmentInstitutionId: string | null;
  assignmentCampusId: string | null;
}

export interface PlatformAdminState {
  rolePresent: boolean;
  holders: PlatformAdminHolder[];
  /** Users belonging to no institution. A correct deployment has exactly the holders. */
  institutionless: Array<{ id: string; email: string }>;
  /** Non-empty when the shape is one no bootstrap should act on. */
  problems: string[];
}

/**
 * Everything wrong with the platform tier, described rather than repaired.
 *
 * Each entry names an account and what is inconsistent about it. None of them
 * is fixed automatically: every one has more than one plausible repair — delete
 * the account, re-scope the assignment, move the user into an institution — and
 * picking between them on an operator's behalf, for the one role that can reach
 * every institution, is not a decision a script should make.
 */
function describePlatformProblems(
  holders: PlatformAdminHolder[],
  institutionless: Array<{ id: string; email: string }>,
): string[] {
  const problems: string[] = [];
  const holderUserIds = new Set(holders.map((holder) => holder.userId));

  if (holderUserIds.size > 1) {
    const names = [...new Set(holders.map((holder) => holder.email))].sort().join(", ");
    problems.push(
      `${holderUserIds.size} accounts already hold ${PLATFORM_ADMIN_ROLE_KEY} (${names}). ` +
        `A deployment is expected to have one.`,
    );
  }

  for (const userId of holderUserIds) {
    const rows = holders.filter((holder) => holder.userId === userId);
    if (rows.length > 1) {
      problems.push(
        `${rows[0].email} holds ${rows.length} separate ${PLATFORM_ADMIN_ROLE_KEY} assignments. ` +
          `The unique index does not catch this because its scope columns are NULL.`,
      );
    }
  }

  for (const holder of holders) {
    if (holder.userInstitutionId !== null) {
      problems.push(
        `${holder.email} holds ${PLATFORM_ADMIN_ROLE_KEY} but belongs to institution ` +
          `${holder.userInstitutionId}. A platform account must belong to none.`,
      );
    }
    if (holder.assignmentInstitutionId !== null) {
      problems.push(
        `${holder.email}'s ${PLATFORM_ADMIN_ROLE_KEY} assignment is scoped to institution ` +
          `${holder.assignmentInstitutionId}. A platform assignment must be institution-less.`,
      );
    }
    if (holder.assignmentCampusId !== null) {
      problems.push(
        `${holder.email}'s ${PLATFORM_ADMIN_ROLE_KEY} assignment is narrowed to a campus. ` +
          `A platform assignment must not be.`,
      );
    }
  }

  for (const user of institutionless) {
    if (!holderUserIds.has(user.id)) {
      problems.push(
        `${user.email} belongs to no institution but holds no ${PLATFORM_ADMIN_ROLE_KEY} ` +
          `assignment. An earlier run may have stopped between the two writes.`,
      );
    }
  }

  return problems;
}

/**
 * Read-only. Reports the platform tier without judging whether a particular
 * email should be bootstrapped into it.
 *
 * Deliberately separate from inspectBootstrapState rather than a field on it:
 * that function's shape is depended on by callers and its existing tests, and
 * widening it would make every one of them query tables they do not care about.
 */
export async function inspectPlatformAdminState(db: Client): Promise<PlatformAdminState> {
  const role = await db.role.findFirst({
    where: { institutionId: null, key: PLATFORM_ADMIN_ROLE_KEY },
    select: { id: true },
  });

  const rows = role
    ? await db.userRoleAssignment.findMany({
        where: { roleId: role.id },
        select: {
          id: true,
          institutionId: true,
          campusId: true,
          user: { select: { id: true, email: true, status: true, institutionId: true } },
        },
      })
    : [];

  const holders: PlatformAdminHolder[] = rows.map((row) => ({
    userId: row.user.id,
    email: row.user.email,
    status: String(row.user.status),
    userInstitutionId: row.user.institutionId,
    assignmentId: row.id,
    assignmentInstitutionId: row.institutionId,
    assignmentCampusId: row.campusId,
  }));

  // The other half of the definition. A user with no institution but no
  // platform assignment is invisible to the query above, and is exactly the
  // half-finished state worth refusing on.
  const institutionless = await db.user.findMany({
    where: { institutionId: null },
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
  });

  return {
    rolePresent: role !== null,
    holders,
    institutionless,
    problems: describePlatformProblems(holders, institutionless),
  };
}

/**
 * Creates the platform super administrator, or reports that it already exists.
 *
 * Creates no institution and assigns no institution-scoped role: both the User
 * and the UserRoleAssignment are written with a null institutionId, which is
 * what the schema documents as the shape of a platform account and what
 * isPlatformUser/requireSameInstitution already understand.
 *
 * Fails closed on anything it did not write itself. An address that already
 * belongs to somebody, a second platform account under a different address, a
 * platform role granted to a tenant user — each is refused with what was found,
 * and no row is modified. This never changes an existing account's password,
 * role, institution or status.
 *
 * Caller must run this inside a transaction that already holds the bootstrap
 * advisory lock (see runPlatformAdminBootstrap).
 */
export async function bootstrapPlatformAdmin(
  db: Client,
  input: PlatformAdminInput,
): Promise<PlatformAdminResult> {
  // Before any query, so malformed input cannot reach the database at all.
  const name = requireName(input.name, "Platform administrator name");
  const email = requireEmail(input.email);
  const passwordHash = requirePasswordHash(input.passwordHash);

  const state = await inspectBootstrapState(db);
  if (!state.systemRolesComplete) {
    const broken = state.systemRoles
      .filter((s) => !s.present || s.missingPermissions.length > 0 || s.extraPermissions.length > 0)
      .map((s) => (s.present ? `${s.key} (grants out of date)` : `${s.key} (missing)`));
    throw new BootstrapError(
      `The platform roles are not in the state this expects: ${broken.join(", ")}. ` +
        `Run the system bootstrap (stage A) first, then retry.`,
    );
  }

  const platform = await inspectPlatformAdminState(db);

  if (platform.problems.length > 0) {
    throw new BootstrapError(
      `The platform tier is not in a state this can act on:\n  - ` +
        `${platform.problems.join("\n  - ")}\n` +
        `Nothing was written. Resolve it deliberately — this never repairs an account.`,
    );
  }

  // Past the problem check, a single holder is necessarily well-formed: one
  // assignment, no institution on either row, no campus.
  const [holder] = platform.holders;
  if (holder) {
    if (holder.email !== email) {
      throw new BootstrapError(
        `${holder.email} is already the platform administrator. Refusing to add a second ` +
          `one for ${email} — a platform account can reach every institution, so a typo ` +
          `here is not something to converge on. Nothing was written.`,
      );
    }
    return {
      userId: holder.userId,
      email: holder.email,
      status: holder.status,
      roleKey: PLATFORM_ADMIN_ROLE_KEY,
      roleAssignmentId: holder.assignmentId,
      created: false,
    };
  }

  // No platform account exists. The address may still belong to somebody
  // inside a tenant, and promoting that account is not what this is for.
  const clash = await db.user.findUnique({
    where: { email },
    select: { id: true, institutionId: true },
  });
  if (clash) {
    throw new BootstrapError(
      `${email} already belongs to an account in institution ${clash.institutionId ?? "none"}. ` +
        `This never changes an existing account's role or institution. Nothing was written.`,
    );
  }

  const role = await db.role.findFirst({
    where: { institutionId: null, key: PLATFORM_ADMIN_ROLE_KEY },
    select: { id: true, key: true },
  });
  if (!role) {
    // Unreachable while systemRolesComplete holds; kept so a future catalog
    // edit that drops the key fails loudly instead of creating a roleless user.
    throw new BootstrapError(`The ${PLATFORM_ADMIN_ROLE_KEY} role does not exist. Run stage A first.`);
  }

  const user = await db.user.create({
    data: {
      // Both null, and that is the whole point: this is the one account the
      // product intends to sit outside every institution.
      institutionId: null,
      campusId: null,
      name,
      email,
      passwordHash,
      status: "ACTIVE",
    },
    select: { id: true, status: true },
  });

  const assignment = await db.userRoleAssignment.create({
    data: { userId: user.id, roleId: role.id, institutionId: null, campusId: null },
    select: { id: true },
  });

  return {
    userId: user.id,
    email,
    status: String(user.status),
    roleKey: role.key,
    roleAssignmentId: assignment.id,
    created: true,
  };
}

// ---------------------------------------------------------------------------
// Entry points — transaction + lock, so callers cannot forget either
// ---------------------------------------------------------------------------

export async function runSystemBootstrap(client: PrismaClient): Promise<SystemRoleSyncResult> {
  return client.$transaction(async (tx) => {
    await acquireBootstrapLock(tx);
    return ensureSystemRolesAndPermissions(tx);
  });
}

export async function runFirstTenantBootstrap(
  client: PrismaClient,
  input: FirstTenantInput,
): Promise<FirstTenantResult> {
  return client.$transaction(async (tx) => {
    await acquireBootstrapLock(tx);
    return bootstrapFirstInstitutionAdmin(tx, input);
  });
}

/**
 * The lock matters more here than anywhere else in this file. Two concurrent
 * runs would both find no platform account, and the unique index cannot stop
 * the second insert because a platform assignment is NULL in both of its scope
 * columns and Postgres treats NULLs as distinct. Serialised, the second run
 * sees the first's committed rows and reports `created: false`.
 */
export async function runPlatformAdminBootstrap(
  client: PrismaClient,
  input: PlatformAdminInput,
): Promise<PlatformAdminResult> {
  return client.$transaction(async (tx) => {
    await acquireBootstrapLock(tx);
    return bootstrapPlatformAdmin(tx, input);
  });
}
