import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getInstitutionProfileForRequest,
  updateInstitutionProfileForRequest,
  type InstitutionProfileDeps,
  type InstitutionProfileInput,
} from "./service.ts";
import { InstitutionProfileError } from "./types.ts";
import type { InstitutionProfileRow } from "./repository.ts";
import type { RecordAuditLogInput } from "../audit/types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * The institution's own profile: who may change it, whose row it lands on, and
 * what survives the write.
 *
 * The assertion this module exists for is the settings merge. The recognition
 * thresholds, retention policy and attendance rules live in the same JSON
 * column as the academic-unit labels, and a save from this screen must not be
 * able to delete them.
 */

type Permissions = SessionUser["roles"][number]["permissions"];

function makeUser(
  overrides: { permissions?: string[]; institutionId?: string | null } = {},
): SessionUser {
  return {
    userId: "user-admin",
    email: "admin@example.edu",
    name: "Admin",
    institutionId: overrides.institutionId === undefined ? "inst-A" : overrides.institutionId,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: "inst-A",
        campusId: null,
        permissions: (overrides.permissions ?? [
          "institution.read",
          "institution.update",
        ]) as Permissions,
      },
    ],
  };
}

const ADMIN = makeUser();

function makeRow(overrides: Partial<InstitutionProfileRow> = {}): InstitutionProfileRow {
  return {
    id: "inst-A",
    name: "Green Valley School",
    type: "SCHOOL",
    timezone: "Asia/Kolkata",
    contactEmail: "office@greenvalley.edu",
    contactPhone: "+91 20 2612 3456",
    addressLine: "12 Nehru Road\nPune 411001",
    settings: {},
    ...overrides,
  } as InstitutionProfileRow;
}

const VALID: InstitutionProfileInput = {
  name: "  Green Valley Senior School  ",
  timezone: "Asia/Kolkata",
  contactEmail: "Office@GreenValley.EDU",
  contactPhone: "+91 20 2612 3456",
  addressLine: "12 Nehru Road\nPune 411001",
  academicUnitLabels: { SECTION: "Division" },
};

function spyDeps(overrides: InstitutionProfileDeps = {}) {
  const audits: RecordAuditLogInput[] = [];
  const scopes: string[] = [];
  const writes: { institutionId: string; data: Record<string, unknown> }[] = [];
  const deps: InstitutionProfileDeps = {
    get: async (institutionId) => {
      scopes.push(institutionId);
      return institutionId === "inst-A" ? makeRow() : null;
    },
    update: async (institutionId, data) => {
      writes.push({ institutionId, data: data as unknown as Record<string, unknown> });
    },
    audit: async (input) => {
      audits.push(input);
    },
    ...overrides,
  };
  return { deps, audits, scopes, writes };
}

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("the institution is taken from the session and is not a parameter", () => {
  // There is no institutionId argument to pass the wrong value to.
  // `Function.length` stops at the first default, so `overrides` is excluded
  // and these are exactly what a caller must supply.
  assert.equal(getInstitutionProfileForRequest.length, 1, "the actor, and nothing else");
  assert.equal(updateInstitutionProfileForRequest.length, 2, "the actor and the new values");
});

test("both the read and the write land on the session's institution", async () => {
  const { deps, scopes, writes } = spyDeps();
  await getInstitutionProfileForRequest(ADMIN, deps);
  await updateInstitutionProfileForRequest(ADMIN, VALID, deps);
  assert.deepEqual(scopes, ["inst-A", "inst-A"]);
  assert.deepEqual(
    writes.map((write) => write.institutionId),
    ["inst-A"],
  );
});

