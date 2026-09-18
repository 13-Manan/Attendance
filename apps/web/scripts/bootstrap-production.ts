/**
 * Production bootstrap — the one-time writes a new database needs.
 *
 * This is NOT `prisma/seed.ts` (which is the development-facing wrapper around
 * the same stage A) and NOT `scripts/dev-fixture.ts` (which creates demo
 * tenants and refuses to run anywhere but localhost). This script is the only
 * supported way to put the required rows into a production database.
 *
 *   inspect   Read-only. Reports what is present and what a bootstrap would do.
 *   system    Stage A — platform roles and permission grants. Idempotent.
 *   tenant    Stage B — the first Institution, its administrator, and the role
 *             assignment linking them. Runs once, against an empty database.
 *
 * Run:
 *   BOOTSTRAP_TARGET=local \
 *     npm run bootstrap:inspect --workspace=web
 *
 *   BOOTSTRAP_TARGET=production BOOTSTRAP_CONFIRM=WRITE-TO-PRODUCTION \
 *     npm run bootstrap:system --workspace=web
 *
 * Nothing here runs automatically: no lifecycle hook, no startup call, no CI
 * step, no deployment stage. It runs when a person runs it, and it refuses
 * unless that person said which database they meant.
 *
 * It never prints a password, a password hash, or DATABASE_URL.
 */

export {}; // top-level await needs this file to be a module

const STAGES = ["inspect", "system", "tenant"] as const;
type Stage = (typeof STAGES)[number];

const PRODUCTION_CONFIRMATION = "WRITE-TO-PRODUCTION";
const MIN_PASSWORD_LENGTH = 12;

function fail(message: string): never {
  console.error(`Refusing to run: ${message}`);
  process.exit(1);
}

/**
 * Connection strings surface in Prisma's initialisation errors, and this
 * script exists to be run against production by someone who may paste their
 * terminal into a ticket. Strip anything shaped like one before printing.
 */
function redact(value: unknown): string {
  const text = value instanceof Error ? (value.stack ?? value.message) : String(value);
  return text.replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"']+/g, "<redacted-url>");
}

// ---------------------------------------------------------------------------
// Guards — nothing is imported or connected until these pass
// ---------------------------------------------------------------------------

const stage = process.argv[2] as Stage | undefined;
if (!stage || !STAGES.includes(stage)) {
  fail(`the first argument must be one of: ${STAGES.join(", ")}.`);
}

/**
 * The target is declared, never inferred. Deciding "this looks like
 * production" from the shape of DATABASE_URL is exactly the kind of guess that
 * is wrong once, silently, against the database where it matters.
 */
const target = process.env.BOOTSTRAP_TARGET ?? "";
if (target !== "production" && target !== "local") {
  fail("set BOOTSTRAP_TARGET=production or BOOTSTRAP_TARGET=local explicitly.");
}

const databaseUrl = process.env.DATABASE_URL ?? "";
if (databaseUrl === "") fail("DATABASE_URL is not set.");

const looksLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(databaseUrl);

if (target === "local" && !looksLocal) {
  // The asymmetry is deliberate. Saying "local" and pointing at a remote
  // database is always a mistake, so it is refused. Saying "production" and
  // pointing at localhost is how this script gets tested, so it is allowed
  // and merely announced.
  fail("BOOTSTRAP_TARGET=local but DATABASE_URL does not point at localhost.");
}

if (target === "production") {
  if (process.env.BOOTSTRAP_CONFIRM !== PRODUCTION_CONFIRMATION) {
    fail(
      `BOOTSTRAP_TARGET=production also requires BOOTSTRAP_CONFIRM=${PRODUCTION_CONFIRMATION}. ` +
        `That confirmation was absent or did not match, so nothing was read or written.`,
    );
  }
  if (looksLocal) {
    console.warn("Note: BOOTSTRAP_TARGET=production, but DATABASE_URL points at localhost.");
  }
}

console.log(`Stage: ${stage}. Target: ${target}.`);

// ---------------------------------------------------------------------------
// Input — only for the tenant stage, only from the operator
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const value = (process.env[name] ?? "").trim();
  if (value === "") fail(`${name} is required for the tenant stage.`);
  return value;
}

