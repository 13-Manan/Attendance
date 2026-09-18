import { prisma } from "@/lib/prisma";
import type { ApiKeySummary, WebhookSummary } from "./types";

/**
 * Reads and writes over `ApiKey` and `WebhookEndpoint`.
 *
 * ## What is deliberately not selectable here
 *
 * `ApiKey.hashedKey` and `WebhookEndpoint.secret`. Neither appears in any
 * select in this file, so no caller in this module — present or future — can
 * accidentally pass one to a page, a log line or an audit row. The key
 * material's only journey is: generated in memory, written once, shown once.
 *
 * Every function is institution-scoped, and the id always appears in the
 * `where` alongside the row id on updates. `updateMany` with both is used
 * rather than `update` by id: a `update({ where: { id } })` would happily
 * revoke another institution's key if an id ever leaked into a form.
 */

const API_KEY_SELECT = {
  id: true,
  name: true,
  scopes: true,
  createdAt: true,
  lastUsedAt: true,
  revokedAt: true,
} as const;

function toSummary(row: {
  id: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}): ApiKeySummary {
  return { ...row, isActive: row.revokedAt === null };
}

export async function listApiKeys(institutionId: string): Promise<ApiKeySummary[]> {
  const rows = await prisma.apiKey.findMany({
    where: { institutionId },
    select: API_KEY_SELECT,
    // Active keys first, then newest — the list is a working set, and a
    // revoked key from last year should not sit above the one in use today.
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    take: 200,
  });
  return rows.map(toSummary);
}

export async function getApiKey(
  institutionId: string,
  id: string,
): Promise<ApiKeySummary | null> {
  const row = await prisma.apiKey.findFirst({
    where: { id, institutionId },
    select: API_KEY_SELECT,
  });
  return row ? toSummary(row) : null;
}

export async function createApiKeyRow(input: {
  institutionId: string;
  name: string;
  hashedKey: string;
  scopes: string[];
}): Promise<ApiKeySummary> {
  const row = await prisma.apiKey.create({
    data: {
      institutionId: input.institutionId,
      name: input.name,
      hashedKey: input.hashedKey,
      scopes: input.scopes,
    },
    select: API_KEY_SELECT,
  });
  return toSummary(row);
}

/**
 * Revokes rather than deletes.
 *
 * A deleted key takes its history with it: the audit rows written by requests
 * that used it would point at an id nothing explains, and "which key read the
 * roster on the 3rd" would stop being answerable. `revokedAt` stops the key
 * working — `authenticateApiKey` checks it — and keeps the record.
 */
export async function revokeApiKeyRow(
  institutionId: string,
  id: string,
  revokedAt: Date,
): Promise<ApiKeySummary | null> {
  const result = await prisma.apiKey.updateMany({
    where: { id, institutionId, revokedAt: null },
    data: { revokedAt },
  });
  if (result.count === 0) return null;
  return getApiKey(institutionId, id);
}

// ---------------------------------------------------------------------------
// Webhook endpoints
// ---------------------------------------------------------------------------

const WEBHOOK_SELECT = {
  id: true,
  url: true,
  eventTypes: true,
  isActive: true,
  createdAt: true,
} as const;

export function listWebhooks(institutionId: string): Promise<WebhookSummary[]> {
  return prisma.webhookEndpoint.findMany({
    where: { institutionId },
    select: WEBHOOK_SELECT,
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    take: 200,
  });
}

export function getWebhook(institutionId: string, id: string): Promise<WebhookSummary | null> {
  return prisma.webhookEndpoint.findFirst({
    where: { id, institutionId },
    select: WEBHOOK_SELECT,
  });
}

export function createWebhookRow(input: {
  institutionId: string;
  url: string;
  secret: string;
  eventTypes: string[];
}): Promise<WebhookSummary> {
  return prisma.webhookEndpoint.create({
    data: {
      institutionId: input.institutionId,
      url: input.url,
      secret: input.secret,
      eventTypes: input.eventTypes,
    },
    select: WEBHOOK_SELECT,
  });
}

export async function updateWebhookRow(
  institutionId: string,
  id: string,
  data: { url?: string; eventTypes?: string[]; isActive?: boolean },
): Promise<WebhookSummary | null> {
  const result = await prisma.webhookEndpoint.updateMany({
    where: { id, institutionId },
    data: {
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.eventTypes !== undefined ? { eventTypes: data.eventTypes } : {}),
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });
  if (result.count === 0) return null;
  return getWebhook(institutionId, id);
}

/**
 * Recent delivery attempts for an institution's endpoints.
 *
 * There is no `WebhookDelivery` table and the schema is frozen, so the
 * delivery history lives in `AuditLog` — one row per attempt, written by
 * `webhook-dispatcher.ts`. Reading it back here is what makes the "view
 * errors" requirement answerable from the same screen that configures the
 * endpoint, rather than from a log file an administrator cannot reach.
 */
export async function listRecentDeliveries(
  institutionId: string,
  limit = 20,
): Promise<
  Array<{
    id: string;
    createdAt: Date;
    action: string;
    entityId: string;
    payload: unknown;
  }>
> {
  const rows = await prisma.auditLog.findMany({
    where: {
      institutionId,
      action: { in: ["webhook.delivery.succeeded", "webhook.delivery.failed"] },
    },
    select: { id: true, createdAt: true, action: true, entityId: true, afterJson: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
  });
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt,
    action: row.action,
    entityId: row.entityId,
    payload: row.afterJson,
  }));
}