test("a platform-level account is told it has no institution rather than seeing one", async () => {
  const platform = makeUser({ institutionId: null });
  const { deps, scopes } = spyDeps();
  await assert.rejects(
    () => getInstitutionProfileForRequest(platform, deps),
    InstitutionProfileError,
  );
  assert.equal(scopes.length, 0, "nothing is read when there is no institution to scope to");
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("reading needs institution.read and saving needs institution.update", async () => {
  const reader = makeUser({ permissions: ["institution.read"] });
  const { deps, audits, writes } = spyDeps();

  await getInstitutionProfileForRequest(reader, deps);
  await assert.rejects(
    () => updateInstitutionProfileForRequest(reader, VALID, deps),
    ForbiddenError,
  );
  assert.equal(writes.length, 0, "a refused save must not reach the database");
  assert.equal(audits.length, 0);
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("labels come back resolved, so a page never has to know the defaults", async () => {
  const { deps } = spyDeps({
    get: async () => makeRow({ settings: { academicUnitLabels: { SECTION: "Division" } } }),
  });
  const profile = await getInstitutionProfileForRequest(ADMIN, deps);
  assert.equal(profile.academicUnitLabels.SECTION, "Division");
  assert.equal(profile.academicUnitLabels.GRADE, "Grade", "the rest are the shipped words");
});

test("a settings column holding junk still renders a profile", async () => {
  // Nothing enforces the shape of a Json column, and a heading is not worth a
  // 500.
  for (const junk of [null, "labels", 7, ["SECTION"]]) {
    const { deps } = spyDeps({ get: async () => makeRow({ settings: junk }) });
    const profile = await getInstitutionProfileForRequest(ADMIN, deps);
    assert.equal(profile.academicUnitLabels.SECTION, "Section");
  }
});

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

test("validation runs before the read, so a refused save touches nothing", async () => {
  const { deps, scopes, writes, audits } = spyDeps();
  await assert.rejects(
    () => updateInstitutionProfileForRequest(ADMIN, { ...VALID, name: "  " }, deps),
    InstitutionProfileError,
  );
  assert.deepEqual(scopes, [], "the row is not even fetched");
  assert.equal(writes.length, 0);
  assert.equal(audits.length, 0);
});

test("the values written are the normalised ones, not what the form sent", async () => {
  const { deps, writes } = spyDeps();
  await updateInstitutionProfileForRequest(ADMIN, VALID, deps);
  assert.equal(writes[0].data.name, "Green Valley Senior School");
  assert.equal(writes[0].data.contactEmail, "office@greenvalley.edu");
});

test("an emptied contact field is stored as null, not as an empty string", async () => {
  const { deps, writes } = spyDeps();
  await updateInstitutionProfileForRequest(
    ADMIN,
    { ...VALID, contactPhone: "", addressLine: "   " },
    deps,
  );
  assert.equal(writes[0].data.contactPhone, null);
  assert.equal(writes[0].data.addressLine, null);
});

test("saving a phone number cannot delete the recognition thresholds", async () => {
  // The whole point of merging rather than replacing: attendance and face
  // policy live in the same column, and this screen owns one key in it.
  const { deps, writes } = spyDeps({
    get: async () =>
      makeRow({
        settings: {
          attendanceMode: "SUBJECT",
          confidenceThresholds: { autoPresent: 0.82 },
          academicUnitLabels: { GRADE: "Standard" },
        },
      }),
  });

  await updateInstitutionProfileForRequest(ADMIN, VALID, deps);
  assert.deepEqual(writes[0].data.settings, {
    attendanceMode: "SUBJECT",
    confidenceThresholds: { autoPresent: 0.82 },
    academicUnitLabels: { SECTION: "Division" },
  });
});

test("a settings key this module has never heard of survives a save", async () => {
  const { deps, writes } = spyDeps({
    get: async () => makeRow({ settings: { somethingAddedLater: { keep: true } } }),
  });
  await updateInstitutionProfileForRequest(ADMIN, VALID, deps);
  assert.deepEqual((writes[0].data.settings as Record<string, unknown>).somethingAddedLater, {
    keep: true,
  });
});

test("clearing every override removes the key rather than storing an empty object", async () => {
  // "{}" and "absent" resolve identically, and one of them is a value somebody
  // has to wonder about later.
  const { deps, writes } = spyDeps({
    get: async () => makeRow({ settings: { academicUnitLabels: { SECTION: "Division" } } }),
  });
  await updateInstitutionProfileForRequest(
    ADMIN,
    { ...VALID, academicUnitLabels: { SECTION: "" } },
    deps,
  );
  assert.deepEqual(writes[0].data.settings, {});
});

test("the institution type is not something this screen can change", async () => {
  // SCHOOL and COLLEGE select different attendance shapes. A form field that
  // reached this would leave every existing session on the wrong side of that
  // branch, so the input has no such key and the saved profile keeps the type
  // it was bootstrapped with.
  const { deps, writes } = spyDeps();
  const after = await updateInstitutionProfileForRequest(
    ADMIN,
    { ...VALID, type: "COLLEGE" } as InstitutionProfileInput,
    deps,
  );
  assert.equal(after.type, "SCHOOL");
  assert.ok(!("type" in writes[0].data), "no type is sent to the database at all");
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test("a save writes one audit row carrying both sides of the change", async () => {
  const { deps, audits } = spyDeps({
    get: async () => makeRow({ name: "Green Valley School", contactPhone: null }),
  });
  await updateInstitutionProfileForRequest(ADMIN, VALID, deps);

  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "institution.profile_updated");
  assert.equal(audits[0].entityType, "Institution");
  assert.equal(audits[0].entityId, "inst-A");
  assert.equal(audits[0].institutionId, "inst-A");
  assert.equal(audits[0].actorUserId, "user-admin");

  const before = audits[0].beforeJson as Record<string, unknown>;
  const after = audits[0].afterJson as Record<string, unknown>;
  assert.equal(before.name, "Green Valley School");
  assert.equal(after.name, "Green Valley Senior School");
  assert.equal(before.contactPhone, null);
  assert.equal(after.contactPhone, "+91 20 2612 3456");
});

test("the audit row does not repeat the entity id or the unchangeable type", async () => {
  const { deps, audits } = spyDeps();
  await updateInstitutionProfileForRequest(ADMIN, VALID, deps);
  for (const side of [audits[0].beforeJson, audits[0].afterJson]) {
    const shape = side as Record<string, unknown>;
    assert.ok(!("id" in shape), "the row already carries the entity id");
    assert.ok(!("type" in shape), "it cannot change here, so every diff would show it equal");
  }
});

test("an institution that vanished between the read and the save is not audited", async () => {
  const { deps, audits, writes } = spyDeps({ get: async () => null });
  await assert.rejects(
    () => updateInstitutionProfileForRequest(ADMIN, VALID, deps),
    InstitutionProfileError,
  );
  assert.equal(writes.length, 0);
  assert.equal(audits.length, 0);
});
