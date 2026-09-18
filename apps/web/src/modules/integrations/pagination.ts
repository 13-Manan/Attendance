import { invalidRequest } from "./api-route";
import type { ApiListResponse } from "./types";

/**
 * Pagination for the public API.
 *
 * ## Cursor, not offset
 *
 * `?page=47` re-scans 47 pages of rows on every request and, worse, silently
 * skips or repeats records when the underlying table changes mid-walk — which
 * it does, because attendance is being written while an ERP reads it. A
 * keyset cursor reads the same total number of rows once, and an insert
 * during the walk cannot shift the page boundary under the client.
 *
 * ## The cursor is opaque on purpose
 *
 * It is base64url over a row id, which any integrator will decode within an
 * hour. That is fine — the encoding is not a secret, it is a *contract
 * signal*. A raw id in the response invites clients to construct cursors
 * themselves and depend on `cursor === id`, which pins us to id-ordered
 * paging forever. An opaque string can grow a compound keyset later without
 * a breaking change.
 *
 * Pure module. See pagination.test.ts.
 */

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export interface PageRequest {
  /** How many rows the caller wants. Already clamped. */
  limit: number;
  /** Row id to resume after, or null for the first page. */
  cursorId: string | null;
}

/**
 * Reads `?limit=` and `?cursor=`.
 *
 * A limit that is absent, empty, or non-numeric falls back to the default —
 * an integrator's `?limit=` with a templating bug should return a first page,
 * not a 400 that stalls their nightly sync at 2am. A limit that is a *valid
 * number out of range* is clamped rather than rejected, for the same reason,
 * and the effective value is echoed in `pagination.limit` so the client can
 * see what it actually got.
 *
 * A malformed **cursor** is different and does throw: silently treating it as
 * "start from the beginning" would restart a sync from row one without
 * telling anybody, and the client would report success having re-imported the
 * whole roster.
 */
export function readPageRequest(url: URL): PageRequest {
  const rawLimit = url.searchParams.get("limit");
  const parsed = rawLimit === null || rawLimit.trim() === "" ? NaN : Number(rawLimit);
  const limit = Number.isFinite(parsed)
    ? Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(parsed)))
    : DEFAULT_PAGE_SIZE;

  const rawCursor = url.searchParams.get("cursor");
  return { limit, cursorId: rawCursor ? decodeCursor(rawCursor) : null };
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): string {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw invalidRequest("`cursor` is not a valid pagination cursor.");
  }
  // Node's base64url decoder does not reject garbage — it discards what it
  // cannot read and returns whatever is left, so "is it decodable" proves
  // nothing. The real check is that the result looks like an id we issued.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(decoded)) {
    throw invalidRequest("`cursor` is not a valid pagination cursor.");
  }
  return decoded;
}

/**
 * Turns `limit + 1` rows into a page and its cursor.
 *
 * Callers fetch one row more than they need; that extra row is the whole
 * answer to "is there a next page", and it costs one row rather than a second
 * `COUNT(*)` over the same predicate. The extra row is dropped, never
 * returned.
 */
export function buildPage<T extends { id: string }>(
  rows: T[],
  request: PageRequest,
  requestId: string,
): ApiListResponse<T> {
  const hasMore = rows.length > request.limit;
  const data = hasMore ? rows.slice(0, request.limit) : rows;
  const last = data.at(-1);
  return {
    data,
    pagination: {
      limit: request.limit,
      nextCursor: hasMore && last ? encodeCursor(last.id) : null,
      hasMore,
    },
    requestId,
  };
}

/**
 * The `take`/`cursor`/`skip` triple for Prisma.
 *
 * `skip: 1` is what makes the cursor *exclusive* — without it the row the
 * cursor names is returned again at the head of every page, and a client
 * importing 10,000 students would import 10,000 duplicates of every page
 * boundary. Kept here rather than repeated in twelve repository functions.
 */
export function prismaPageArgs(request: PageRequest): {
  take: number;
  cursor?: { id: string };
  skip?: number;
} {
  const take = request.limit + 1;
  if (!request.cursorId) return { take };
  return { take, cursor: { id: request.cursorId }, skip: 1 };
}
