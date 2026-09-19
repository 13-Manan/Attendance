import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/modules/auth-tenancy/session";
import { REQUESTED_PATH_HEADER } from "@/modules/auth-tenancy/redirect";

// UX redirect only — NOT the security boundary. Checks cookie presence,
// nothing more: no DB call, no signature check, since the session token is
// opaque and meaningless without a DB lookup anyway. Next's own docs warn
// that a matcher gap or a Server Function on an unmatched route silently
// skips Proxy entirely, so it cannot be relied on for enforcement — every
// layout/Server Action/Route Handler calls requireUser()/getCurrentUser()
// itself (see modules/auth-tenancy/session.ts and ARCHITECTURE.md).
//
// Scoped to the two signed-in areas, /dashboard (staff) and /portal
// (students). The homepage at "/" is deliberately left alone: it is public,
// and the login and error pages must stay reachable without a session.
//
// The path being left is carried through as `?next=`, so a session that
// expires mid-task returns the user to the page they were on. It is a hint,
// not a permission: `safeNextPath` refuses anything that is not a plain
// same-origin path, and the destination enforces its own access anyway — a
// user redirected back to a page they may not see still gets refused there.
export function proxy(request: NextRequest) {
  const requestedPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;

  if (!request.cookies.has(SESSION_COOKIE_NAME)) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", requestedPath);
    return NextResponse.redirect(loginUrl);
  }

  // Having a cookie is not having a session: it may be expired, revoked, or
  // simply made up. requireUser() is what finds that out — and it runs in a
  // Server Component, which has no way to read the URL it is rendering. So
  // the path is forwarded as a request header for it to bounce back to,
  // giving the mid-task expiry above the same return-to-where-you-were
  // behaviour as the no-cookie case rather than dumping the user at /login.
  //
  // `set`, not `append`: a client may send this header itself, and on every
  // matched route that value is overwritten here. On a route the matcher
  // misses it is attacker-controlled, which is why the reader sanitises it
  // through `safeNextPath` — the worst a forged one can then do is choose
  // which same-origin path a signed-out visitor is offered after logging in,
  // which is already a link anybody can send.
  const headers = new Headers(request.headers);
  headers.set(REQUESTED_PATH_HEADER, requestedPath);
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/dashboard/:path*", "/portal/:path*"],
};
