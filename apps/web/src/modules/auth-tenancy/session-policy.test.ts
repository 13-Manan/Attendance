import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSessionUsable } from "./session-policy.ts";

/**
 * A session cookie is a bearer token: whoever holds it is that user until
 * something says otherwise. These tests are that "something".
 *
 * Every case here describes a state that can become true *after* the cookie
 * was handed out — which is why the check has to run on each request rather
 * than once at sign-in. The one that matters most in a school is
 * `account_inactive`: a member of staff who left on Friday must not still be
 * able to mark a register on Monday because their browser kept the cookie.
 */

const ACTIVE_USER = { status: "ACTIVE" };
const NOW = new Date("2026-09-19T10:00:00.000Z");
const LATER = new Date("2026-09-26T10:00:00.000Z");

test("a live session for an active account is usable", () => {
  assert.equal(
    checkSessionUsable({ expiresAt: LATER, revokedAt: null, user: ACTIVE_USER }, NOW),
    null,
  );
});

test("a revoked session is refused", () => {
  // Signing out, or an administrator ending a session, writes revokedAt.
  assert.equal(
    checkSessionUsable(
      { expiresAt: LATER, revokedAt: new Date("2026-09-19T09:00:00.000Z"), user: ACTIVE_USER },
      NOW,
    ),
    "revoked",
  );
});

test("revocation wins over a session that is also expired", () => {
  // Not cosmetic: the reason is what gets reported, and "revoked" is the more
  // specific fact about what happened to this session.
  assert.equal(
    checkSessionUsable(
      {
        expiresAt: new Date("2026-09-18T10:00:00.000Z"),
        revokedAt: new Date("2026-09-17T10:00:00.000Z"),
        user: ACTIVE_USER,
      },
      NOW,
    ),
    "revoked",
  );
});

test("an expired session is refused", () => {
  assert.equal(
    checkSessionUsable(
      { expiresAt: new Date("2026-09-19T09:59:59.999Z"), revokedAt: null, user: ACTIVE_USER },
      NOW,
    ),
    "expired",
  );
});

test("a session is dead at its expiry instant, not a millisecond later", () => {
  // The boundary is the whole point of testing this: `<` instead of `<=` would
  // leave a one-tick window in which an expired token still authenticates.
  assert.equal(
    checkSessionUsable({ expiresAt: NOW, revokedAt: null, user: ACTIVE_USER }, NOW),
    "expired",
  );
  assert.equal(
    checkSessionUsable(
      { expiresAt: new Date(NOW.getTime() + 1), revokedAt: null, user: ACTIVE_USER },
      NOW,
    ),
    null,
  );
});

test("a session belonging to a non-active account is refused", () => {
  // The session row is untouched — deactivating the account is enough, and no
  // administrator has to remember to hunt down open sessions as well.
  for (const status of ["INACTIVE", "SUSPENDED", "PENDING", ""]) {
    assert.equal(
      checkSessionUsable({ expiresAt: LATER, revokedAt: null, user: { status } }, NOW),
      "account_inactive",
      status,
    );
  }
});

test("the clock is a parameter, so expiry is testable without waiting a week", () => {
  const session = { expiresAt: LATER, revokedAt: null, user: ACTIVE_USER };
  assert.equal(checkSessionUsable(session, NOW), null);
  assert.equal(checkSessionUsable(session, new Date(LATER.getTime() + 1)), "expired");
});

test("a student's account stops working while the student is archived", () => {
  // The login itself is untouched and the history with it; the student being
  // off roll is enough, on the very next request, on every device.
  for (const status of ["INACTIVE", "TRANSFERRED", "COMPLETED"]) {
    assert.equal(
      checkSessionUsable(
        { expiresAt: LATER, revokedAt: null, user: { status: "ACTIVE", studentProfile: { status } } },
        NOW,
      ),
      "account_inactive",
      status,
    );
  }
  assert.equal(
    checkSessionUsable(
      { expiresAt: LATER, revokedAt: null, user: { status: "ACTIVE", studentProfile: { status: "ACTIVE" } } },
      NOW,
    ),
    null,
  );
});

test("a staff account, which has no student profile, is judged exactly as before", () => {
  for (const studentProfile of [undefined, null]) {
    assert.equal(
      checkSessionUsable({ expiresAt: LATER, revokedAt: null, user: { status: "ACTIVE", studentProfile } }, NOW),
      null,
    );
  }
});
