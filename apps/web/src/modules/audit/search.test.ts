import { test } from "node:test";
import assert from "node:assert/strict";
import { AuditSearchError, searchAuditLogs, type AuditSearchDeps } from "./search.ts";
import type { AuditLogRow } from "./repository.ts";
import { ForbiddenError } from "../authorization/types.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * The audit search as a service: who may read it, whose rows they get, and
 * what is allowed to reach the screen.
 *
 * `query.test.ts` proves the filters mean what they say. This file proves the
 * three things around them that would make the screen a leak rather than a
 * control.
 */

type Permissions = SessionUser["roles"][number]["permissions"];

function makeUser(
  overrides: { permissions?: string[]; institutionId?: string | null } = {},
): SessionUser {
  return {
    userId: "user-admin",
    email: "admin@example.edu",
    name: "Admin",
    institutionId: overrides.institutionId === undefined ? "inst-1" : overrides.institutionId,
    campusId: null,
    roles: [
      {
        key: "INSTITUTION_ADMIN",
        name: "Institution Admin",
        institutionId: "inst-1",
        campusId: null,
        permissions: (overrides.permissions ?? ["auditLog.read"]) as Permissions,
      },
    ],
  };
}

function row(overrides: Partial<AuditLogRow> = {}): AuditLogRow {
  return {
    id: "log-1",
    institutionId: "inst-1",
    actorUserId: "user-admin",
    actorApiKeyId: null,
    action: "attendance.finalized",
    entityType: "AttendanceSession",
    entityId: "sess-1",
    beforeJson: null,
    afterJson: null,
    ipAddress: "10.0.0.1",
    userAgent: "test",
    createdAt: new Date("2026-06-01T09:00:00.000Z"),
    ...overrides,
  };
}

interface Harness {
  wheres: unknown[];
  deps: AuditSearchDeps;
}

function harness(rows: AuditLogRow[] = [row()]): Harness {
  const wheres: unknown[] = [];
  return {
    wheres,
    deps: {
      count: async (where) => {
        wheres.push(where);
        return rows.length;
      },
      list: async (where) => {
        wheres.push(where);
        return rows;
      },
      listActors: async () => [
        { id: "user-admin", name: "Admin", email: "admin@example.edu" },
      ],
      listEntityTypes: async () => [{ entityType: "AttendanceSession", count: 1 }],
    },
  };
}

test("reading the audit log requires auditLog.read", async () => {
  const h = harness();
  await assert.rejects(
    () => searchAuditLogs(makeUser({ permissions: ["institution.read"] }), {}, h.deps),
    ForbiddenError,
  );
  assert.equal(h.wheres.length, 0, "no query ran");
});

test("an account with no institution is refused rather than shown everything", async () => {
  const h = harness();
  await assert.rejects(
    () => searchAuditLogs(makeUser({ institutionId: null }), {}, h.deps),
    AuditSearchError,
  );
  assert.equal(h.wheres.length, 0);
});

test("every query is scoped to the session's institution, whatever the query string says", async () => {
  const h = harness();
  await searchAuditLogs(makeUser(), { institutionId: "inst-2" }, h.deps);
  assert.ok(h.wheres.length > 0);
  for (const where of h.wheres) {
    assert.equal((where as { institutionId: string }).institutionId, "inst-1");
  }
});

test("a secret written into an audit payload does not reach the screen", async () => {
  const h = harness([
    row({
      action: "webhook_endpoint.created",
      entityType: "WebhookEndpoint",
      afterJson: { url: "https://example.edu/hook", secret: "whsec_live_1234", eventTypes: ["a"] },
    }),
  ]);
  const result = await searchAuditLogs(makeUser(), {}, h.deps);
  const after = result.entries[0].after as Record<string, unknown>;
  assert.equal(after.url, "https://example.edu/hook");
  assert.notEqual(after.secret, "whsec_live_1234");
  assert.match(String(after.secret), /redacted/);
});

test("an embedding written into an audit payload does not reach the screen", async () => {
  const h = harness([
    row({
      action: "face_enrollment.created",
      entityType: "FaceEmbedding",
      afterJson: { studentId: "stu-1", embedding: Array.from({ length: 128 }, () => 0.01) },
    }),
  ]);
  const result = await searchAuditLogs(makeUser(), {}, h.deps);
  const after = result.entries[0].after as Record<string, unknown>;
  assert.equal(after.studentId, "stu-1");
  assert.equal(Array.isArray(after.embedding), false, "no vector reaches the browser");
});

test("an actor is named when known, shown as an id when not, and never invented", async () => {
  const h = harness([
    row({ id: "a", actorUserId: "user-admin" }),
    row({ id: "b", actorUserId: "user-deleted" }),
    row({ id: "c", actorUserId: null, actorApiKeyId: "key-1" }),
    row({ id: "d", actorUserId: null, actorApiKeyId: null }),
  ]);
  const result = await searchAuditLogs(makeUser(), {}, h.deps);
  const labels = result.entries.map((entry) => `${entry.actor.kind}:${entry.actor.label}`);
  assert.deepEqual(labels, [
    "USER:Admin (admin@example.edu)",
    "USER:user-deleted",
    "API_KEY:API key key-1",
    "SYSTEM:System",
  ]);
});

test("an action this build does not know still appears, labelled Other", async () => {
  const h = harness([row({ action: "something.invented" })]);
  const result = await searchAuditLogs(makeUser(), {}, h.deps);
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].moduleKey, null);
  assert.equal(result.entries[0].moduleLabel, "Other");
});

test("the returned page number is the clamped one, not the one that was asked for", async () => {
  const h = harness([row()]);
  const result = await searchAuditLogs(makeUser(), { page: "40" }, h.deps);
  assert.equal(result.page, 1);
  assert.equal(result.filters.page, 1);
  assert.equal(result.totalPages, 1);
});
