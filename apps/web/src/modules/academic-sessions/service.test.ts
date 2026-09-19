import { test } from "node:test";
import assert from "node:assert/strict";
import { createAcademicSessionForRequest, listAcademicSessionsForRequest } from "./service.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { RecordAuditLogInput } from "../audit/types.ts";
import { AcademicSessionError, type AcademicSession } from "./types.ts";

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

// ---------------------------------------------------------------------------
// What creating a year refuses, and in what words
//
// Both refusals reach a form, so both are asserted on the sentence rather than
// on the error class. The page can only be as specific as the service is: when
// these threw a bare Error and a Prisma constraint violation, the only honest
// thing it could say was "check dates and uniqueness", which tells somebody who
// got the dates right to go and look at them again.
// ---------------------------------------------------------------------------

function admin(): SessionUser {
  return makeUser({ institutionId: "inst-A", permissions: ["academicStructure.manage"] });
}

test("a year that ends before it starts is refused, and the refusal says so", async () => {
  let written = false;
  await assert.rejects(
    () =>
      createAcademicSessionForRequest(
        admin(),
        {
          institutionId: "inst-A",
          name: "2027-28",
          startDate: new Date("2027-06-01"),
          endDate: new Date("2027-03-31"),
        },
        {
          findByName: async () => null,
          createAcademicSession: async () => {
            written = true;
            return {} as AcademicSession;
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof AcademicSessionError);
      assert.match(error.message, /end date must be after the start date/);
      return true;
    },
  );
  assert.equal(written, false, "nothing is written when the range is impossible");
});

test("a duplicate name is refused by name, before the unique index sees it", async () => {
  let written = false;
  const lookups: Array<[string, string]> = [];
  await assert.rejects(
    () =>
      createAcademicSessionForRequest(
        admin(),
        {
          institutionId: "inst-A",
          name: "2026-27",
          startDate: new Date("2026-06-01"),
          endDate: new Date("2027-05-31"),
        },
        {
          findByName: async (institutionId, name) => {
            lookups.push([institutionId, name]);
            return { id: "year-1", name } as AcademicSession;
          },
          createAcademicSession: async () => {
            written = true;
            return {} as AcademicSession;
          },
        },
      ),
    (error: unknown) => {
      assert.ok(error instanceof AcademicSessionError);
      assert.match(error.message, /already has an academic year called 2026-27/);
      return true;
    },
  );
  assert.equal(written, false);
  assert.deepEqual(
    lookups,
    [["inst-A", "2026-27"]],
    "the name is only ever looked for inside the actor's own institution",
  );
});

test("the duplicate check cannot be pointed at another institution's years", async () => {
  // The lookup takes whatever `institutionId` the input carries, and that input
  // is what `requireSameInstitution` has already refused to let differ from the
  // actor's. Asserting the order matters: a check that ran first would answer
  // "is this name taken at inst-B?" for somebody at inst-A.
  let looked = false;
  await assert.rejects(
    () =>
      createAcademicSessionForRequest(
        admin(),
        {
          institutionId: "inst-B",
          name: "2026-27",
          startDate: new Date("2026-06-01"),
          endDate: new Date("2027-05-31"),
        },
        {
          findByName: async () => {
            looked = true;
            return null;
          },
          createAcademicSession: async () => ({}) as AcademicSession,
        },
      ),
    ForbiddenError,
  );
  assert.equal(looked, false, "the tenant guard fires before anything is read");
});

test("a year that breaks no rule is written and audited", async () => {
  const created = {
    id: "year-9",
    institutionId: "inst-A",
    name: "2027-28",
    startDate: new Date("2027-06-01"),
    endDate: new Date("2028-05-31"),
    isActive: true,
    isCurrent: false,
    createdAt: new Date("2026-09-20"),
  } as AcademicSession;

  const audited: RecordAuditLogInput[] = [];
  const result = await createAcademicSessionForRequest(
    admin(),
    {
      institutionId: "inst-A",
      name: "2027-28",
      startDate: new Date("2027-06-01"),
      endDate: new Date("2028-05-31"),
    },
    {
      findByName: async () => null,
      createAcademicSession: async () => created,
      audit: async (input) => {
        audited.push(input);
      },
    },
  );

  assert.equal(result, created, "the refusals are additions, not a new gate on the happy path");
  assert.equal(audited.length, 1);
  assert.equal(audited[0].action, "academic_session.created");
  assert.equal(audited[0].entityId, "year-9");
  assert.equal(
    audited[0].institutionId,
    "inst-A",
    "the row is filed under the institution that owns the year",
  );
  assert.equal(audited[0].actorUserId, "user-1");
});
