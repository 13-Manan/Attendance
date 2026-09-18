import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "@/modules/auth-tenancy/session";

// UX redirect only — NOT the security boundary. Checks cookie presence,
// nothing more: no DB call, no signature check, since the session token is
// opaque and meaningless without a DB lookup anyway. Next's own docs warn
// that a matcher gap or a Server Function on an unmatched route silently
// skips Proxy entirely, so it cannot be relied on for enforcement — every
// layout/Server Action/Route Handler calls requireUser()/getCurrentUser()
// itself (see modules/auth-tenancy/session.ts and ARCHITECTURE.md).
//
// Scoped to /dashboard only — the Phase 1 homepage at "/" is left exactly
// as it was (the non-negotiable invariant against changing existing UI),
// so this does not redirect it.
export function proxy(request: NextRequest) {
  if (!request.cookies.has(SESSION_COOKIE_NAME)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
