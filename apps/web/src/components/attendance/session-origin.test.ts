import { test } from "node:test";
import assert from "node:assert/strict";
import { historyPath, registerOrigin, sessionsListPath } from "./session-origin.ts";

const COHORT = "cmu5dxyup000gitgucbrqyopw";
const OTHER = "cmu5dxyuq000iitgu8zwyd8ln";

test("the Sessions list is addressed the way its own form addresses it", () => {
  const none = { today: false, from: null, to: null, cohortId: null, cohortSubjectId: null, status: null };
  assert.equal(sessionsListPath(none), "/dashboard/attendance/sessions");
  assert.equal(
    sessionsListPath({ ...none, today: true, cohortId: COHORT, status: "REVIEW" }),
    `/dashboard/attendance/sessions?today=1&cohortId=${COHORT}&status=REVIEW`,
  );
  assert.equal(historyPath(COHORT), `/dashboard/attendance/${COHORT}/history`);
});

test("a register opened from a list leads back to that list", () => {
  assert.deepEqual(registerOrigin("/dashboard", COHORT), { label: "Dashboard", href: "/dashboard" });
  assert.deepEqual(registerOrigin(historyPath(COHORT), COHORT), {
    label: "Attendance history",
    href: historyPath(COHORT),
  });
  assert.deepEqual(
    registerOrigin("/dashboard/attendance/sessions?status=REVIEW&from=2026-09-01", COHORT),
    { label: "Sessions", href: "/dashboard/attendance/sessions?from=2026-09-01&status=REVIEW" },
  );
});

test("the Sessions filters are re-read, never passed through", () => {
  // An unknown key is dropped, a status that does not exist is dropped, and a
  // reversed date range is put the right way round — as the page itself would.
  assert.deepEqual(
    registerOrigin(
      "/dashboard/attendance/sessions?status=NOPE&evil=1&from=2026-09-20&to=2026-09-01",
      COHORT,
    ),
    { label: "Sessions", href: "/dashboard/attendance/sessions?from=2026-09-01&to=2026-09-20" },
  );
});

test("anything else leads back to the class", () => {
  for (const value of [
    undefined,
    "",
    "https://evil.example/dashboard/attendance/sessions",
    "//evil.example",
    "/dashboard/students",
    `/dashboard/attendance/${COHORT}`,
    // Another class's history is not where this register was listed.
    historyPath(OTHER),
  ]) {
    assert.equal(registerOrigin(value, COHORT), null, String(value));
  }
});
