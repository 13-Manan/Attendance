import { recordAuditLog as defaultRecordAuditLog } from "@/modules/audit/service";
import { sealSecret } from "@/lib/secret-box";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import { requirePermission } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { generateSigningSecret } from "@/modules/integrations/webhook-signature";
import * as repo from "./repository";
import {
  validateCredentialName,
  validateEventTypes,
  validateScopes,
  validateWebhookUrl,
} from "./policy";
import {
  CredentialError,
  ONE_TIME_NOTICE,
  type ApiKeySummary,
  type IssuedSecret,
  type WebhookSummary,
} from "./types";

/**
 * Issuing and revoking the credentials other systems use.
 *
 * ## Permissions
 *
 * `institution.read` to see the list, `institution.update` to issue or revoke
 * — the same pair the Integration Center already uses for connections, and for
 * the same reason given at length in `modules/integrations/center-service.ts`:
 * a new permission key would exist in code but in nobody's seeded database, so
 * it would lock every administrator out of the screen it was meant to govern.
 *
 * The tenant comes from the session. No function here takes an institution id.
 *
 * ## The one-time reveal
 *
 * `issueApiKey` and `createWebhook` are the only functions in this codebase
 * that return plaintext key material to a browser, and they do it exactly
 * once, in the return value of the call that created it. The value is not
 * stored, not audited, not logged, and cannot be read back: `ApiKey.hashedKey`
 * is an HMAC and `WebhookEndpoint.secret` is never selected by this module's
 * repository. This is not an inconvenience that a future "reveal" button could
 * fix — it is the property that makes a leaked database less than a breach of
 * every institution's integrations.
 *
 * ## What the audit rows contain
 *
 * Name, scopes, URL, events, and who did it. Never the secret, never the hash.
 * A person reading the audit log can see that a key with `attendance:write`
 * was issued on the 3rd and by whom, which is the question that matters, and
 * cannot use the log to authenticate as it.
 */

export interface CredentialDeps {
  listKeys?: (institutionId: string) => Promise<ApiKeySummary[]>;
  getKey?: (institutionId: string, id: string) => Promise<ApiKeySummary | null>;
  createKey?: (input: {
    institutionId: string;
    name: string;
    hashedKey: string;
    scopes: string[];
  }) => Promise<ApiKeySummary>;
  revokeKey?: (
    institutionId: string,
    id: string,
    revokedAt: Date,
  ) => Promise<ApiKeySummary | null>;
  listHooks?: (institutionId: string) => Promise<WebhookSummary[]>;
  getHook?: (institutionId: string, id: string) => Promise<WebhookSummary | null>;
  createHook?: (input: {
    institutionId: string;
    url: string;
    secret: string;
    eventTypes: string[];
  }) => Promise<WebhookSummary>;
  updateHook?: (
    institutionId: string,
    id: string,
    data: { url?: string; eventTypes?: string[]; isActive?: boolean },
  ) => Promise<WebhookSummary | null>;
  listDeliveries?: (
    institutionId: string,
    limit?: number,
  ) => Promise<Array<{ id: string; createdAt: Date; action: string; entityId: string; payload: unknown }>>;
  audit?: (input: RecordAuditLogInput) => Promise<void>;
  newKey?: () => Promise<{ rawKey: string; hashedKey: string }>;
  newSecret?: () => string;
  now?: () => Date;
}

/**
 * Key generation is imported lazily, for the reason spelled out in
 * `modules/integrations/api-route.ts`: `api-key-auth` reads `API_KEY_PEPPER`
 * and validates the whole environment at module load. A static import would
 * make merely importing this service — including from a unit test with every
 * dependency injected — require a populated `.env`.
 */
async function defaultNewKey(): Promise<{ rawKey: string; hashedKey: string }> {
  const { generateApiKey } = await import("@/modules/integrations/api-key-auth");
  return generateApiKey();
}

function deps(overrides: CredentialDeps) {
  return {
    listKeys: overrides.listKeys ?? repo.listApiKeys,
    getKey: overrides.getKey ?? repo.getApiKey,
    createKey: overrides.createKey ?? repo.createApiKeyRow,
    revokeKey: overrides.revokeKey ?? repo.revokeApiKeyRow,
    listHooks: overrides.listHooks ?? repo.listWebhooks,
    getHook: overrides.getHook ?? repo.getWebhook,
    createHook: overrides.createHook ?? repo.createWebhookRow,
    updateHook: overrides.updateHook ?? repo.updateWebhookRow,
    listDeliveries: overrides.listDeliveries ?? repo.listRecentDeliveries,
    audit: overrides.audit ?? ((input: RecordAuditLogInput) => defaultRecordAuditLog(input)),
    newKey: overrides.newKey ?? defaultNewKey,
    newSecret: overrides.newSecret ?? generateSigningSecret,
    now: overrides.now ?? (() => new Date()),
  };
}

function requireInstitution(
  actor: SessionUser,
  permission: "institution.read" | "institution.update",
): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    throw new CredentialError(
      "This account is not scoped to a single institution, so it cannot manage integration credentials.",
    );
  }
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

export function listApiKeys(
  actor: SessionUser,
  overrides: CredentialDeps = {},
): Promise<ApiKeySummary[]> {
  const d = deps(overrides);
  return d.listKeys(requireInstitution(actor, "institution.read"));
}

export interface IssuedApiKey extends IssuedSecret {
  key: ApiKeySummary;
}

