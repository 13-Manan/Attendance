// When a session that exists is nonetheless not a valid identity.
//
// Import-free, deliberately — the same arrangement as
// `authorization/ownership.ts`. The module that uses this (`./service.ts`)
// reaches for Prisma and the validated environment at load time, which makes
// it unloadable under `node --test`; the rules themselves are the part worth
// testing, so they live where a test can reach them.

/** Why a session token was refused. `null` from the check below means usable. */
export type SessionRejection = "revoked" | "expired" | "account_inactive";

export interface SessionForPolicy {
  expiresAt: Date;
  revokedAt: Date | null;
  user: {
    status: string;
    /** Present when the account is a student's; a staff account has none. */
    studentProfile?: { status: string } | null;
  };
}

/**
 * The three ways a stored session fails to authenticate its bearer.
 *
 * `now` is a parameter rather than a call to `Date.now()` so expiry can be
 * tested without waiting seven days for it.
 *
 * All three are re-evaluated on every single request rather than trusted from
 * the cookie, because each describes something that can become true *after*
 * the cookie was issued: an administrator revoking a session, the seven days
 * elapsing, an account being deactivated. A check that ran only at sign-in
 * would leave a dismissed member of staff signed in for a week.
 */
export function checkSessionUsable(
  session: SessionForPolicy,
  now: Date = new Date(),
): SessionRejection | null {
  if (session.revokedAt) return "revoked";
  // `<=`: a session is dead at its expiry instant, not one millisecond after.
  if (session.expiresAt <= now) return "expired";
  if (session.user.status !== "ACTIVE") return "account_inactive";
  // A student account works only while its student is on roll. Archiving a
  // student ends their portal on the next request — the account itself is
  // untouched, and their attendance history with it.
  if (session.user.studentProfile && session.user.studentProfile.status !== "ACTIVE") {
    return "account_inactive";
  }
  return null;
}
