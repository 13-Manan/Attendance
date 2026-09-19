import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCampusForRequest,
  getCampusForRequest,
  listCampusesForRequest,
  listOpenCampusOptions,
  setCampusOpenForRequest,
  updateCampusForRequest,
  type CampusDeps,
} from "./service.ts";
import { CampusError, type Campus } from "./types.ts";
import type { RecordAuditLogInput } from "../audit/types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Campus administration: who may do it, and whose institution it lands in.
 *
 * Everything is injected, so none of this needs a database. The assertions
 * that matter are the negative ones — that a campus id arriving from a URL
 * cannot reach another tenant's row, and that a refusal happens before any
 * write rather than after it.
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
        permissions: (overrides.permissions ?? ["institution.read", "campus.manage"]) as Permissions,
      },
    ],
  };
}

const ADMIN = makeUser();

function makeCampus(overrides: Partial<Campus> = {}): Campus {
  return {
    id: "campus-1",
    institutionId: "inst-A",
    name: "Main Campus",
    code: "MAIN",
    address: null,
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as Campus;
}

/** Records what the service asked for, so a test can assert on the scope. */
function spyDeps(overrides: CampusDeps = {}) {
  const audits: RecordAuditLogInput[] = [];
  const scopes: string[] = [];
  const deps: CampusDeps = {
    listSummaries: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    list: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    get: async (institutionId, id) => {
      scopes.push(institutionId);
      return institutionId === "inst-A" ? makeCampus({ id }) : null;
    },
    findByCode: async () => null,
    create: async (data) => makeCampus({ ...data, id: "campus-new" }),
    update: async (institutionId, id, data) => {
      scopes.push(institutionId);
      return institutionId === "inst-A" ? makeCampus({ id, ...data }) : null;
    },
    audit: async (input) => {
      audits.push(input);
    },
    ...overrides,
  };
  return { deps, audits, scopes };
}

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("every read is scoped to the institution on the session, which is not a parameter", () => {
  // The signatures are the guarantee: there is no institutionId argument to
  // pass the wrong value to. `Function.length` counts required parameters
  // only — it stops at the first default — so `overrides` is excluded and
  // these numbers are exactly "what a caller must supply". Adding an
  // institution id to either signature would fail here.
  assert.equal(listCampusesForRequest.length, 1, "the actor, and nothing else");
  assert.equal(getCampusForRequest.length, 2, "the actor and a campus id, and nothing else");
});

test("the institution passed to the repository comes from the session", async () => {
  const { deps, scopes } = spyDeps();
  await listCampusesForRequest(ADMIN, deps);
  assert.deepEqual(scopes, ["inst-A"]);
});

test("a campus belonging to another institution reads as not existing", async () => {
  // Not "forbidden": saying which would turn this into an oracle for guessing
  // another institution's campus ids.
  const { deps } = spyDeps({ get: async () => null });
  await assert.rejects(
    () => getCampusForRequest(ADMIN, "campus-from-inst-B", deps),
    (error: unknown) =>
      error instanceof CampusError && error.message === "That campus does not exist.",
  );
});

test("an update cannot reach across the tenant boundary even with a real id", async () => {
  // updateCampus filters on (id, institutionId) and returns null when nothing
  // matched, so a campus id lifted from another tenant's URL updates no rows.
  const { deps, audits } = spyDeps({ get: async () => null });
  await assert.rejects(
    () => updateCampusForRequest(ADMIN, "campus-from-inst-B", NEW_VALUES, deps),
    CampusError,
  );
  assert.equal(audits.length, 0, "a refused update must not write an audit row");
});

test("a platform-level account is told it has no institution rather than seeing everything", async () => {
  const platform = makeUser({ institutionId: null });
  const { deps, scopes } = spyDeps();
  await assert.rejects(() => listCampusesForRequest(platform, deps), CampusError);
  assert.equal(scopes.length, 0, "nothing is read when there is no institution to scope to");
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const NEW_VALUES = { name: "North Campus", code: "north", address: " 12 Nehru Road " };

test("reading needs institution.read and writing needs campus.manage", async () => {
  const reader = makeUser({ permissions: ["institution.read"] });
  const { deps, audits } = spyDeps();

  // A reader may list.
  await listCampusesForRequest(reader, deps);

  // A reader may not create, and is refused before anything is written.
  await assert.rejects(() => createCampusForRequest(reader, NEW_VALUES, deps), ForbiddenError);
  await assert.rejects(() => updateCampusForRequest(reader, "campus-1", NEW_VALUES, deps), ForbiddenError);
  await assert.rejects(() => setCampusOpenForRequest(reader, "campus-1", false, deps), ForbiddenError);
  assert.equal(audits.length, 0);
});

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

test("a created campus is normalised by the policy on the way in", async () => {
  let created: { name: string; code: string; address: string | null } | null = null;
  const { deps } = spyDeps({
    create: async (data) => {
      created = { name: data.name, code: data.code, address: data.address };
      return makeCampus(data);
    },
  });

  await createCampusForRequest(ADMIN, NEW_VALUES, deps);
  assert.deepEqual(created, { name: "North Campus", code: "NORTH", address: "12 Nehru Road" });
});

test("a duplicate code is refused with a sentence naming the clash", async () => {
  const { deps, audits } = spyDeps({
    findByCode: async () => makeCampus({ id: "campus-9", name: "Main Campus", code: "NORTH" }),
  });
  await assert.rejects(
    () => createCampusForRequest(ADMIN, NEW_VALUES, deps),
    (error: unknown) =>
      error instanceof CampusError && error.message.includes("Main Campus"),
  );
  assert.equal(audits.length, 0, "nothing was created, so nothing is audited");
});

test("creating writes one audit row carrying what was created", async () => {
  const { deps, audits } = spyDeps();
  await createCampusForRequest(ADMIN, NEW_VALUES, deps);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "campus.created");
  assert.equal(audits[0].entityType, "Campus");
  assert.equal(audits[0].institutionId, "inst-A");
  assert.equal(audits[0].actorUserId, "user-admin");
  assert.deepEqual(audits[0].afterJson, {
    name: "North Campus",
    code: "NORTH",
    address: "12 Nehru Road",
    isActive: true,
  });
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

test("keeping the same code is not a clash with itself", async () => {
  let checked = false;
  const { deps } = spyDeps({
    get: async (_institutionId, id) => makeCampus({ id, code: "NORTH" }),
    findByCode: async () => {
      checked = true;
      return makeCampus({ id: "campus-1", code: "NORTH" });
    },
  });

  await updateCampusForRequest(ADMIN, "campus-1", NEW_VALUES, deps);
  assert.equal(checked, false, "an unchanged code needs no uniqueness lookup at all");
});

test("an edit audits both the before and the after", async () => {
  const { deps, audits } = spyDeps({
    get: async (_i, id) => makeCampus({ id, name: "Old", code: "OLD", address: null }),
  });
  await updateCampusForRequest(ADMIN, "campus-1", NEW_VALUES, deps);
  assert.equal(audits[0].action, "campus.updated");
  assert.deepEqual(audits[0].beforeJson, { name: "Old", code: "OLD", address: null });
  assert.deepEqual(audits[0].afterJson, {
    name: "North Campus",
    code: "NORTH",
    address: "12 Nehru Road",
  });
});

// ---------------------------------------------------------------------------
// Closing and reopening
// ---------------------------------------------------------------------------

test("closing a campus keeps the row and only flips isActive", async () => {
  let written: Record<string, unknown> | null = null;
  const { deps, audits } = spyDeps({
    update: async (_i, id, data) => {
      written = data as Record<string, unknown>;
      return makeCampus({ id, isActive: false });
    },
  });

  await setCampusOpenForRequest(ADMIN, "campus-1", false, deps);
  assert.deepEqual(written, { isActive: false });
  assert.equal(audits[0].action, "campus.closed");
});

test("reopening is the same call with the other sign, and its own audit action", async () => {
  const { deps, audits } = spyDeps({
    get: async (_i, id) => makeCampus({ id, isActive: false }),
  });
  await setCampusOpenForRequest(ADMIN, "campus-1", true, deps);
  assert.equal(audits[0].action, "campus.reopened");
});

test("closing an already-closed campus is refused rather than silently succeeding", async () => {
  // A double-submitted Close is harmless; a second success would write an
  // audit row saying a campus was closed on a day it was already shut.
  const { deps, audits } = spyDeps({
    get: async (_i, id) => makeCampus({ id, isActive: false, name: "North" }),
  });
  await assert.rejects(
    () => setCampusOpenForRequest(ADMIN, "campus-1", false, deps),
    (error: unknown) => error instanceof CampusError && error.message === "North is already closed.",
  );
  assert.equal(audits.length, 0);
});

test("the audit action is derived from the transition, never chosen by the caller", () => {
  // setCampusOpenForRequest takes a boolean, not an action name, so there is
  // no argument that could make the log say the opposite of what happened.
  // Three required parameters: actor, campus id, and the desired state.
  assert.equal(setCampusOpenForRequest.length, 3);
});

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

test("a campus picker offers only open campuses", async () => {
  // A closed campus must not be assignable to a new student or a new member
  // of staff — that is the whole operational meaning of closing one.
  const { deps } = spyDeps({
    list: async () => [
      makeCampus({ id: "c1", name: "Main", isActive: true }),
      makeCampus({ id: "c2", name: "Shut", isActive: false }),
    ],
  });
  const options = await listOpenCampusOptions(ADMIN, deps);
  assert.deepEqual(
    options.map((option) => option.id),
    ["c1"],
  );
});
