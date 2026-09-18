import { test } from "node:test";
import assert from "node:assert/strict";
import {
  API_SCOPES,
  SCOPE_DESCRIPTIONS,
  SENSITIVE_SCOPES,
  formatScopeString,
  hasAllScopes,
  hasScope,
  isApiScope,
  missingScopes,
  normalizeScopes,
  parseScopeString,
  scopeFor,
} from "./scopes.ts";

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test("every scope the brief names exists", () => {
  for (const scope of [
    "students:read",
    "students:write",
    "attendance:read",
    "attendance:write",
    "classes:read",
    "subjects:read",
    "reports:read",
  ]) {
    assert.equal(isApiScope(scope), true, `${scope} should be a scope`);
  }
});

test("every scope has a description the consent screen can render", () => {
  for (const scope of API_SCOPES) {
    assert.ok(SCOPE_DESCRIPTIONS[scope]?.length > 0, `${scope} needs a description`);
  }
});

test("the scope list has no duplicates", () => {
  assert.equal(new Set(API_SCOPES).size, API_SCOPES.length);
});

test("invented and malformed scopes are rejected", () => {
  for (const value of ["students", "students:delete", "STUDENTS:READ", "", "*", ":read", null, 7, {}]) {
    assert.equal(isApiScope(value), false, `${String(value)} should not be a scope`);
  }
});

// ---------------------------------------------------------------------------
// There is no wildcard, and write does not imply read
// ---------------------------------------------------------------------------

test("no wildcard scope exists — that would be an unrestricted API with a scope-shaped label", () => {
  assert.equal(
    API_SCOPES.some((scope) => scope.includes("*")),
    false,
  );
  assert.equal(hasScope(["*"], "students:read"), false);
  assert.equal(hasScope(["students:*"], "students:read"), false);
});

test("students:write does not imply students:read", () => {
  // Deliberate least privilege: a device that submits attendance has no
  // business enumerating the roster, and an implication here would grant it
  // silently.
  assert.equal(hasScope(["students:write"], "students:read"), false);
  assert.equal(hasScope(["attendance:write"], "attendance:read"), false);
});

test("scope matching is exact — no prefix or substring matching", () => {
  assert.equal(hasScope(["students:reading"], "students:read"), false);
  assert.equal(hasScope(["xstudents:read"], "students:read"), false);
  assert.equal(hasScope(["students:read"], "students:read"), true);
});

test("an empty grant satisfies nothing", () => {
  assert.equal(hasScope([], "students:read"), false);
  assert.equal(hasAllScopes([], ["students:read"]), false);
});

// ---------------------------------------------------------------------------
// Requirement checks
// ---------------------------------------------------------------------------

test("hasAllScopes needs every required scope", () => {
  const granted = ["students:read", "attendance:read"];
  assert.equal(hasAllScopes(granted, ["students:read", "attendance:read"]), true);
  assert.equal(hasAllScopes(granted, ["students:read", "attendance:write"]), false);
});

test("a requirement of nothing is satisfied by nothing", () => {
  assert.equal(hasAllScopes([], []), true);
});

test("missingScopes names exactly what to add to the key", () => {
  assert.deepEqual(missingScopes(["students:read"], ["students:read", "students:write", "reports:read"]), [
    "students:write",
    "reports:read",
  ]);
  assert.deepEqual(missingScopes(["students:read"], ["students:read"]), []);
});

// ---------------------------------------------------------------------------
// Resource/action mapping
// ---------------------------------------------------------------------------

test("scopeFor resolves the scopes that exist and refuses to invent the rest", () => {
  assert.equal(scopeFor("students", "read"), "students:read");
  assert.equal(scopeFor("students", "write"), "students:write");
  assert.equal(scopeFor("attendance", "write"), "attendance:write");
  // No `reports:write` is defined — reports are derived, not written.
  assert.equal(scopeFor("reports", "write"), null);
  assert.equal(scopeFor("classes", "write"), null);
});

test("the sensitive set is exactly the write scopes", () => {
  const writes = API_SCOPES.filter((scope) => scope.endsWith(":write"));
  assert.deepEqual([...SENSITIVE_SCOPES].sort(), [...writes].sort());
});

// ---------------------------------------------------------------------------
// Normalisation and the OAuth2 wire format
// ---------------------------------------------------------------------------

test("normalizeScopes drops unknown entries and de-duplicates", () => {
  assert.deepEqual(
    normalizeScopes(["students:read", "students:read", "nonsense", "attendance:write"]),
    ["students:read", "attendance:write"],
  );
});

test("a request for only unknown scopes normalises to no access, not full access", () => {
  assert.deepEqual(normalizeScopes(["admin", "root", "*"]), []);
});

test("parseScopeString reads the space-delimited RFC 6749 format", () => {
  assert.deepEqual(parseScopeString("students:read attendance:read"), ["students:read", "attendance:read"]);
});

test("parseScopeString tolerates the whitespace a real client sends", () => {
  assert.deepEqual(parseScopeString("  students:read\n\tattendance:read  "), [
    "students:read",
    "attendance:read",
  ]);
  assert.deepEqual(parseScopeString(""), []);
});

test("format and parse round-trip", () => {
  const scopes = normalizeScopes(["students:read", "attendance:write"]);
  assert.deepEqual(parseScopeString(formatScopeString(scopes)), scopes);
});
