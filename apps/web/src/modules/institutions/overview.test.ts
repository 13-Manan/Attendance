import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import type { PermissionKey } from "@/modules/authorization/permissions";
import {
  getFaceServiceStatus,
  getInstitutionCounts,
  type InstitutionCountsDeps,
} from "./overview.ts";

/**
 * The dashboard's headline numbers are an aggregate, which makes them the
 * easiest place to leak a whole tenant at once: one missing `where` clause and
 * an administrator at School A is told how many students School B has.
 *
 * So these tests assert two separate things:
 *
 *  1. the permission is checked *before* any repository call — a refusal must
 *     not be distinguishable from an empty institution by how long it took;
 *  2. every count is issued with the caller's own institution id, taken from
 *     the session. There is no parameter to pass a different one, and these
 *     tests record what the function does with the only id it has.
 */

function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    userId: "user_1",
    email: "admin@school-a.test",
    name: "A. Admin",
    institutionId: "inst_a",
    campusId: null,
    roles: [],
    ...overrides,
  };
}

function withPermissions(permissions: PermissionKey[], overrides: Partial<SessionUser> = {}) {
  return sessionUser({
    roles: [
      {
        key: "TEST",
        name: "Test role",
        institutionId: overrides.institutionId ?? "inst_a",
        campusId: null,
        permissions,
      },
    ],
    ...overrides,
  });
}

/** Records the institution id every count was asked about. */
function spyDeps(): InstitutionCountsDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async countActiveStudents(institutionId) {
      calls.push(institutionId);
      return 120;
    },
    async countFacultyUsers(institutionId) {
      calls.push(institutionId);
      return 14;
    },
    async countCohorts(institutionId) {
      calls.push(institutionId);
      return 8;
    },
  };
}

test("an administrator gets the counts for their own institution", async () => {
  const deps = spyDeps();
  const counts = await getInstitutionCounts(withPermissions(["institution.read"]), deps);

  assert.deepEqual(counts, { students: 120, faculty: 14, cohorts: 8 });
  assert.deepEqual(deps.calls, ["inst_a", "inst_a", "inst_a"]);
});

test("every count is scoped to the session's institution, never another", async () => {
  const deps = spyDeps();
  await getInstitutionCounts(
    withPermissions(["institution.read"], { institutionId: "inst_b" }),
    deps,
  );

  // Three calls, all for inst_b. Nothing in this module can be pointed
  // elsewhere: the id comes off the session and there is no argument for it.
  assert.equal(deps.calls.length, 3);
  for (const institutionId of deps.calls) assert.equal(institutionId, "inst_b");
});

test("a caller without institution.read is refused before any query runs", async () => {
  const deps = spyDeps();
  await assert.rejects(
    () => getInstitutionCounts(withPermissions(["attendanceRecord.read"]), deps),
    /institution\.read|permission|forbidden/i,
  );

  // The refusal came first: no count was issued, so the response time reveals
  // nothing about whether the institution exists or how large it is.
  assert.deepEqual(deps.calls, []);
});

test("a student account is refused", async () => {
  const deps = spyDeps();
  await assert.rejects(() =>
    getInstitutionCounts(withPermissions(["student.read.own", "attendanceRecord.read.own"]), deps),
  );
  assert.deepEqual(deps.calls, []);
});

test("an account with no roles at all is refused", async () => {
  const deps = spyDeps();
  await assert.rejects(() => getInstitutionCounts(sessionUser(), deps));
  assert.deepEqual(deps.calls, []);
});

test("a platform account gets null rather than a cross-tenant total", async () => {
  // A platform operator belongs to no single institution. Summing every
  // institution's students into one number would be exactly the unscoped
  // aggregate this module exists to avoid.
  const deps = spyDeps();
  const counts = await getInstitutionCounts(
    withPermissions(["institution.read"], { institutionId: null }),
    deps,
  );

  assert.equal(counts, null);
  assert.deepEqual(deps.calls, []);
});

// ---------------------------------------------------------------------------
// Face service status
// ---------------------------------------------------------------------------

test("a reachable service is reported with the model it actually loaded", async () => {
  const status = await getFaceServiceStatus({
    async faceModelInfo() {
      return { modelName: "arcface-r100", modelVersion: "1.2.0", productionEligible: true };
    },
  });

  assert.deepEqual(status, {
    health: "operational",
    modelName: "arcface-r100",
    modelVersion: "1.2.0",
    productionEligible: true,
  });
});

test("productionEligible is passed through, never inferred from a reply", async () => {
  // The mock backend answers happily. Reachable is not production-ready, and
  // reporting it as ready would be a claim about recognition this product
  // must not make.
  const status = await getFaceServiceStatus({
    async faceModelInfo() {
      return { modelName: "mock", modelVersion: "0.0.0", productionEligible: false };
    },
  });

  assert.equal(status.health, "operational");
  assert.equal(status.productionEligible, false);
});

test("an unreachable service is a result, not an exception", async () => {
  // The page whose job is to report an outage is the last page that should
  // fail during one.
  const status = await getFaceServiceStatus({
    async faceModelInfo() {
      throw new Error("ECONNREFUSED");
    },
  });

  assert.deepEqual(status, {
    health: "unavailable",
    modelName: null,
    modelVersion: null,
    productionEligible: null,
  });
});

test("an unreachable service reports unknown eligibility, not ineligible", async () => {
  // null and false are different facts: "we could not ask" versus "we asked
  // and it is not cleared". The panel words them differently.
  const status = await getFaceServiceStatus({
    async faceModelInfo() {
      throw new Error("timeout");
    },
  });
  assert.equal(status.productionEligible, null);
  assert.notEqual(status.productionEligible, false);
});
