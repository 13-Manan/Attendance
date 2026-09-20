import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "@/lib/prisma";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Phase 13 — every platform function, as every role, against a real database.
 *
 * The platform tier is the one module in the product that deliberately reads
 * across institutions. Everything else is protected by
 * `requireSameInstitution`; here there is no institution to compare against,
 * so the only thing standing between an institution admin and every other
 * tenant's figures is a permission check at the top of each function.
 *
 * A unit test with a stubbed repository would be asserting that the check is
 * called. This asserts that it *refuses* — and that the refusal happens before
 * any query runs, which is why the fixtures below contain data an unauthorized
 * caller would see if it did not.
 *
 *   INTEGRATION_DB_TEST=1 DATABASE_URL=... npm test --workspace=web
 */

const SKIP = process.env.INTEGRATION_DB_TEST !== "1" ? "INTEGRATION_DB_TEST is not set" : false;

const INST_A = "plat-inst-a";
const INST_B = "plat-inst-b";

type PlatformModule = typeof import("./service.ts");
let platform: PlatformModule;

async function cleanup() {
  for (const id of [INST_A, INST_B]) {
    await prisma.auditLog.deleteMany({ where: { institutionId: id } });
    await prisma.student.deleteMany({ where: { institutionId: id } });
    await prisma.institution.deleteMany({ where: { id } });
  }
  await prisma.institution.deleteMany({ where: { name: { startsWith: "Forged Tenant" } } });
}

before(async () => {
  if (SKIP) return;
  platform = await import("./service.ts");
  await cleanup();
  await prisma.institution.createMany({
    data: [
      { id: INST_A, name: "Platform Test A", type: "SCHOOL" },
      { id: INST_B, name: "Platform Test B", type: "COLLEGE" },
    ],
  });
  // Something to leak, so a missing check would be visible rather than vacuous.
  await prisma.student.create({
    data: {
      id: "plat-stu",
      institutionId: INST_B,
      studentCode: "B-1",
      firstName: "Other",
      lastName: "Tenant",
      status: "ACTIVE",
    },
  });
});

after(async () => {
  if (SKIP) return;
  await cleanup();
  await prisma.$disconnect();
});