/**
 * Reads a secret without echoing it. Falls back to an environment variable
 * when there is no terminal to prompt on — which is how this will run as a
 * Container Apps Job, where the value arrives as a Key Vault secret reference
 * rather than a person typing.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    import("node:readline")
      .then(({ createInterface }) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let answered = false;

        // Without this, standard input closing before an answer arrives leaves
        // the promise permanently pending: node exits with an "unsettled
        // top-level await" warning and no usable message. Fail closed instead.
        rl.on("close", () => {
          if (!answered) {
            reject(new Error("standard input closed before a password was entered."));
          }
        });

        rl.question(question, (answer) => {
          answered = true;
          rl.close();
          process.stdout.write("\n");
          resolve(answer);
        });

        // Assigned after question() so the prompt itself is written, then all
        // subsequent echo — every keystroke of the password — is swallowed.
        (rl as unknown as { _writeToOutput: (chunk: string) => void })._writeToOutput = () => {};
      })
      .catch(reject);
  });
}

async function readAdminPassword(): Promise<string> {
  const fromEnv = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

  if (!process.stdin.isTTY) {
    fail("set BOOTSTRAP_ADMIN_PASSWORD, or run interactively so the password can be prompted for.");
  }

  try {
    const first = await promptHidden("Administrator password (not echoed): ");
    const second = await promptHidden("Confirm password: ");
    if (first !== second) fail("the two passwords did not match.");
    return first;
  } catch (error) {
    fail(error instanceof Error ? error.message : "the password could not be read.");
  }
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const { prisma } = await import("@/lib/prisma");
const {
  BootstrapError,
  inspectBootstrapState,
  runFirstTenantBootstrap,
  runSystemBootstrap,
  FIRST_ADMIN_ROLE_KEY,
} = await import("@/modules/authorization/bootstrap");

try {
  if (stage === "inspect") {
    const state = await inspectBootstrapState(prisma);
    console.log(`Institutions:      ${state.institutionCount}`);
    console.log(`Users:             ${state.userCount}`);
    console.log(`Role assignments:  ${state.roleAssignmentCount}`);
    console.log(`System roles OK:   ${state.systemRolesComplete}`);
    for (const role of state.systemRoles) {
      const detail = !role.present
        ? "missing"
        : role.missingPermissions.length === 0 && role.extraPermissions.length === 0
          ? "ok"
          : `${role.missingPermissions.length} missing, ${role.extraPermissions.length} stale`;
      console.log(`  - ${role.key}: ${detail}`);
    }
    console.log(
      state.tenantSlateClean
        ? "\nNo institution, user or role assignment exists — the tenant stage may run."
        : "\nThis database already holds tenant rows — the tenant stage will refuse.",
    );
  }

  if (stage === "system") {
    const result = await runSystemBootstrap(prisma);
    for (const role of result.roles) {
      console.log(
        `${role.key}: ${role.created ? "created" : "already present"}, ` +
          `${role.permissionCount} permissions (+${role.permissionsAdded} / -${role.permissionsRemoved})`,
      );
    }
    console.log(`\nSystem bootstrap complete. ${result.rolesCreated} role(s) created.`);
  }

  if (stage === "tenant") {
    const institutionName = requireEnv("BOOTSTRAP_INSTITUTION_NAME");
    const institutionType = requireEnv("BOOTSTRAP_INSTITUTION_TYPE");
    const adminName = requireEnv("BOOTSTRAP_ADMIN_NAME");
    const adminEmail = requireEnv("BOOTSTRAP_ADMIN_EMAIL");
    const timezone = process.env.BOOTSTRAP_INSTITUTION_TIMEZONE?.trim() || undefined;

    const password = await readAdminPassword();
    if (password.length < MIN_PASSWORD_LENGTH) {
      fail(`the administrator password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }

    const { hashPassword } = await import("@/modules/auth-tenancy/password");
    const adminPasswordHash = await hashPassword(password);

    const result = await runFirstTenantBootstrap(prisma, {
      institutionName,
      institutionType: institutionType.toUpperCase() as "SCHOOL" | "COLLEGE",
      timezone,
      adminName,
      adminEmail,
      adminPasswordHash,
    });

    // Identifiers and the address the administrator signs in with. No
    // password, no hash, no connection string.
    console.log("First tenant created.");
    console.log(`  Institution:      ${result.institutionName} (${result.institutionType})`);
    console.log(`  Institution id:   ${result.institutionId}`);
    console.log(`  Time zone:        ${result.timezone}`);
    console.log(`  Administrator:    ${result.adminEmail}`);
    console.log(`  Administrator id: ${result.adminUserId}`);
    console.log(`  Role granted:     ${result.roleKey} (${FIRST_ADMIN_ROLE_KEY})`);
    console.log("\nSign in with that address and the password you supplied.");
  }
} catch (error) {
  if (error instanceof BootstrapError) {
    console.error(`\nRefused: ${error.message}`);
  } else {
    console.error(`\nBootstrap failed: ${redact(error)}`);
  }
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
