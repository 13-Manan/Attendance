import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { hmacHash } from "@/lib/crypto";
import type { ApiKeyContext } from "./types";

/**
 * Key material and presentation. Chosen so a leaked key is *recognisable*:
 * a secret scanner, a code review, or a person pasting into the wrong chat
 * window can all tell what `att_live_…` is, which is the difference between a
 * key that gets revoked in an hour and one that gets revoked never.
 */
const KEY_PREFIX = "att_live_";

/** 32 bytes = 256 bits of entropy. Base64url so it survives a header. */
const KEY_BYTES = 32;

export function hashApiKey(rawKey: string): string {
  return hmacHash(env.API_KEY_PEPPER, rawKey);
}

export interface GeneratedApiKey {
  /** Shown to the admin exactly once. Never stored. */
  rawKey: string;
  /** What goes in `ApiKey.hashedKey`. */
  hashedKey: string;
}

/**
 * Mints a new key.
 *
 * The raw value exists only in the return of this function and in the one
 * response that shows it. There is no "reveal key" screen and there cannot be
 * one — the column holds an HMAC, not the key. An admin who loses it issues a
 * new one and revokes the old, which is the correct operation anyway.
 */
export function generateApiKey(): GeneratedApiKey {
  const rawKey = `${KEY_PREFIX}${randomBytes(KEY_BYTES).toString("base64url")}`;
  return { rawKey, hashedKey: hashApiKey(rawKey) };
}

/**
 * Extracts a bearer credential from a request.
 *
 * Split out from the lookup so the OAuth2 path, when it lands, shares the
 * parsing and differs only in what it does with the token. Returns null for
 * anything that is not `Bearer <something>` — including `Basic`, which this
 * API does not accept, because HTTP Basic puts a reusable credential in a
 * header that proxies log.
 */
export function readBearerToken(request: Request): string | null {
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;
  // Case-insensitive scheme per RFC 7235 §2.1 — `bearer` is as valid as
  // `Bearer`, and rejecting it would produce a 401 an integrator cannot
  // explain.
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Authenticates the public integration API surface (`apps/web/src/app/api/v1/*`).
 *
 * Distinct from Server Action auth (session-based, modules/auth-tenancy) —
 * this is the OAuth2-ready API-key path for third-party integrations. Keys
 * are looked up by HMAC hash (never stored or compared in plaintext), so a
 * wrong key simply fails to match any row rather than needing a constant-time
 * compare against a known secret.
 *
 * ## What this function does and does not decide
 *
 * It answers "which institution and which scopes is this caller", and
 * nothing else. It does **not** check scopes: authentication and
 * authorization are separated so the scope requirement lives next to the
 * endpoint that knows what it needs, rather than being guessed here from a
 * URL. `apiRoute()` in api-route.ts performs the scope check, and it is the
 * only supported way to build a `/api/v1` handler.
 *
 * ## Signature stability
 *
 * `(request) => ApiKeyContext | null` is unchanged from the scaffold that
 * shipped earlier: existing callers keep working. The returned context gained
 * two optional fields and lost none.
 */
export async function authenticateApiKey(request: Request): Promise<ApiKeyContext | null> {
  const rawKey = readBearerToken(request);
  if (!rawKey) return null;

  const hashedKey = hashApiKey(rawKey);
  const apiKey = await prisma.apiKey.findUnique({ where: { hashedKey } });
  if (!apiKey || apiKey.revokedAt) return null;

  // Fire-and-forget: "when was this key last used" is operational metadata,
  // and blocking every API request on a write to record it would make the
  // read path slower than the thing it is measuring. A lost update here costs
  // a slightly stale timestamp on an admin screen.
  void prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {
      // Swallowed deliberately. An unhandled rejection from a metadata write
      // must not take down a request that has already authenticated.
    });

  return {
    apiKeyId: apiKey.id,
    institutionId: apiKey.institutionId,
    scopes: apiKey.scopes,
    name: apiKey.name,
    authMethod: "api_key",
  };
}

/**
 * Re-exported from `@/lib/crypto`, where it lives because webhook signature
 * verification needs it and must not drag this module's `env` and Prisma
 * imports along with it.
 */
export { safeEqual } from "@/lib/crypto";
