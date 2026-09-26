import { test } from "node:test";
import assert from "node:assert/strict";
import { RETURN_PARAM, parseReturnPath, withReturnPath } from "./return-path.ts";

const SECTION = "/dashboard/students/classes/[classId]/sections/[sectionId]";
const SESSIONS = "/dashboard/attendance/sessions";
const ALLOWED = [SECTION, SESSIONS];

test("an allowed page is accepted, with its ids and its query", () => {
  const match = parseReturnPath("/dashboard/students/classes/c1/sections/s-2?q=aarav&page=2", ALLOWED);
  assert.equal(match?.pattern, SECTION);
  assert.deepEqual(match?.params, { classId: "c1", sectionId: "s-2" });
  assert.equal(match?.query.get("q"), "aarav");
  assert.equal(match?.query.get("page"), "2");

  assert.equal(parseReturnPath("/dashboard/attendance/sessions", ALLOWED)?.pattern, SESSIONS);
});

test("anything that leaves the site, or could, is refused", () => {
  for (const value of [
    "https://evil.example/dashboard/attendance/sessions",
    "http://evil.example",
    "//evil.example/dashboard/attendance/sessions",
    "/\\evil.example/dashboard/attendance/sessions",
    "\\\\evil.example",
    "javascript:alert(1)",
    "data:text/html,hi",
    "dashboard/attendance/sessions",
    " /dashboard/attendance/sessions",
    "/dashboard/attendance/sessions\n",
    "/dashboard/attendance/sessions\r\nSet-Cookie: x=1",
  ]) {
    assert.equal(parseReturnPath(value, ALLOWED), null, JSON.stringify(value));
  }
});

test("a path that is not exactly an allowed page is refused", () => {
  for (const value of [
    "/dashboard",
    "/dashboard/students",
    "/dashboard/students/classes/c1",
    "/dashboard/students/classes/c1/sections",
    "/dashboard/students/classes/c1/sections/s1/edit",
    "/dashboard/students/classes/c1/students/s1",
    "/dashboard/attendance/sessions/extra",
    "/login",
    "/unauthorized",
  ]) {
    assert.equal(parseReturnPath(value, ALLOWED), null, value);
  }
});

test("disguised segments are refused: traversal, escapes, fragments", () => {
  for (const value of [
    "/dashboard/students/classes/../../admin/sections/s1",
    "/dashboard/students/classes/./sections/s1",
    "/dashboard/students/classes/c%2F1/sections/s1",
    "/dashboard/students/classes/c1/sections/s%20",
    "/dashboard/students/classes/c 1/sections/s1",
    "/dashboard/students/classes/c1/sections/s1#top",
    "/dashboard//students/classes/c1/sections/s1",
    `/dashboard/students/classes/${"c".repeat(65)}/sections/s1`,
    `/dashboard/attendance/sessions?q=${"x".repeat(600)}`,
  ]) {
    assert.equal(parseReturnPath(value, ALLOWED), null, value);
  }
});

test("only a string can be a return path", () => {
  for (const value of [undefined, null, "", 42, ["/dashboard/attendance/sessions"], {}]) {
    assert.equal(parseReturnPath(value, ALLOWED), null);
  }
});

test("a link carries its return path encoded, after any query it has", () => {
  assert.equal(RETURN_PARAM, "returnTo");
  assert.equal(
    withReturnPath("/dashboard/students/s1", "/dashboard/students/classes/c1/sections/s1?q=a b"),
    "/dashboard/students/s1?returnTo=%2Fdashboard%2Fstudents%2Fclasses%2Fc1%2Fsections%2Fs1%3Fq%3Da%20b",
  );
  assert.equal(
    withReturnPath("/dashboard/students/s1?saved=1", "/dashboard"),
    "/dashboard/students/s1?saved=1&returnTo=%2Fdashboard",
  );
  assert.equal(withReturnPath("/dashboard/students/s1", null), "/dashboard/students/s1");
  assert.equal(withReturnPath("/dashboard/students/s1", undefined), "/dashboard/students/s1");
  assert.equal(withReturnPath("/dashboard/students/s1", ""), "/dashboard/students/s1");
});

test("a return path survives the round trip through a link", () => {
  const origin = "/dashboard/students/classes/c1/sections/s1?q=aarav&sort=code_desc";
  const link = new URL(withReturnPath("/dashboard/students/s1", origin), "http://app.local");
  const back = parseReturnPath(link.searchParams.get(RETURN_PARAM), ALLOWED);
  assert.equal(back?.pattern, SECTION);
  assert.equal(back?.query.get("sort"), "code_desc");
});
