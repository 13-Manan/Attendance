import { redirect } from "next/navigation";
import { getCurrentUser } from "@/modules/auth-tenancy/session";

/**
 * The application root.
 *
 * Not a page in the ordinary sense — it renders no markup and returns
 * nothing to the browser. Every request that lands here is either sent to
 * `/login` (no session cookie, or the cookie no longer resolves to a real
 * user) or handed to `/dashboard`, which owns the role-aware dispatch:
 * platform super admin to `/dashboard/platform`, student to `/portal`, and
 * institution admin / faculty stay on the staff dashboard that renders
 * there. The whole ladder already lives in `dashboard/page.tsx` — this
 * route is the entry point that routes people onto it.
 *
 * ## Why here, and why server-side
 *
 * Before this file existed as a redirect, `/` rendered the foundation
 * scaffold, and launching the installed PWA landed on that scaffold rather
 * than the app. Fixing it in the manifest — pointing `start_url` at
 * `/dashboard` or `/portal` — would guess wrong for whichever half of the
 * user base was not being pointed at. Fixing it here is correct for all of
 * them: `getCurrentUser` reads the session cookie on the server, the
 * redirect is issued before any HTML reaches the browser, so no scaffold
 * ever paints and there is no client-side JS gate to inspect.
 *
 * ## Security
 *
 * `getCurrentUser` is the same helper used by every authenticated page in
 * this app. It reads the session cookie, verifies it against the database,
 * and returns `null` if either step fails. No token is stored client-side,
 * no role is trusted from the client, and this file adds no new auth
 * surface — it consumes the existing one.
 *
 * ## Cache
 *
 * Marked `dynamic` because the response depends on the current request's
 * cookie. Caching it would send the same redirect target to two different
 * viewers, which is the whole class of bug this route exists to avoid.
 */

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // `/dashboard` owns role dispatch (platform → /dashboard/platform,
  // student → /portal, institution admin / faculty → stay). Delegating
  // there keeps the ladder in one place; adding another role or renaming
  // a landing route means changing one file, not two.
  redirect("/dashboard");
}