export async function issueApiKey(
  actor: SessionUser,
  input: { name: string; scopes: readonly string[] },
  overrides: CredentialDeps = {},
): Promise<IssuedApiKey> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");

  const name = validateCredentialName(input.name);
  const scopes = validateScopes(input.scopes);

  const { rawKey, hashedKey } = await d.newKey();
  const key = await d.createKey({ institutionId, name, hashedKey, scopes });

  await d.audit({
    action: "api_key.created",
    entityType: "ApiKey",
    entityId: key.id,
    institutionId,
    actorUserId: actor.userId,
    // Scopes, not key material. What a reader of this log needs is what the
    // key may do, which is exactly what is here.
    afterJson: { name: key.name, scopes: key.scopes },
  });

  return { key, secret: rawKey, notice: ONE_TIME_NOTICE };
}

export async function revokeApiKey(
  actor: SessionUser,
  id: string,
  overrides: CredentialDeps = {},
): Promise<ApiKeySummary> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");

  const before = await d.getKey(institutionId, id);
  if (!before) throw new CredentialError("That key does not belong to this institution.");
  if (!before.isActive) throw new CredentialError("That key is already revoked.");

  const revoked = await d.revokeKey(institutionId, id, d.now());
  if (!revoked) throw new CredentialError("That key is already revoked.");

  await d.audit({
    action: "api_key.revoked",
    entityType: "ApiKey",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { name: before.name, scopes: before.scopes, isActive: true },
    afterJson: { name: revoked.name, scopes: revoked.scopes, isActive: false },
  });

  return revoked;
}

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------

export function listWebhooks(
  actor: SessionUser,
  overrides: CredentialDeps = {},
): Promise<WebhookSummary[]> {
  const d = deps(overrides);
  return d.listHooks(requireInstitution(actor, "institution.read"));
}

/**
 * Recent delivery attempts, newest first — the "view errors" surface.
 *
 * Read from the audit log because there is no delivery table and the schema is
 * frozen. Every attempt already writes one row, so this is a read of something
 * that was being recorded anyway rather than a new stream of data.
 */
export function listWebhookDeliveries(
  actor: SessionUser,
  limit = 20,
  overrides: CredentialDeps = {},
) {
  const d = deps(overrides);
  return d.listDeliveries(requireInstitution(actor, "institution.read"), limit);
}

export interface CreatedWebhook extends IssuedSecret {
  endpoint: WebhookSummary;
}

export async function createWebhook(
  actor: SessionUser,
  input: { url: string; eventTypes: readonly string[] },
  overrides: CredentialDeps = {},
): Promise<CreatedWebhook> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");

  const url = validateWebhookUrl(input.url);
  const eventTypes = validateEventTypes(input.eventTypes);

  const secret = d.newSecret();
  // Encrypted before it touches the database. The plaintext exists only in
  // this function and in the one response that shows it to the administrator;
  // what persists is an AES-256-GCM sealed value that the dispatcher opens
  // when it needs to sign. See `lib/secret-box.ts`.
  const endpoint = await d.createHook({
    institutionId,
    url,
    secret: sealSecret(secret),
    eventTypes,
  });

  await d.audit({
    action: "webhook_endpoint.created",
    entityType: "WebhookEndpoint",
    entityId: endpoint.id,
    institutionId,
    actorUserId: actor.userId,
    afterJson: { url: endpoint.url, eventTypes: endpoint.eventTypes, isActive: endpoint.isActive },
  });

  return { endpoint, secret, notice: ONE_TIME_NOTICE };
}

export async function updateWebhook(
  actor: SessionUser,
  id: string,
  input: { url: string; eventTypes: readonly string[]; isActive: boolean },
  overrides: CredentialDeps = {},
): Promise<WebhookSummary> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");

  const before = await d.getHook(institutionId, id);
  if (!before) throw new CredentialError("That endpoint does not belong to this institution.");

  const url = validateWebhookUrl(input.url);
  const eventTypes = validateEventTypes(input.eventTypes);

  const updated = await d.updateHook(institutionId, id, {
    url,
    eventTypes,
    isActive: input.isActive,
  });
  if (!updated) throw new CredentialError("That endpoint does not belong to this institution.");

  await d.audit({
    action: "webhook_endpoint.updated",
    entityType: "WebhookEndpoint",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { url: before.url, eventTypes: before.eventTypes, isActive: before.isActive },
    afterJson: { url: updated.url, eventTypes: updated.eventTypes, isActive: updated.isActive },
  });

  return updated;
}

/**
 * Stops delivery without erasing the endpoint.
 *
 * Same reasoning as the public API's delete: the audit rows recording every
 * past attempt reference this id, and deleting the row would leave "why did
 * our ERP stop receiving events on the 3rd?" unanswerable. The signing secret
 * is not rotated here — a deactivated endpoint receives nothing, and rotating
 * it would break a reactivation that an administrator may well intend.
 */
export async function deactivateWebhook(
  actor: SessionUser,
  id: string,
  overrides: CredentialDeps = {},
): Promise<WebhookSummary> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");

  const before = await d.getHook(institutionId, id);
  if (!before) throw new CredentialError("That endpoint does not belong to this institution.");
  if (!before.isActive) throw new CredentialError("That endpoint is already stopped.");

  const updated = await d.updateHook(institutionId, id, { isActive: false });
  if (!updated) throw new CredentialError("That endpoint does not belong to this institution.");

  await d.audit({
    action: "webhook_endpoint.deleted",
    entityType: "WebhookEndpoint",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { url: before.url, eventTypes: before.eventTypes, isActive: true },
    afterJson: { url: updated.url, eventTypes: updated.eventTypes, isActive: false },
  });

  return updated;
}
