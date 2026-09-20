import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWebhook,
  deactivateWebhook,
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  updateWebhook,
  type CredentialDeps,
} from "./service.ts";
import { CredentialError, type ApiKeySummary, type WebhookSummary } from "./types.ts";
import type { RecordAuditLogInput } from "../audit/types.ts";
import { ForbiddenError } from "../authorization/types.ts";
import { isSealed, openSecret } from "../../lib/secret-box.ts";

// Webhook creation seals the signing secret before storing it, and
// `lib/secret-box.ts` fails closed with no key configured — deliberately:
// writing a secret the process cannot read back is worse than refusing. These
// are unit tests with injected deps, so a throwaway key is all they need.
process.env.WEBHOOK_SECRET_KEK ??= Buffer.alloc(32, 7).toString("base64");
import type { SessionUser } from "../auth-tenancy/types.ts";

/**
 * Credential issuing: who may do it, and what must never come back out.
 *
 * The assertions that matter most are negative ones. No audit row may contain
 * key material, no read path may return it, and no institution may revoke
 * another's key. Everything is injected, so none of this needs a database.
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
        permissions: (overrides.permissions ?? [
          "institution.read",
          "institution.update",
        ]) as Permissions,
      },
    ],
  };
}

const READER = makeUser({ permissions: ["institution.read"] });

function key(overrides: Partial<ApiKeySummary> = {}): ApiKeySummary {
  return {
    id: "key-1",
    name: "Fee portal",
    scopes: ["attendance:read"],
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
    isActive: true,
    ...overrides,
  };
}

function hook(overrides: Partial<WebhookSummary> = {}): WebhookSummary {
  return {
    id: "hook-1",
    url: "https://erp.example.edu/hooks/attendance",
    eventTypes: ["attendance.finalized"],
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

interface Harness {
  audited: RecordAuditLogInput[];
  createdKeys: Array<{ institutionId: string; name: string; hashedKey: string; scopes: string[] }>;
  createdHooks: Array<{ institutionId: string; url: string; secret: string; eventTypes: string[] }>;
  revoked: Array<{ institutionId: string; id: string }>;
  updatedHooks: Array<{ institutionId: string; id: string; data: Record<string, unknown> }>;
  deps: CredentialDeps;
}

function harness(
  state: { keys?: ApiKeySummary[]; hooks?: WebhookSummary[] } = {},
): Harness {
  const keys = state.keys ?? [key()];
  const hooks = state.hooks ?? [hook()];
  const h: Harness = {
    audited: [],
    createdKeys: [],
    createdHooks: [],
    revoked: [],
    updatedHooks: [],
    deps: {},
  };
  h.deps = {
    listKeys: async () => keys,
    getKey: async (_institutionId, id) => keys.find((entry) => entry.id === id) ?? null,
    createKey: async (input) => {
      h.createdKeys.push(input);
      return key({ id: "key-new", name: input.name, scopes: input.scopes });
    },
    revokeKey: async (institutionId, id, revokedAt) => {
      h.revoked.push({ institutionId, id });
      const existing = keys.find((entry) => entry.id === id);
      return existing ? { ...existing, revokedAt, isActive: false } : null;
    },
    listHooks: async () => hooks,
    getHook: async (_institutionId, id) => hooks.find((entry) => entry.id === id) ?? null,
    createHook: async (input) => {
      h.createdHooks.push(input);
      return hook({ id: "hook-new", url: input.url, eventTypes: input.eventTypes });
    },
    updateHook: async (institutionId, id, data) => {
      h.updatedHooks.push({ institutionId, id, data });
      const existing = hooks.find((entry) => entry.id === id);
      return existing ? { ...existing, ...data } : null;
    },
    listDeliveries: async () => [],
    audit: async (input) => {
      h.audited.push(input);
    },
    newKey: async () => ({ rawKey: "att_live_PLAINTEXT", hashedKey: "hmac-of-plaintext" }),
    newSecret: () => "whsec_PLAINTEXT",
    now: () => new Date("2026-06-01T12:00:00.000Z"),
  };
  return h;
}

/** Every string anywhere in a value, however deeply nested. */
function flatten(value: unknown): string {
  return JSON.stringify(value ?? null);
}

// ---------------------------------------------------------------------------
// Authorization and tenancy
// ---------------------------------------------------------------------------

test("issuing a key requires institution.update, not merely read access", async () => {
  const h = harness();
  await assert.rejects(
    () => issueApiKey(READER, { name: "Fee portal", scopes: ["attendance:read"] }, h.deps),
    ForbiddenError,
  );
  assert.equal(h.createdKeys.length, 0);
  assert.equal(h.audited.length, 0);
});

test("a reader may still list the keys", async () => {
  const h = harness();
  const keys = await listApiKeys(READER, h.deps);
  assert.equal(keys.length, 1);
});

test("an account with no institution cannot issue credentials", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      issueApiKey(
        makeUser({ institutionId: null }),
        { name: "Fee portal", scopes: ["attendance:read"] },
        h.deps,
      ),
    CredentialError,
  );
});

test("revocation is scoped to the session's institution", async () => {
  const h = harness();
  await revokeApiKey(makeUser(), "key-1", h.deps);
  assert.deepEqual(h.revoked, [{ institutionId: "inst-1", id: "key-1" }]);
});

test("a key belonging to nobody in this institution cannot be revoked", async () => {
  const h = harness();
  await assert.rejects(() => revokeApiKey(makeUser(), "key-elsewhere", h.deps), CredentialError);
  assert.equal(h.revoked.length, 0);
});

