import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PASSWORD_RULES,
  STUDENT_LOGIN_THROTTLE,
  isPlaceholderLoginEmail,
  isThrottled,
  newPasswordProblem,
  normalizeSchoolId,
  normalizeStudentId,
  pickByStudentCode,
  placeholderLoginEmail,
} from "./student-login-policy.ts";

test("a student with no address gets a reserved, undeliverable stand-in, unique to them", () => {
  const a = placeholderLoginEmail("cmStudentA0001");
  const b = placeholderLoginEmail("cmStudentB0002");
  assert.equal(a, "student-cmstudenta0001@students.invalid");
  assert.notEqual(a, b);
  assert.ok(a.endsWith(".invalid"), "the .invalid TLD can never be a real address");
  assert.equal(isPlaceholderLoginEmail(a), true);
  assert.equal(isPlaceholderLoginEmail(" STUDENT-X@Students.Invalid "), true);
  assert.equal(isPlaceholderLoginEmail("aarav@students.example.test"), false);
  assert.equal(isPlaceholderLoginEmail("principal@greenwood.test"), false);
});

test("a student ID is trimmed and refused when it cannot be one", () => {
  assert.equal(normalizeStudentId("  013 "), "013");
  assert.equal(normalizeStudentId("GW8A001"), "GW8A001");
  for (const bad of ["", "   ", "0 13", "01\t3", "x".repeat(65), null, undefined, 13, ["013"]]) {
    assert.equal(normalizeStudentId(bad), null, JSON.stringify(bad));
  }
});

test("a school in a sign-in link is an id-shaped string, nothing else", () => {
  assert.equal(normalizeSchoolId("cmu5dxyuk0004itgu0wo59svn"), "cmu5dxyuk0004itgu0wo59svn");
  for (const bad of ["", "short", "../../etc", "a b c d e f g h", "https://evil.example", "x".repeat(65), null, 7]) {
    assert.equal(normalizeSchoolId(bad), null, JSON.stringify(bad));
  }
});

test("a typed ID means exactly one account, or none", () => {
  const exact = { studentCode: "AB13" };
  const lower = { studentCode: "ab13" };
  // Case-insensitive lookup, one match: that one.
  assert.equal(pickByStudentCode("ab13", [exact]), exact);
  // Two that differ only by case: the exact one wins.
  assert.equal(pickByStudentCode("AB13", [exact, lower]), exact);
  assert.equal(pickByStudentCode("ab13", [exact, lower]), lower);
  // Two, neither exact: ambiguous, so nobody.
  assert.equal(pickByStudentCode("Ab13", [exact, lower]), null);
  assert.equal(pickByStudentCode("013", []), null);
});

test("a guessable ID is throttled after repeated failures, not before", () => {
  assert.equal(isThrottled(0), false);
  assert.equal(isThrottled(STUDENT_LOGIN_THROTTLE.maxFailures - 1), false);
  assert.equal(isThrottled(STUDENT_LOGIN_THROTTLE.maxFailures), true);
  assert.equal(STUDENT_LOGIN_THROTTLE.windowMs, 15 * 60 * 1000);
});

test("a new password is long enough, confirmed, new, and not the student ID", () => {
  const ok = { current: "old-password-1", next: "a-fresh-one-22", confirm: "a-fresh-one-22", loginId: "013" };
  assert.equal(newPasswordProblem(ok), null);
  assert.match(newPasswordProblem({ ...ok, next: "short", confirm: "short" }) ?? "", /at least 8/);
  const long = "x".repeat(PASSWORD_RULES.maxLength + 1);
  assert.match(newPasswordProblem({ ...ok, next: long, confirm: long }) ?? "", /128 characters or fewer/);
  assert.match(newPasswordProblem({ ...ok, next: "        ", confirm: "        " }) ?? "", /only spaces/);
  assert.match(newPasswordProblem({ ...ok, confirm: "something-else" }) ?? "", /do not match/);
  assert.match(
    newPasswordProblem({ ...ok, next: "old-password-1", confirm: "old-password-1" }) ?? "",
    /different from the current/,
  );
  assert.match(
    newPasswordProblem({ ...ok, loginId: "GW8A0013", next: "gw8a0013", confirm: "gw8a0013" }) ?? "",
    /same as the student ID/,
  );
});
