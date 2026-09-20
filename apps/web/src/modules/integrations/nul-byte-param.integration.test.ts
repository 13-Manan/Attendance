import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import type { ApiContext } from "./api-route.ts";

/**
 * Phase 14 — a NUL byte in a path parameter is refused, not handed to Postgres.
 *
 * `GET /api/v1/students/abc%00def` returned 500. The id reached
 * `prisma.student.findFirst`, the driver refused it at the wire with
 * `22021 invalid byte sequence for encoding "UTF8"`, and the handler's
 * catch-all turned an unhandled `PrismaClientUnknownRequestError` into an
 * internal error. Measured against the running production build, on three
 * separate `[id]` routes.
 *
 * Nothing leaked — the response body was the generic `internal_error` with a
 * request id, and the Prisma message stayed in the server log. What it did
 * give any holder of any valid key was an unhandled-exception path: a 500, an
 * error-log entry and whatever alerting sits on top of those, for free.
 *
 * Database-backed on purpose. The bug was that a string Prisma accepts is a
 * string Postgres rejects, so a stubbed repository would have proved nothing:
 * it is precisely the real driver that draws the distinction.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const INSTITUTION = "nul-inst";

type ServiceModule = typeof import("./service.ts");
let service: ServiceModule;

async function cleanup() {
  await prisma.student.deleteMany({ where: { institutionId: INSTITUTION } });
  await prisma.institution.deleteMany({ where: { id: INSTITUTION } });
}

before(async () => {
  if (SKIP) return;
  service = await import("./service.ts");
  await cleanup();
  await prisma.institution.create({
    data: { id: INSTITUTION, name: "NUL Byte Test", type: "SCHOOL" },
  });
  await prisma.student.create({
    data: {
      id: "nul-student",
      institutionId: INSTITUTION,
      studentCode: "N-1",
      firstName: "Real",
      lastName: "Student",
      status: "ACTIVE",
    },
  });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

function ctxWithId(id: string): ApiContext {
  return {
    request: new Request("http://localhost/api/v1/students/x"),
    url: new URL("http://localhost/api/v1/students/x"),
    requestId: "nul-test",
    apiKey: {
      apiKeyId: "nul-key",
      institutionId: INSTITUTION,
      name: "test",
      scopes: ["students:read"],
    },
    institutionId: INSTITUTION,
    idempotencyKey: null,
    params: { id },
    now: new Date(),
  };
}

/** The endpoints whose `[id]` segment reaches a database lookup. */
function endpoints(id: string): Array<[string, () => Promise<unknown>]> {
  return [
    ["students", () => service.getStudentEndpoint(ctxWithId(id))],
    ["classes", () => service.getClassEndpoint(ctxWithId(id))],
    ["sessions", () => service.getSessionEndpoint(ctxWithId(id))],
  ];
}

test("a NUL byte in an id is refused before it reaches the driver", { skip: SKIP }, async () => {
  for (const [name, call] of endpoints("abc\0def")) {
    const error = await call().then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error, `${name} should have refused`);
    // The distinguishing symptom: Prisma's own error class means the string
    // reached the database. Any ApiError means the guard caught it first.
    assert.notEqual(
      (error as Error).name,
      "PrismaClientUnknownRequestError",
      `${name} passed the NUL byte through to Postgres`,
    );
    assert.match(
      String((error as { code?: string }).code ?? (error as Error).message),
      /not_found/i,
      `${name} should refuse as not_found, got ${(error as Error).name}`,
    );
  }
});

test("a NUL anywhere in the string is caught, not just at the start", { skip: SKIP }, async () => {
  for (const id of ["\0", "\0abc", "abc\0", "a\0b\0c"]) {
    const error = await service.getStudentEndpoint(ctxWithId(id)).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(error);
    assert.notEqual((error as Error).name, "PrismaClientUnknownRequestError", `leaked for ${JSON.stringify(id)}`);
  }
});

test("an ordinary unknown id still reads the database and 404s", { skip: SKIP }, async () => {
  // The guard must not have turned every lookup into a refusal.
  const error = await service.getStudentEndpoint(ctxWithId("no-such-student")).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(error);
  assert.match(String((error as { code?: string }).code ?? ""), /not_found/i);
});

test("a real id still resolves", { skip: SKIP }, async () => {
  const result = await service.getStudentEndpoint(ctxWithId("nul-student"));
  assert.equal((result as { data: { id: string } }).data.id, "nul-student");
});
