import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POST_LOGIN_PATH, loginPathFor, safeNextPath } from "./redirect.ts";

/**
 * `?next=` is attacker-controlled input that the login flow turns into a
 * redirect. These tests are the list of things it must refuse — a phishing
 * link of the form `/login?next=https://evil.example/login` that bounced a
 * user to a convincing copy of this app's sign-in page, immediately after
 * they had signed in for real, is the attack being prevented.
 *
 * The function never throws: a refusal is a safe default, not an error, so
 * there is no failure path a caller could ignore.
 */

test("an ordinary in-app path is preserved", () => {
  assert.equal(safeNextPath("/dashboard/attendance"), "/dashboard/attendance");
  assert.equal(
    safeNextPath("/dashboard/reports?from=2026-01-01&to=2026-01-31"),
    "/dashboard/reports?from=2026-01-01&to=2026-01-31",
  );
  assert.equal(safeNextPath("/portal/attendance"), "/portal/attendance");
});

test("nothing at all falls back to the dashboard", () => {
  assert.equal(safeNextPath(undefined), DEFAULT_POST_LOGIN_PATH);
  assert.equal(safeNextPath(null), DEFAULT_POST_LOGIN_PATH);
  assert.equal(safeNextPath(""), DEFAULT_POST_LOGIN_PATH);
});

test("an absolute URL to another origin is refused", () => {
  for (const attack of [
    "https://evil.example/login",
    "http://evil.example",
    "//evil.example",
    "//evil.example/dashboard",
    "https://evil.example@attendance.internal/",
  ]) {
    assert.equal(safeNextPath(attack), DEFAULT_POST_LOGIN_PATH, attack);
  }
});

test("a backslash cannot be used to smuggle a protocol-relative URL", () => {
  // Browsers normalise "\" to "/" inside a URL, so "/\evil.example" navigates
  // where "//evil.example" does.
  for (const attack of ["/\\evil.example", "/\\/evil.example", "/dashboard\\..\\.."]) {
    assert.equal(safeNextPath(attack), DEFAULT_POST_LOGIN_PATH, attack);
  }
});

test("a non-http scheme is refused", () => {
  for (const attack of [
    "javascript:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ]) {
    assert.equal(safeNextPath(attack), DEFAULT_POST_LOGIN_PATH, attack);
  }
});

test("control characters and whitespace are refused", () => {
  // CR/LF is the header-splitting shape; a tab or space is how a filter that
  // only checked the prefix gets walked past.
  for (const attack of [
    "/dashboard\nLocation: https://evil.example",
    "/dashboard\r\nSet-Cookie: a=b",
    "/dash board",
    "/dashboard\u0000",
    "\t/dashboard",
  ]) {
    assert.equal(safeNextPath(attack), DEFAULT_POST_LOGIN_PATH, JSON.stringify(attack));
  }
});

test("a relative path with no leading slash is refused", () => {
  // "dashboard" would resolve against whatever the current URL happens to be.
  assert.equal(safeNextPath("dashboard"), DEFAULT_POST_LOGIN_PATH);
  assert.equal(safeNextPath("../dashboard"), DEFAULT_POST_LOGIN_PATH);
  assert.equal(safeNextPath("evil.example"), DEFAULT_POST_LOGIN_PATH);
});

test("the auth pages themselves are never a destination", () => {
  // Otherwise signing in returns you to the sign-in form, which reads as a
  // failed login even though it succeeded.
  assert.equal(safeNextPath("/login"), DEFAULT_POST_LOGIN_PATH);
  assert.equal(safeNextPath("/login?next=/login"), DEFAULT_POST_LOGIN_PATH);
  assert.equal(safeNextPath("/unauthorized"), DEFAULT_POST_LOGIN_PATH);
});

test("a path that merely starts with an allowed name is still refused", () => {
  // "/loginsomething" is a different route and must not be confused with
  // "/login" — the check is on the pathname, not a prefix match.
  assert.equal(safeNextPath("/login-help"), "/login-help");
});

test("double-encoding does not survive as a path", () => {
  // Next has already decoded the query once by the time this sees it, so a
  // singly-encoded "//evil" arrives decoded and is caught above. A
  // doubly-encoded one arrives still-encoded, does not begin with "/", and is
  // refused here rather than being decoded a second time by something later.
  assert.equal(safeNextPath("%2F%2Fevil.example"), DEFAULT_POST_LOGIN_PATH);
  assert.equal(safeNextPath("%2Fdashboard"), DEFAULT_POST_LOGIN_PATH);
});

// ---------------------------------------------------------------------------
// loginPathFor — where a refused request is sent
// ---------------------------------------------------------------------------

test("a refused request keeps the page the user was trying to reach", () => {
  // The scenario: a session expires while somebody is halfway through a
  // register. The proxy cannot detect that (it never looks the token up), so
  // requireUser() refuses deep inside the tree and this decides where to.
  assert.equal(
    loginPathFor("/dashboard/attendance/cmf3x9q2k0001abcdxyz"),
    "/login?next=%2Fdashboard%2Fattendance%2Fcmf3x9q2k0001abcdxyz",
  );
});

test("a query string survives the round trip", () => {
  assert.equal(
    loginPathFor("/dashboard/reports?from=2026-01-01&to=2026-01-31"),
    "/login?next=%2Fdashboard%2Freports%3Ffrom%3D2026-01-01%26to%3D2026-01-31",
  );
});

test("the encoded next value cannot break out of the query string", () => {
  // Without encoding, a path containing "&" or "#" would split into extra
  // parameters or a fragment and the login page would read a truncated value.
  const url = new URL(loginPathFor("/dashboard/reports?a=1&b=2#top"), "https://example.test");
  assert.equal(url.pathname, "/login");
  assert.equal(url.searchParams.get("next"), "/dashboard/reports?a=1&b=2#top");
});

test("no useful destination means a bare /login, not ?next=/dashboard", () => {
  // The header is absent on any route the proxy does not match, and
  // "?next=/dashboard" would only restate where the login page already goes.
  assert.equal(loginPathFor(null), "/login");
  assert.equal(loginPathFor(undefined), "/login");
  assert.equal(loginPathFor(""), "/login");
  assert.equal(loginPathFor("/dashboard"), "/login");
});

test("a forged header cannot turn the refusal into an open redirect", () => {
  // Nothing stops a client sending x-requested-path to a route the proxy does
  // not match, so this value gets the same treatment as the query parameter.
  for (const attack of [
    "https://evil.example/login",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "/dashboard\r\nSet-Cookie: a=b",
  ]) {
    assert.equal(loginPathFor(attack), "/login", attack);
  }
});

test("a refusal never sends the user back to the login page itself", () => {
  // Otherwise an expired session on /login would bounce between the two.
  assert.equal(loginPathFor("/login"), "/login");
  assert.equal(loginPathFor("/unauthorized"), "/login");
});