function makeUser(
  permissions: readonly string[],
  institutionId: string | null = INST_A,
): SessionUser {
  return {
    userId: "plat-actor",
    email: "actor@example.com",
    name: "Actor",
    institutionId,
    campusId: null,
    roles: [
      {
        key: "ROLE",
        name: "Role",
        institutionId,
        campusId: null,
        permissions: permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

const INSTITUTION_ADMIN = [
  "institution.read",
  "institution.update",
  "cohort.manage",
  "role.assign",
  "student.read",
  "attendanceRecord.read",
  "auditLog.read",
  "faceEmbedding.manage",
];
const FACULTY = ["cohort.read", "student.read", "attendanceRecord.read"];
const STUDENT = ["student.read.own", "attendanceRecord.read.own"];
const PLATFORM = [...INSTITUTION_ADMIN, "platform.institution.create", "platform.institution.suspend"];

/** Every exported entry point, so a new one cannot be added unguarded. */
function allEntryPoints(actor: SessionUser): Array<[string, () => Promise<unknown>]> {
  return [
    ["getPlatformOverview", () => platform.getPlatformOverview(actor)],
    ["listInstitutions", () => platform.listInstitutions(actor)],
    ["getInstitutionDetail(own)", () => platform.getInstitutionDetail(actor, INST_A)],
    ["getInstitutionDetail(other)", () => platform.getInstitutionDetail(actor, INST_B)],
    [
      "createInstitution",
      () => platform.createInstitution(actor, { name: "Forged Tenant", type: "SCHOOL" }),
    ],
    ["setInstitutionSuspended", () => platform.setInstitutionSuspended(actor, INST_B, true)],
  ];
}

// ---------------------------------------------------------------------------
// The refusals
// ---------------------------------------------------------------------------

for (const [label, permissions] of [
  ["an institution admin", INSTITUTION_ADMIN],
  ["a faculty member", FACULTY],
  ["a student", STUDENT],
  ["an actor with no permissions", []],
] as const) {
  test(`${label} is refused by every platform function`, { skip: SKIP }, async () => {
    const actor = makeUser(permissions);
    for (const [name, call] of allEntryPoints(actor)) {
      await assert.rejects(call, ForbiddenError, `${label} must be refused by ${name}`);
    }
  });
}

test("a refused call writes nothing", { skip: SKIP }, async () => {
  // The check must precede the work. If `createInstitution` validated first
  // and authorized second, this count would move.
  const before = await prisma.institution.count();
  const actor = makeUser(INSTITUTION_ADMIN);
  for (const [, call] of allEntryPoints(actor)) {
    await call().catch(() => undefined);
  }
  assert.equal(await prisma.institution.count(), before);
  assert.equal(
    (await prisma.institution.findUniqueOrThrow({ where: { id: INST_B } })).suspendedAt,
    null,
    "and the suspension attempt left the other tenant alone",
  );
});

test("an institution admin cannot even read their own institution here", { skip: SKIP }, async () => {
  // Not an oversight. A platform view of one institution is that
  // institution's own dashboard, which already exists; offering a second one
  // would mean a second implementation of the same authorization.
  await assert.rejects(
    () => platform.getInstitutionDetail(makeUser(INSTITUTION_ADMIN), INST_A),
    ForbiddenError,
  );
});

// ---------------------------------------------------------------------------
// The permitted path
// ---------------------------------------------------------------------------

test("a platform user sees every tenant", { skip: SKIP }, async () => {
  const actor = makeUser(PLATFORM, null);
  const page = await platform.listInstitutions(actor);
  const ids = page.rows.map((row) => row.id);
  assert.ok(ids.includes(INST_A));
  assert.ok(ids.includes(INST_B), "including one they are not a member of");
});

test("the overview counts come from the database, not from a constant", { skip: SKIP }, async () => {
  const actor = makeUser(PLATFORM, null);
  const before = await platform.getPlatformOverview(actor);

  await prisma.institution.create({
    data: { id: "plat-inst-c", name: "Platform Test C", type: "SCHOOL" },
  });
  const after = await platform.getPlatformOverview(actor);
  await prisma.institution.delete({ where: { id: "plat-inst-c" } });

  assert.equal(after.institutions.total, before.institutions.total + 1);
  assert.equal(after.institutions.schools, before.institutions.schools + 1);
});

test("listing is bounded however large a page the caller asks for", { skip: SKIP }, async () => {
  const page = await platform.listInstitutions(makeUser(PLATFORM, null), {}, { limit: 100_000 });
  assert.ok(page.limit <= 100, `limit was ${page.limit}`);
});

test("filters narrow the listing server-side", { skip: SKIP }, async () => {
  const actor = makeUser(PLATFORM, null);
  const colleges = await platform.listInstitutions(actor, { type: "COLLEGE" });
  assert.ok(colleges.rows.every((row) => row.type === "COLLEGE"));

  const byName = await platform.listInstitutions(actor, { search: "Platform Test A" });
  assert.deepEqual(byName.rows.map((row) => row.id), [INST_A]);
});

test("suspension is reversible and cascades to nothing", { skip: SKIP }, async () => {
  const actor = makeUser(PLATFORM, null);
  const studentsBefore = await prisma.student.count({ where: { institutionId: INST_B } });

  const suspended = await platform.setInstitutionSuspended(actor, INST_B, true);
  assert.ok(suspended.suspendedAt);
  assert.equal(
    await prisma.student.count({ where: { institutionId: INST_B } }),
    studentsBefore,
    "suspending a tenant must not delete anybody",
  );

  const restored = await platform.setInstitutionSuspended(actor, INST_B, false);
  assert.equal(restored.suspendedAt, null);

  const trail = await prisma.auditLog.findMany({
    where: { institutionId: INST_B, action: { startsWith: "platform.institution" } },
    orderBy: { createdAt: "asc" },
  });
  assert.deepEqual(
    trail.map((row) => row.action),
    ["platform.institution.suspended", "platform.institution.restored"],
  );
  assert.equal(trail[0].actorUserId, "plat-actor", "and names who did it");
});

test("suspending needs the suspend permission, not merely platform access", { skip: SKIP }, async () => {
  // The two platform permissions are separable in the catalogue, so they are
  // checked separately here.
  const readOnly = makeUser([...INSTITUTION_ADMIN, "platform.institution.create"], null);
  await assert.rejects(
    () => platform.setInstitutionSuspended(readOnly, INST_B, true),
    ForbiddenError,
  );
});

test("detail reports counts without exposing any biometric value", { skip: SKIP }, async () => {
  const detail = await platform.getInstitutionDetail(makeUser(PLATFORM, null), INST_B);
  assert.ok(detail);
  assert.equal(typeof detail.counts.facesEnrolled, "number");

  const serialized = JSON.stringify(detail);
  for (const term of ["embedding", "descriptor", "vector"]) {
    assert.equal(
      serialized.toLowerCase().includes(term),
      false,
      `platform detail must not carry "${term}"`,
    );
  }
});

test("an unknown institution is null rather than an error", { skip: SKIP }, async () => {
  const detail = await platform.getInstitutionDetail(makeUser(PLATFORM, null), "no-such-tenant");
  assert.equal(detail, null);
});
