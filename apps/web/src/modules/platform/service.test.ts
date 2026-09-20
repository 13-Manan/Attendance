import { test } from "node:test";
import assert from "node:assert/strict";
import { canAccessPlatformAdmin, getReadiness } from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Phase 13 — the platform tier's access boundary.
 *
 * The database-backed half of this lives in
 * `platform-access.integration.test.ts`, which calls every exported function
 * as every role. What is here is the part that needs no database: who the
 * tier is *offered* to, and what the readiness list is allowed to say.
 *
 * The readiness tests are not decoration. The list is the one place in the
 * product that states, to the person most able to act on it, that this build
 * cannot be released — and the failure mode is a future edit quietly softening
 * it into a status widget. So the blockers are asserted by name.
 */

function makeUser(permissions: string[], institutionId: string | null = "inst-A"): SessionUser {
  return {
    userId: "u1",
    email: "person@example.com",
    name: "A Person",
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

/** Everything an institution admin holds — every permission except platform.*. */
const INSTITUTION_ADMIN = [
  "institution.read",
  "institution.update",
  "campus.manage",
  "academicStructure.manage",
  "cohort.manage",
  "cohort.read",
  "user.invite",
  "user.update",
  "user.deactivate",
  "role.assign",
  "role.read",
  "student.create",
  "student.update",
  "student.read",
  "enrollment.manage",
  "attendanceSession.create",
  "attendanceSession.capture",
  "attendanceSession.finalize",
  "attendanceRecord.correct",
  "attendanceRecord.read",
  "faceEmbedding.manage",
  "auditLog.read",
];

const PLATFORM = [...INSTITUTION_ADMIN, "platform.institution.create", "platform.institution.suspend"];

// ---------------------------------------------------------------------------
// Who is offered the tier
// ---------------------------------------------------------------------------

test("only a platform permission opens the platform tier", () => {
  assert.equal(canAccessPlatformAdmin(makeUser(PLATFORM, null)), true);
  assert.equal(
    canAccessPlatformAdmin(makeUser(INSTITUTION_ADMIN)),
    false,
    "an institution admin holds every other permission and still does not get it",
  );
  assert.equal(canAccessPlatformAdmin(makeUser(["attendanceRecord.read"])), false);
  assert.equal(canAccessPlatformAdmin(makeUser([])), false);
});

test("the tier is not implied by any institution-level permission", () => {
  // Guards against somebody later adding `institution.read` as an alternative
  // gate because "an admin should see the platform page".
  for (const permission of INSTITUTION_ADMIN) {
    assert.equal(
      canAccessPlatformAdmin(makeUser([permission])),
      false,
      `${permission} must not open the platform tier`,
    );
  }
});

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

test("readiness needs a permission to read at all", () => {
  assert.throws(() => getReadiness(makeUser([])), ForbiddenError);
});

test("the face model is still reported as a blocking licensing item", () => {
  // The release blocker Phases 5, 11 and 12 all left standing. If this test
  // ever fails, either the provenance question was genuinely resolved — in
  // which case the item is removed as part of resolving it — or somebody
  // softened the dashboard.
  const items = getReadiness(makeUser(INSTITUTION_ADMIN));
  const model = items.find((item) => item.id === "face-model-provenance");

  assert.ok(model, "the face model item must be present");
  assert.equal(model.blocking, true);
  assert.equal(model.kind, "licensing");
  assert.ok(model.evidence, "and it must name where the evidence lives");
});

test("unmeasured accuracy is reported as a blocking technical item", () => {
  const items = getReadiness(makeUser(INSTITUTION_ADMIN));
  const accuracy = items.find((item) => item.id === "recognition-accuracy-unmeasured");
  assert.ok(accuracy);
  assert.equal(accuracy.blocking, true);
  assert.equal(accuracy.kind, "technical");
});

test("at least one blocker is outstanding, and the list says which kind", () => {
  const items = getReadiness(makeUser(INSTITUTION_ADMIN));
  const blocking = items.filter((item) => item.blocking);
  assert.ok(blocking.length >= 2, "both known release blockers are listed");

  // Every item is classified, because "licensing" and "security hardening"
  // are answered by different people on different timescales.
  const kinds = new Set(items.map((item) => item.kind));
  assert.ok(kinds.has("licensing"));
  assert.ok(kinds.has("technical"));
  assert.ok(kinds.has("security-hardening"));
});

test("the single-instance limitations are listed but not release-blocking", () => {
  // Real, worth knowing, and not a reason to hold a release — the distinction
  // the dashboard exists to make legible.
  const items = getReadiness(makeUser(INSTITUTION_ADMIN));
  for (const id of ["rate-limiter-single-instance", "realtime-single-instance"]) {
    const item = items.find((entry) => entry.id === id);
    assert.ok(item, `${id} must be listed`);
    assert.equal(item.blocking, false);
    assert.equal(item.kind, "security-hardening");
  }
});

test("no readiness item claims compliance or clearance", () => {
  // The product must not state a legal conclusion anywhere, least of all on
  // the screen an administrator would quote.
  const text = JSON.stringify(getReadiness(makeUser(INSTITUTION_ADMIN))).toLowerCase();
  for (const phrase of [
    "gdpr compliant",
    "dpdp compliant",
    "legally compliant",
    "production ready",
    "commercially cleared",
  ]) {
    assert.equal(text.includes(phrase), false, `readiness must not say "${phrase}"`);
  }
});
