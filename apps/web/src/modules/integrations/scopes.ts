/**
 * The scope model for the public integration API.
 *
 * ## Why scopes and not roles
 *
 * A role answers "who is this person"; a scope answers "what may this
 * credential do". An ERP's nightly roster sync and a fee package's attendance
 * read are both "the institution", and giving them the institution admin's
 * role would hand a fee vendor the ability to rewrite a register. Scopes let
 * one institution issue three keys with three different reaches.
 *
 * ## Why `students:write` does NOT imply `students:read`
 *
 * The obvious convenience — write implies read — is declined on purpose. A
 * credential that pushes new enrolments from an SIS has no business
 * downloading the whole student roster, and an implicit grant is exactly the
 * kind of thing nobody re-reads when the key is issued. Least privilege here
 * costs one extra checkbox in the UI and removes a class of silent
 * over-permission. Every grant is explicit and visible on the key.
 *
 * ## Why there is no wildcard
 *
 * "Do not expose unrestricted APIs." A `*` scope is an unrestricted API with
 * a scope-shaped label on it: it silently widens every time a new resource
 * ships, so a key issued today quietly gains access to a resource written
 * next year. Granting all scopes is still possible — by listing them, which
 * is a decision someone made rather than one they inherited.
 *
 * ## OAuth2 readiness
 *
 * These strings are the `scope` values an OAuth2 client-credentials token
 * would carry (RFC 6749 §3.3, space-delimited). Nothing here knows or cares
 * whether the caller proved itself with an API key, a client-credentials
 * token, or a service account: `ApiKeyContext.scopes` is the only input, so
 * adding a second authentication method means producing that same context
 * from a different proof — not touching authorization at all.
 *
 * Pure module: no Prisma, no `Request`, no environment. See scopes.test.ts.
 */

/** Resources the public API exposes, in URL order. */
export const API_RESOURCES = [
  "students",
  "classes",
  "sections",
  "programs",
  "subjects",
  "faculty",
  "enrollments",
  "attendance",
  "reports",
  "institutions",
  "integrations",
] as const;

export type ApiResource = (typeof API_RESOURCES)[number];

export type ScopeAction = "read" | "write";

/**
 * Every scope this API recognises.
 *
 * Read-only by design for most resources. Academic structure (classes,
 * sections, programs, subjects, faculty) is *defined* in this platform or
 * imported through the integration pipeline with a human approving the
 * preview — not silently overwritten by whatever an external system POSTs at
 * 3am. The two write scopes that exist are the two the product needs: an SIS
 * that owns the student roster, and a biometric or timetable system that
 * records attendance.
 */
export const API_SCOPES = [
  "students:read",
  "students:write",
  "classes:read",
  "sections:read",
  "programs:read",
  "subjects:read",
  "faculty:read",
  "enrollments:read",
  "enrollments:write",
  "attendance:read",
  "attendance:write",
  "reports:read",
  "institutions:read",
  "integrations:read",
  "integrations:write",
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

const SCOPE_SET: ReadonlySet<string> = new Set(API_SCOPES);

export function isApiScope(value: unknown): value is ApiScope {
  return typeof value === "string" && SCOPE_SET.has(value);
}

/** Human labels for the key-issuing UI. Keyed by scope so it cannot drift. */
export const SCOPE_DESCRIPTIONS: Record<ApiScope, string> = {
  "students:read": "Read student records (code, name, contact, status)",
  "students:write": "Create and update student records",
  "classes:read": "Read classes (cohorts) and their term labels",
  "sections:read": "Read sections",
  "programs:read": "Read programs, departments, grades and courses",
  "subjects:read": "Read subjects",
  "faculty:read": "Read faculty accounts",
  "enrollments:read": "Read which students belong to which class",
  "enrollments:write": "Enrol and unenrol students",
  "attendance:read": "Read attendance records and sessions",
  "attendance:write": "Submit attendance marks",
  "reports:read": "Read aggregate attendance reports",
  "institutions:read": "Read institution profile and configuration",
  "integrations:read": "Read integration connections and sync status",
  "integrations:write": "Create and modify integration connections",
};

/**
 * The scopes a key must *not* be given casually, surfaced to the UI so the
 * issuing screen can mark them. Write access to attendance is the one that
 * matters: it is the only credential in the system that can change what a
 * register says without a faculty member present.
 */
export const SENSITIVE_SCOPES: ReadonlySet<ApiScope> = new Set([
  "students:write",
  "enrollments:write",
  "attendance:write",
  "integrations:write",
]);

export function scopeFor(resource: ApiResource, action: ScopeAction): ApiScope | null {
  const candidate = `${resource}:${action}`;
  return isApiScope(candidate) ? candidate : null;
}

/**
 * Exact membership. No wildcards, no prefix matching, no implication.
 *
 * Takes `readonly string[]` rather than `ApiScope[]` because the granted list
 * comes out of a database column and may contain a scope this build no longer
 * defines. An unrecognised string simply never matches anything, which is the
 * safe direction: removing a scope from the catalog revokes it everywhere
 * rather than leaving it to match by accident.
 */
export function hasScope(granted: readonly string[], required: ApiScope): boolean {
  return granted.includes(required);
}

/** All of them, not any — an endpoint that reads two resources needs both. */
export function hasAllScopes(granted: readonly string[], required: readonly ApiScope[]): boolean {
  return required.every((scope) => hasScope(granted, scope));
}

/**
 * The scopes that were asked for and not granted.
 *
 * Returned rather than a bare boolean so the 403 body can name them. An
 * integrator whose sync half-works needs to know it was `enrollments:read`
 * that was missing, and the alternative — reading our audit log, which they
 * cannot — is not a debugging story.
 */
export function missingScopes(
  granted: readonly string[],
  required: readonly ApiScope[],
): ApiScope[] {
  return required.filter((scope) => !hasScope(granted, scope));
}

/**
 * Normalises a requested scope list: drops unknown strings, de-duplicates,
 * and returns them in catalog order.
 *
 * Unknown scopes are dropped rather than rejected because this runs when a
 * key is issued, and the alternative is an admin staring at "invalid scope"
 * with no indication which of fifteen checkboxes did it. What the key ends up
 * holding is shown back to them, so a silently dropped scope is visible.
 */
export function normalizeScopes(requested: readonly string[]): ApiScope[] {
  const wanted = new Set(requested.filter(isApiScope));
  return API_SCOPES.filter((scope) => wanted.has(scope));
}

/** Parse an OAuth2 space-delimited scope string (RFC 6749 §3.3). */
export function parseScopeString(value: string): ApiScope[] {
  return normalizeScopes(value.split(/\s+/).filter(Boolean));
}

/** Render back to the OAuth2 wire form. */
export function formatScopeString(scopes: readonly ApiScope[]): string {
  return scopes.join(" ");
}
