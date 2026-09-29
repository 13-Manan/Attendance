import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { hasPermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import { getSessionUserByRawToken } from "./service";
import { loginPathFor, PASSWORD_CHANGE_PATH, REQUESTED_PATH_HEADER } from "./redirect";
import type { SessionUser } from "./types";

export const SESSION_COOKIE_NAME = "attendance_session";
export const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days, matches Session.expiresAt

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
};

/** Whoever this browser's session cookie resolves to, whatever the session may be used for. */
async function sessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;
  return getSessionUserByRawToken(rawToken);
}

/**
 * The real identity check. Resolves the cookie -> Session row -> User ->
 * roles/permissions, rejecting on a missing/expired/revoked session or an
 * inactive account. This — not proxy.ts — is the actual security boundary;
 * see ARCHITECTURE.md's "server-side enforcement" section.
 *
 * Null, too, for a session whose password somebody else issued and whose
 * holder has not replaced it yet: until they do, it is not a way into
 * anything, so a Route Handler calling this answers it with the same 401 as
 * a session it cannot use at all.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const user = await sessionUser();
  return user?.mustChangePassword ? null : user;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await sessionUser();
  // A password somebody else issued is replaced before anything else is
  // reached. Here rather than in the proxy or a layout because every page
  // and every Server Action comes through here — including an action posted
  // to a path the proxy never sees.
  if (user?.mustChangePassword) redirect(PASSWORD_CHANGE_PATH);
  if (user) return user;

  // The case the proxy cannot catch: a cookie that is present but dead —
  // expired, revoked, or forged. It waves those through (no DB lookup, by
  // design), so the refusal happens here, several components deep, with no
  // access to the URL bar. The proxy leaves the path in a header so this
  // redirect can carry it, and the user keeps their place across an expiry
  // rather than being dumped at a bare /login.
  //
  // redirect() signals by throwing, so it stays outside any try/catch.
  const requestedPath = (await headers()).get(REQUESTED_PATH_HEADER);
  redirect(loginPathFor(requestedPath));
}

/**
 * For the password change itself — its page, its action, and the portal
 * shell around them — and nothing else: the one way in for a session whose
 * password somebody else issued. Every other caller uses `requireUser`, which
 * sends that session here.
 */
export async function requireUserForPasswordChange(): Promise<SessionUser> {
  const user = await sessionUser();
  if (user) return user;
  const requestedPath = (await headers()).get(REQUESTED_PATH_HEADER);
  redirect(loginPathFor(requestedPath));
}

/**
 * Whether this browser is signed in to an account that must replace its
 * password first. For the pages that decide where somebody lands — the root
 * and the sign-in page — so a student part-way through is sent back to the
 * password change rather than shown a sign-in form.
 */
export async function isPasswordChangePending(): Promise<boolean> {
  return Boolean((await sessionUser())?.mustChangePassword);
}

/**
 * Where a request came from, for its audit row: the forwarded client address
 * and the browser's user agent, as sign-in records them. Recorded only —
 * never used to decide anything.
 */
export async function requestMetadata(): Promise<{ ipAddress: string | null; userAgent: string | null }> {
  const headerStore = await headers();
  return { ipAddress: headerStore.get("x-forwarded-for"), userAgent: headerStore.get("user-agent") };
}

/**
 * For Server Components/Server Actions only — Route Handlers should use
 * getCurrentUser() + hasPermission() directly and return a 403 JSON
 * response instead, since they serve non-browser callers a redirect isn't
 * the right contract for (see ARCHITECTURE.md).
 */
export async function requirePermissionOrRedirect(permission: PermissionKey): Promise<SessionUser> {
  const user = await requireUser();
  if (!hasPermission(user, permission)) redirect("/unauthorized");
  return user;
}
