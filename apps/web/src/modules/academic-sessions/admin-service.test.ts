import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getAcademicSessionForRequest,
  getCurrentAcademicSessionForRequest,
  listAcademicSessionSummariesForRequest,
  setAcademicSessionArchivedForRequest,
  setCurrentAcademicSessionForRequest,
  updateAcademicSessionForRequest,
  type AcademicSessionDeps,
} from "./service.ts";
import { AcademicSessionError, type AcademicSession } from "./types.ts";
import type { RecordAuditLogInput } from "../audit/types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Administering an academic year: which one is current, what may be archived,
 * and whose institution it all lands in.
 *
 * Everything is injected, so none of this needs a database. The assertions
 * that matter are the negative ones — that a year id arriving from a URL
 * cannot reach another tenant's row, that the institution can never be left
 * with no current year by accident, and that a refusal happens before any
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
        permissions: (overrides.permissions ?? ["academicStructure.manage"]) as Permissions,
      },
    ],
  };
}

const ADMIN = makeUser();

function makeSession(overrides: Partial<AcademicSession> = {}): AcademicSession {
  return {
    id: "year-1",
    institutionId: "inst-A",
    name: "2026-27",
    startDate: new Date("2026-06-01T00:00:00.000Z"),
    endDate: new Date("2027-03-31T00:00:00.000Z"),
    isActive: true,
    isCurrent: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as AcademicSession;
}

function spyDeps(overrides: AcademicSessionDeps = {}) {
  const audits: RecordAuditLogInput[] = [];
  const scopes: string[] = [];
  const writes: { id: string; data: Record<string, unknown> }[] = [];
  const deps: AcademicSessionDeps = {
    listSummaries: async (institutionId) => {
      scopes.push(institutionId);
      return [];
    },
    get: async (institutionId, id) => {
      scopes.push(institutionId);
      return institutionId === "inst-A" ? makeSession({ id }) : null;
    },
    getCurrent: async (institutionId) => {
      scopes.push(institutionId);
      return null;
    },
    findByName: async () => null,
    update: async (institutionId, id, data) => {
      scopes.push(institutionId);
      writes.push({ id, data: data as Record<string, unknown> });
      return institutionId === "inst-A" ? 1 : 0;
    },
    setCurrent: async (institutionId, id) => {
      scopes.push(institutionId);
      writes.push({ id, data: { isCurrent: true } });
      return { changed: institutionId === "inst-A", unset: ["year-old"] };
    },
    audit: async (input) => {
      audits.push(input);
    },
    ...overrides,
  };
  return { deps, audits, scopes, writes };
}

const VALID = { name: "2026-27", startDate: "2026-06-01", endDate: "2027-03-31" };

// ---------------------------------------------------------------------------
// Tenancy
// ---------------------------------------------------------------------------

test("no function here takes an institution id", () => {
  // The signatures are the guarantee: there is no argument to pass the wrong
  // value to. `Function.length` stops at the first default, so `overrides` is
  // excluded and these are exactly what a caller must supply.
  assert.equal(listAcademicSessionSummariesForRequest.length, 1, "the actor, and nothing else");
  assert.equal(getAcademicSessionForRequest.length, 2, "the actor and a year id");
  assert.equal(setCurrentAcademicSessionForRequest.length, 2, "the actor and a year id");
  assert.equal(getCurrentAcademicSessionForRequest.length, 1, "the actor, and nothing else");
});

test("the institution passed to the repository comes from the session", async () => {
  const { deps, scopes } = spyDeps();
  await listAcademicSessionSummariesForRequest(ADMIN, deps);
  assert.deepEqual(scopes, ["inst-A"]);
});

test("a year belonging to another institution reads as not existing", async () => {
  // Not "forbidden": saying which would turn this into an oracle for guessing
  // another institution's year ids.
  const { deps } = spyDeps({ get: async () => null });
  await assert.rejects(
    () => getAcademicSessionForRequest(ADMIN, "year-from-inst-B", deps),
    (error: unknown) =>
      error instanceof AcademicSessionError &&
      error.message === "That academic year does not exist.",
  );
});

test("a platform-level account is told it has no institution rather than seeing every year", async () => {
  const platform = makeUser({ institutionId: null });
  const { deps, scopes } = spyDeps();
  await assert.rejects(
    () => listAcademicSessionSummariesForRequest(platform, deps),
    AcademicSessionError,
  );
  assert.equal(scopes.length, 0, "nothing is read when there is no institution to scope to");
});

test("every entry point checks the permission before it reads anything", async () => {
  const faculty = makeUser({ permissions: ["cohort.read"] });
  const { deps, scopes, writes, audits } = spyDeps();

  await assert.rejects(() => listAcademicSessionSummariesForRequest(faculty, deps), ForbiddenError);
  await assert.rejects(() => getAcademicSessionForRequest(faculty, "year-1", deps), ForbiddenError);
  await assert.rejects(() => getCurrentAcademicSessionForRequest(faculty, deps), ForbiddenError);
  await assert.rejects(
    () => updateAcademicSessionForRequest(faculty, "year-1", VALID, deps),
    ForbiddenError,
  );
  await assert.rejects(
    () => setCurrentAcademicSessionForRequest(faculty, "year-1", deps),
    ForbiddenError,
  );
  await assert.rejects(
    () => setAcademicSessionArchivedForRequest(faculty, "year-1", true, deps),
    ForbiddenError,
  );

  assert.deepEqual(scopes, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(audits, []);
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

test("validation runs before the read, so a refused edit touches nothing", async () => {
  const { deps, scopes, writes, audits } = spyDeps();
  await assert.rejects(
    () => updateAcademicSessionForRequest(ADMIN, "year-1", { ...VALID, name: "  " }, deps),
    AcademicSessionError,
  );
  await assert.rejects(
    () =>
      updateAcademicSessionForRequest(
        ADMIN,
        "year-1",
        { ...VALID, endDate: "2026-05-31" },
        deps,
      ),
    AcademicSessionError,
  );
  assert.deepEqual(scopes, [], "the row is not even fetched");
  assert.equal(writes.length, 0);
  assert.equal(audits.length, 0);
});

test("the dates written are parsed as calendar days, not as local time", async () => {
  const { deps, writes } = spyDeps();
  await updateAcademicSessionForRequest(ADMIN, "year-1", VALID, deps);
  assert.equal((writes[0].data.startDate as Date).toISOString(), "2026-06-01T00:00:00.000Z");
  assert.equal((writes[0].data.endDate as Date).toISOString(), "2027-03-31T00:00:00.000Z");
});

test("a duplicate name is refused with a sentence naming the clash", async () => {
  const { deps, audits, writes } = spyDeps({
    get: async (_i, id) => makeSession({ id, name: "2025-26" }),
    findByName: async () => makeSession({ id: "year-9", name: "2026-27" }),
  });
  await assert.rejects(
    () => updateAcademicSessionForRequest(ADMIN, "year-1", VALID, deps),
    (error: unknown) =>
      error instanceof AcademicSessionError && error.message.includes("2026-27"),
  );
  assert.equal(writes.length, 0);
  assert.equal(audits.length, 0);
});

test("keeping the same name is not a clash with itself", async () => {
  let checked = false;
  const { deps } = spyDeps({
    get: async (_i, id) => makeSession({ id, name: "2026-27" }),
    findByName: async () => {
      checked = true;
      return makeSession({ id: "year-1" });
    },
  });
  await updateAcademicSessionForRequest(ADMIN, "year-1", VALID, deps);
  assert.equal(checked, false, "an unchanged name needs no uniqueness lookup at all");
});

test("an edit audits both sides of the change", async () => {
  const { deps, audits } = spyDeps({
    get: async (_i, id) => makeSession({ id, name: "2026-2027" }),
  });
  await updateAcademicSessionForRequest(ADMIN, "year-1", VALID, deps);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "academic_session.updated");
  assert.equal(audits[0].entityType, "AcademicSession");
  assert.equal(audits[0].institutionId, "inst-A");
  assert.equal((audits[0].beforeJson as Record<string, unknown>).name, "2026-2027");
  assert.equal((audits[0].afterJson as Record<string, unknown>).name, "2026-27");
});

test("an edit that matched no row is not audited as though it happened", async () => {
  const { deps, audits } = spyDeps({ update: async () => 0 });
  await assert.rejects(
    () => updateAcademicSessionForRequest(ADMIN, "year-1", VALID, deps),
    AcademicSessionError,
  );
  assert.equal(audits.length, 0);
});

// ---------------------------------------------------------------------------
// The current year
// ---------------------------------------------------------------------------

test("making a year current names the year that stopped being current", async () => {
  const { deps, audits } = spyDeps();
  await setCurrentAcademicSessionForRequest(ADMIN, "year-1", deps);
  assert.equal(audits[0].action, "academic_session.activated");
  assert.deepEqual((audits[0].afterJson as Record<string, unknown>).noLongerCurrent, ["year-old"]);
});

test("making the current year current again is refused rather than logged as a change", async () => {
  // A double-submitted click is harmless; a second success would write a log
  // row saying somebody switched the current year on a day nothing changed.
  const { deps, audits, writes } = spyDeps({
    get: async (_i, id) => makeSession({ id, name: "2026-27", isCurrent: true }),
  });
  await assert.rejects(
    () => setCurrentAcademicSessionForRequest(ADMIN, "year-1", deps),
    (error: unknown) =>
      error instanceof AcademicSessionError &&
      error.message === "2026-27 is already the current academic year.",
  );
  assert.equal(writes.length, 0);
  assert.equal(audits.length, 0);
});

test("a year from another institution cannot be made current", async () => {
  const { deps, audits } = spyDeps({ get: async () => null });
  await assert.rejects(
    () => setCurrentAcademicSessionForRequest(ADMIN, "year-from-inst-B", deps),
    AcademicSessionError,
  );
  assert.equal(audits.length, 0);
});

test("having no current year is an answer, not an error", async () => {
  // A freshly created institution has none until somebody chooses one, and the
  // screens that need it say so rather than failing.
  const { deps } = spyDeps();
  assert.equal(await getCurrentAcademicSessionForRequest(ADMIN, deps), null);
});

// ---------------------------------------------------------------------------
// Archiving and restoring
// ---------------------------------------------------------------------------

test("the current year cannot be archived while it is current", async () => {
  // Otherwise the institution is left with no answer to "which year is this",
  // and the decision to have none would be hidden inside an action that says
  // "archive".
  const { deps, writes, audits } = spyDeps({
    get: async (_i, id) => makeSession({ id, name: "2026-27", isCurrent: true }),
  });
  await assert.rejects(
    () => setAcademicSessionArchivedForRequest(ADMIN, "year-1", true, deps),
    (error: unknown) =>
      error instanceof AcademicSessionError && error.message.includes("Make another year current"),
  );
  assert.equal(writes.length, 0);
  assert.equal(audits.length, 0);
});

test("archiving keeps the row and only flips isActive", async () => {
  const { deps, writes, audits } = spyDeps();
  await setAcademicSessionArchivedForRequest(ADMIN, "year-1", true, deps);
  assert.deepEqual(writes[0].data, { isActive: false });
  assert.equal(audits[0].action, "academic_session.archived");
});

test("restoring is the same call with the other sign, and its own audit action", async () => {
  const { deps, writes, audits } = spyDeps({
    get: async (_i, id) => makeSession({ id, isActive: false }),
  });
  await setAcademicSessionArchivedForRequest(ADMIN, "year-1", false, deps);
  assert.deepEqual(writes[0].data, { isActive: true });
  assert.equal(audits[0].action, "academic_session.restored");
});

test("archiving an already-archived year is refused rather than silently succeeding", async () => {
  const { deps, audits } = spyDeps({
    get: async (_i, id) => makeSession({ id, name: "2025-26", isActive: false }),
  });
  await assert.rejects(
    () => setAcademicSessionArchivedForRequest(ADMIN, "year-1", true, deps),
    (error: unknown) =>
      error instanceof AcademicSessionError && error.message === "2025-26 is already archived.",
  );
  assert.equal(audits.length, 0);
});

test("restoring a year that was never archived is refused too", async () => {
  const { deps, audits } = spyDeps({
    get: async (_i, id) => makeSession({ id, name: "2026-27", isActive: true }),
  });
  await assert.rejects(
    () => setAcademicSessionArchivedForRequest(ADMIN, "year-1", false, deps),
    (error: unknown) =>
      error instanceof AcademicSessionError && error.message === "2026-27 is not archived.",
  );
  assert.equal(audits.length, 0);
});

test("the audit action is derived from the transition, never chosen by the caller", () => {
  // The function takes a boolean, not an action name, so there is no argument
  // that could make the log say the opposite of what happened. Three required
  // parameters: actor, year id, and the desired state.
  assert.equal(setAcademicSessionArchivedForRequest.length, 3);
});
