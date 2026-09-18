import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { hasPermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import { getSessionUserByRawToken } from "./service";
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

/**
 * The real identity check. Resolves the cookie -> Session row -> User ->
 * roles/permissions, rejecting on a missing/expired/revoked session or an
 * inactive account. This — not proxy.ts — is the actual security boundary;
 * see ARCHITECTURE.md's "server-side enforcement" section.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const rawToken = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!rawToken) return null;
  return getSessionUserByRawToken(rawToken);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
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
