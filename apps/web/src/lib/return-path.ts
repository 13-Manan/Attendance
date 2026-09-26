// "Back to where you came from", as a query parameter a page can trust.
//
// A record page reached from a list can offer the way back to that list —
// "← Back to Class 8 · Section A" rather than the generic "← Back to
// Students". The list says where it is by adding `?returnTo=<its own path>`
// to the links it renders. That value arrives in a URL, so it is a claim, not
// a destination: anyone can send a link with `returnTo=https://evil.example`.
//
// So a return path is accepted only if it is exactly one of the pages the
// reading page expects to be returned to (`allowed`, as route patterns), and
// it is never followed as given: the caller rebuilds it from the matched
// pattern and ids, keeps only the query keys it understands, and names the
// destination by loading it through the same service — and the same checks
// — as the page itself. Anything else falls back to the page's own parent.
//
// Pure, like `safeNextPath`, whose refusals it starts from.

import { safeNextPath } from "@/modules/auth-tenancy/redirect";

/** The query parameter a list adds to the links it renders. */
export const RETURN_PARAM = "returnTo";

/** Longer than any path this app builds, short enough to refuse a pasted essay. */
const MAX_LENGTH = 512;

/**
 * One path segment as this app writes them: a record id or a word. Refuses
 * "." and "..", percent-escapes (an encoded "/" is a second segment in
 * disguise) and anything else a path we generated would never contain.
 */
const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

export interface ReturnPath {
  /** The allowed pattern it matched, e.g. `/dashboard/students/classes/[classId]/sections/[sectionId]`. */
  pattern: string;
  /** The ids from the path, keyed by the pattern's parameter names. */
  params: Record<string, string>;
  /** Its query string, for the caller to keep what it understands of. */
  query: URLSearchParams;
}

/**
 * A return path that is exactly one of `allowed`, or null.
 *
 * Never throws; anything unexpected is simply not a return path.
 */
export function parseReturnPath(value: unknown, allowed: readonly string[]): ReturnPath | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return null;

  // An absolute same-origin path and nothing else: no scheme, no host, no
  // "//", no backslash, no control characters or whitespace. `safeNextPath`
  // hands back its default for anything it refuses, so equality means passed.
  if (safeNextPath(value) !== value) return null;
  if (value.includes("#")) return null;

  const queryStart = value.indexOf("?");
  const path = queryStart === -1 ? value : value.slice(0, queryStart);
  const query = queryStart === -1 ? "" : value.slice(queryStart + 1);

  const parts = path.split("/").slice(1);
  if (parts.length === 0 || !parts.every((part) => SEGMENT.test(part))) return null;

  for (const pattern of allowed) {
    const expected = pattern.split("/").slice(1);
    if (expected.length !== parts.length) continue;

    const params: Record<string, string> = {};
    const matches = expected.every((segment, index) => {
      if (segment.startsWith("[") && segment.endsWith("]")) {
        params[segment.slice(1, -1)] = parts[index];
        return true;
      }
      return segment === parts[index];
    });
    if (matches) return { pattern, params, query: new URLSearchParams(query) };
  }
  return null;
}

/** A link to `href` that tells the page it opens where to come back to. */
export function withReturnPath(href: string, returnPath: string | null | undefined): string {
  if (!returnPath) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}${RETURN_PARAM}=${encodeURIComponent(returnPath)}`;
}