test("revoking an already revoked key is refused rather than silently repeated", async () => {
  const h = harness({
    keys: [key({ revokedAt: new Date("2026-05-01T00:00:00.000Z"), isActive: false })],
  });
  await assert.rejects(() => revokeApiKey(makeUser(), "key-1", h.deps), CredentialError);
  assert.equal(h.audited.length, 0);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test("a key with no recognised scope is refused before anything is written", async () => {
  const h = harness();
  await assert.rejects(
    () => issueApiKey(makeUser(), { name: "Fee portal", scopes: ["everything:*"] }, h.deps),
    CredentialError,
  );
  assert.equal(h.createdKeys.length, 0);
});

test("an unnamed key is refused", async () => {
  const h = harness();
  await assert.rejects(
    () => issueApiKey(makeUser(), { name: "   ", scopes: ["attendance:read"] }, h.deps),
    CredentialError,
  );
});

test("unknown scopes are dropped and the known ones kept", async () => {
  const h = harness();
  const issued = await issueApiKey(
    makeUser(),
    { name: "Fee portal", scopes: ["attendance:read", "nonsense:read", "attendance:read"] },
    h.deps,
  );
  assert.deepEqual(issued.key.scopes, ["attendance:read"]);
});

test("a webhook pointed at the cloud metadata service is refused", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      createWebhook(
        makeUser(),
        { url: "http://169.254.169.254/latest/meta-data/", eventTypes: ["attendance.finalized"] },
        h.deps,
      ),
    CredentialError,
  );
  assert.equal(h.createdHooks.length, 0, "nothing was stored");
});

test("a webhook subscribed to an event this system does not send is refused, not trimmed", async () => {
  const h = harness();
  await assert.rejects(
    () =>
      createWebhook(
        makeUser(),
        { url: "https://erp.example.edu/hook", eventTypes: ["attendance.invented"] },
        h.deps,
      ),
    CredentialError,
  );
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

test("the plaintext key is returned once and never reaches the audit log", async () => {
  const h = harness();
  const issued = await issueApiKey(
    makeUser(),
    { name: "Fee portal", scopes: ["attendance:read"] },
    h.deps,
  );

  assert.equal(issued.secret, "att_live_PLAINTEXT");
  assert.equal(h.createdKeys[0].hashedKey, "hmac-of-plaintext", "only the hash is stored");
  assert.equal(
    flatten(h.createdKeys[0]).includes("att_live_PLAINTEXT"),
    false,
    "the plaintext key is not written to the database",
  );

  const row = h.audited[0];
  assert.equal(row.action, "api_key.created");
  assert.equal(flatten(row).includes("att_live_PLAINTEXT"), false);
  assert.equal(flatten(row).includes("hmac-of-plaintext"), false, "not even the hash is audited");
  assert.deepEqual(row.afterJson, { name: "Fee portal", scopes: ["attendance:read"] });
});

test("the webhook signing secret is returned once and never audited", async () => {
  const h = harness();
  const created = await createWebhook(
    makeUser(),
    { url: "https://erp.example.edu/hook", eventTypes: ["attendance.finalized"] },
    h.deps,
  );

  // Shown once to the administrator, in plaintext — the receiver needs the
  // real value to verify signatures.
  assert.equal(created.secret, "whsec_PLAINTEXT");

  // Phase 11: what is *stored* is sealed, not the plaintext. The dispatcher
  // opens it when it signs; nothing else ever needs it.
  const stored = h.createdHooks[0].secret;
  assert.equal(isSealed(stored), true, "the column holds ciphertext");
  assert.equal(stored.includes("whsec_PLAINTEXT"), false, "and not the secret itself");
  assert.equal(openSecret(stored), "whsec_PLAINTEXT", "which opens back to what was shown");

  // Unchanged and still the point: neither form reaches the audit trail.
  assert.equal(flatten(h.audited[0]).includes("whsec_PLAINTEXT"), false);
  assert.equal(flatten(h.audited[0]).includes(stored), false);
});

test("no read path returns key material", async () => {
  const h = harness();
  const keys = await listApiKeys(makeUser(), h.deps);
  assert.equal(Object.hasOwn(keys[0], "hashedKey"), false);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test("revoking a key records what it could do before it was stopped", async () => {
  const h = harness({ keys: [key({ scopes: ["attendance:write", "students:read"] })] });
  await revokeApiKey(makeUser(), "key-1", h.deps);

  const row = h.audited[0];
  assert.equal(row.action, "api_key.revoked");
  assert.equal(row.actorUserId, "user-admin");
  assert.deepEqual(row.beforeJson, {
    name: "Fee portal",
    scopes: ["attendance:write", "students:read"],
    isActive: true,
  });
  assert.equal((row.afterJson as { isActive: boolean }).isActive, false);
});

test("stopping an endpoint keeps the row and audits the change", async () => {
  const h = harness();
  const stopped = await deactivateWebhook(makeUser(), "hook-1", h.deps);
  assert.equal(stopped.isActive, false);
  assert.deepEqual(h.updatedHooks[0].data, { isActive: false });
  assert.equal(h.audited[0].action, "webhook_endpoint.deleted");
});

test("an endpoint update audits both the old and the new subscription", async () => {
  const h = harness();
  await updateWebhook(
    makeUser(),
    "hook-1",
    {
      url: "https://erp.example.edu/hooks/v2",
      eventTypes: ["attendance.finalized", "attendance.corrected"],
      isActive: true,
    },
    h.deps,
  );
  const row = h.audited[0];
  assert.equal(row.action, "webhook_endpoint.updated");
  assert.deepEqual(row.beforeJson, {
    url: "https://erp.example.edu/hooks/attendance",
    eventTypes: ["attendance.finalized"],
    isActive: true,
  });
  assert.deepEqual(row.afterJson, {
    url: "https://erp.example.edu/hooks/v2",
    eventTypes: ["attendance.finalized", "attendance.corrected"],
    isActive: true,
  });
});
