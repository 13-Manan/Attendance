import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * Phase 22 — the production confirmation gate still refuses, now that there is
 * one more stage behind it.
 *
 * These run the operator CLI as a real subprocess rather than importing it. The
 * guards are top-level statements that call process.exit, so importing the
 * module would take the test runner down with it, and the thing worth proving
 * is the behaviour an operator actually gets: a non-zero exit and a message,
 * before anything is read or written.
 *
 * Every case here stops in the guard block, which runs before the script
 * imports Prisma. No database is contacted, so DATABASE_URL below only has to
 * parse — it is never connected to.
 */

const run = promisify(execFile);

const WEB_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = "scripts/bootstrap-production.ts";
const LOADER = "./scripts/register-test-loader.mjs";

const LOCAL_URL = "postgresql://bootstrap:guard@localhost:5432/never_connected";
const REMOTE_URL = "postgresql://bootstrap:guard@db.example.invalid:5432/never_connected";

interface Outcome {
  code: number;
  output: string;
}

async function bootstrap(args: string[], env: Record<string, string>): Promise<Outcome> {
  try {
    const { stdout, stderr } = await run("node", ["--import", LOADER, SCRIPT, ...args], {
      cwd: WEB_ROOT,
      timeout: 60_000,
      // A clean slate: the developer's own BOOTSTRAP_* variables must not
      // decide whether this passes. Deliberately not a full ProcessEnv — the
      // point is that the subprocess inherits nothing it was not handed.
      env: {
        NODE_ENV: process.env.NODE_ENV,
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NODE_OPTIONS: "",
        DATABASE_URL: LOCAL_URL,
        ...env,
      },
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

const PRODUCTION = { BOOTSTRAP_TARGET: "production" };
const CONFIRM = "WRITE-TO-PRODUCTION";

test("the resting state — no stage — refuses", async () => {
  // This is what the bootstrap image does when started with no args.
  const result = await bootstrap([], {});
  assert.equal(result.code, 1);
  assert.match(result.output, /the first argument must be one of/);
  assert.match(result.output, /inspect, system, tenant, platform/);
});

test("an unknown stage refuses", async () => {
  const result = await bootstrap(["promote"], PRODUCTION);
  assert.equal(result.code, 1);
  assert.match(result.output, /must be one of/);
});

test("every writing stage refuses without an explicit target", async () => {
  for (const stage of ["system", "tenant", "platform"]) {
    const result = await bootstrap([stage], {});
    assert.equal(result.code, 1, `${stage} should refuse`);
    assert.match(result.output, /set BOOTSTRAP_TARGET=production or BOOTSTRAP_TARGET=local/);
  }
});

test("every writing stage refuses production without the confirmation", async () => {
  for (const stage of ["system", "tenant", "platform"]) {
    const result = await bootstrap([stage], PRODUCTION);
    assert.equal(result.code, 1, `${stage} should refuse`);
    assert.match(result.output, new RegExp(`requires BOOTSTRAP_CONFIRM=${CONFIRM}`));
    assert.match(result.output, /nothing was read or written/);
  }
});

test("the platform stage refuses a confirmation that does not match exactly", async () => {
  for (const confirm of ["write-to-production", "WRITE-TO-PRODUCTION ", "yes", "true", ""]) {
    const result = await bootstrap(["platform"], { ...PRODUCTION, BOOTSTRAP_CONFIRM: confirm });
    assert.equal(result.code, 1, `should refuse confirmation ${JSON.stringify(confirm)}`);
    assert.match(result.output, /BOOTSTRAP_CONFIRM/);
  }
});

test("the platform stage refuses a local target pointed at a remote database", async () => {
  const result = await bootstrap(["platform"], {
    BOOTSTRAP_TARGET: "local",
    DATABASE_URL: REMOTE_URL,
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /does not point at localhost/);
});

test("the platform stage requires its email, and names the variable", async () => {
  const result = await bootstrap(["platform"], { BOOTSTRAP_TARGET: "local" });
  assert.equal(result.code, 1);
  assert.match(result.output, /BOOTSTRAP_PLATFORM_ADMIN_EMAIL is required for the platform stage/);
});

test("the platform stage will not take a password from a non-interactive run", async () => {
  // Past every guard, with the email supplied: the remaining refusal is the
  // password, which must come from the secret mechanism and is never defaulted.
  const result = await bootstrap(["platform"], {
    BOOTSTRAP_TARGET: "local",
    BOOTSTRAP_PLATFORM_ADMIN_EMAIL: "someone@example.test",
  });
  assert.equal(result.code, 1);
  assert.match(result.output, /set BOOTSTRAP_ADMIN_PASSWORD, or run interactively/);
});

test("no refusal message echoes the connection string", async () => {
  const secret = "postgresql://sensitive:s3cret@db.example.invalid:5432/prod";
  for (const args of [[], ["platform"], ["tenant"]]) {
    const result = await bootstrap(args, { BOOTSTRAP_TARGET: "local", DATABASE_URL: secret });
    assert.equal(result.output.includes("s3cret"), false, "a password must never be printed");
    assert.equal(result.output.includes(secret), false, "the URL must never be printed");
  }
});
