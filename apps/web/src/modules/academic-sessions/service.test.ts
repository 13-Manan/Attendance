import { test } from "node:test";
import assert from "node:assert/strict";
import { createAcademicSessionForRequest, listAcademicSessionsForRequest } from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { AcademicSession } from "./types.ts";

function makeUser(overrides: Partial<SessionUser> & { permissions: string[]; roleKey?: string }): SessionUser {
  return {
    userId: overrides.userId ?? "user-1",
    email: overrides.email ?? "user@example.com",
    name: overrides.name ?? "Test User",
    institutionId: overrides.institutionId ?? "inst-A",
    campusId: overrides.campusId ?? null,
    roles: [
      {
        key: overrides.roleKey ?? "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: overrides.institutionId ?? "inst-A",
        campusId: null,
        permissions: overrides.permissions as SessionUser["roles"][number]["permissions"],
      },
    ],
  };
}

test("cross-institution academic session listing is denied before any DB call", async () => {
  const admin = makeUser({
    institutionId: "inst-A",
    permissions: ["academicStructure.manage"],
  });
  let called = false;
  await assert.rejects(
    () =>
      listAcademicSessionsForRequest(admin, "inst-B", {
        listAcademicSessionsByInstitution: async () => {
          called = true;
          return [];
        },
      }),
    ForbiddenError,
  );
  assert.equal(called, false);
});

test("a user without academicStructure.manage cannot create an academic session", async () => {
  const faculty = makeUser({
    roleKey: "FACULTY",
    permissions: ["cohort.read"],
  });
  let called = false;
  await assert.rejects(
    () =>
      createAcademicSessionForRequest(
        faculty,
        {
          institutionId: "inst-A",
          name: "2026-27",
          startDate: new Date("2026-06-01"),
          endDate: new Date("2027-05-31"),
        },
        {
          createAcademicSession: async () => {
            called = true;
            return {} as AcademicSession;
          },
        },
      ),
    ForbiddenError,
  );
  assert.equal(called, false);
});
