import { test } from "node:test";
import assert from "node:assert/strict";
import {
  captureHref,
  institutionToday,
  planToday,
  registerStateOf,
  relevantForToday,
  viewOf,
} from "./policy.ts";
import type { TodayRegister } from "./types.ts";

function register(overrides: Partial<TodayRegister> & Pick<TodayRegister, "key" | "className">): TodayRegister {
  return {
    cohortId: overrides.key.split(":")[0],
    cohortSubjectId: overrides.key.includes(":") ? overrides.key.split(":")[1] : null,
    termLabel: null,
    subjectName: null,
    subjectCode: null,
    studentCount: 30,
    isClassTeacher: false,
    state: "not_started",
    sessionId: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Date handling
// ---------------------------------------------------------------------------

test("date handling: today is the institution's date, not the server's", () => {
  // 20:00 UTC on 1 October is 01:30 on 2 October in India.
  const lateUtc = new Date("2026-10-01T20:00:00Z");
  const india = institutionToday(lateUtc, "Asia/Kolkata", "en-US");
  assert.equal(india.iso, "2026-10-02");
  assert.equal(india.long, "Friday, October 2");
  assert.equal(india.short, "Fri, Oct 2");
  assert.equal(india.timeZone, "Asia/Kolkata");

  const utc = institutionToday(lateUtc, "UTC", "en-US");
  assert.equal(utc.iso, "2026-10-01");
  assert.equal(utc.long, "Thursday, October 1");

  // Early morning in India is still the previous day in UTC.
  const earlyIndia = institutionToday(new Date("2026-10-01T03:00:00Z"), "Asia/Kolkata", "en-US");
  assert.equal(earlyIndia.iso, "2026-10-01");
});

test("date handling: an unknown or missing timezone falls back to UTC instead of failing", () => {
  const at = new Date("2026-10-01T23:30:00Z");
  for (const zone of ["Mars/Olympus_Mons", "", null, undefined]) {
    const today = institutionToday(at, zone, "en-US");
    assert.equal(today.timeZone, "UTC", String(zone));
    assert.equal(today.iso, "2026-10-01", String(zone));
  }
});

// ---------------------------------------------------------------------------
// States and links
// ---------------------------------------------------------------------------

test("today's attendance: each session status reads as the teacher thinks of it", () => {
  assert.equal(registerStateOf(null), "not_started");
  assert.equal(registerStateOf("CANCELLED"), "not_started", "a discarded register is no register");
  assert.equal(registerStateOf("OPEN"), "in_progress");
  assert.equal(registerStateOf("CAPTURING"), "in_progress");
  assert.equal(registerStateOf("PROCESSING"), "in_progress");
  assert.equal(registerStateOf("REVIEW"), "in_review");
  assert.equal(registerStateOf("FINALIZED"), "done");
});

test("the big button: take, continue or review — and nothing once today's is done", () => {
  const take = viewOf(register({ key: "c1", className: "7A" }));
  assert.deepEqual(take.primary, {
    label: "Take today's attendance",
    href: "/dashboard/attendance/c1/capture?start=1&from=today",
  });
  assert.equal(take.viewToday, null);
  assert.equal(take.history.href, "/dashboard/attendance/c1/history");
  assert.equal(take.statusLabel, "Not started yet");

  const cont = viewOf(register({ key: "c1", className: "7A", state: "in_progress", sessionId: "s1" }));
  assert.equal(cont.primary?.label, "Continue today's attendance");
  assert.equal(cont.primary?.href, "/dashboard/attendance/c1/capture?start=1&from=today");
  assert.equal(cont.viewToday, null, "a register still being captured has nothing to look at yet");

  const review = viewOf(register({ key: "c1", className: "7A", state: "in_review", sessionId: "s1" }));
  assert.deepEqual(review.primary, {
    label: "Review today's attendance",
    href: "/dashboard/attendance/c1/review/s1",
  });
  assert.equal(review.viewToday, null, "the big button already opens it");

  const done = viewOf(register({ key: "c1", className: "7A", state: "done", sessionId: "s1" }));
  assert.equal(done.primary, null);
  assert.deepEqual(done.viewToday, { label: "View today's attendance", href: "/dashboard/attendance/c1/review/s1" });
  assert.equal(done.statusLabel, "Done for today");
});

test("a college register's link carries its subject; ids are encoded, never interpolated raw", () => {
  assert.equal(
    captureHref({ cohortId: "sec 1", cohortSubjectId: "cs/2" }),
    "/dashboard/attendance/sec%201/capture?subject=cs%2F2&start=1&from=today",
  );
  assert.equal(
    captureHref({ cohortId: "c1", cohortSubjectId: null }, "class"),
    "/dashboard/attendance/c1/capture?start=1&from=class",
  );
});

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

test("one class: no question at all", () => {
  const plan = planToday([register({ key: "c1", className: "7A", isClassTeacher: true })]);
  assert.equal(plan.kind, "single");
  assert.equal(plan.selectedKey, "c1");
  assert.equal(plan.choices.length, 1);
});

test("several classes: one question, likeliest preselected", () => {
  const plan = planToday([
    register({ key: "c2", className: "7B" }),
    register({ key: "c1", className: "7A", isClassTeacher: true }),
    register({ key: "c3", className: "7C", state: "in_review", sessionId: "s3" }),
  ]);
  assert.equal(plan.kind, "choose");
  assert.deepEqual(
    plan.choices.map((c) => c.key),
    ["c1", "c2", "c3"],
    "own class before one assisted in; a register waiting for review after both",
  );
  assert.equal(plan.selectedKey, "c1");
});

test("a register the teacher was in the middle of comes first", () => {
  const plan = planToday([
    register({ key: "c1", className: "7A", isClassTeacher: true }),
    register({ key: "c2", className: "7B", state: "in_progress", sessionId: "s2" }),
  ]);
  assert.equal(plan.selectedKey, "c2");
});

test("everything taken today: done, with today's registers to look at", () => {
  const plan = planToday([
    register({ key: "c1", className: "7A", state: "done", sessionId: "s1" }),
    register({ key: "c2", className: "7B", state: "done", sessionId: "s2" }),
  ]);
  assert.equal(plan.kind, "all_done");
  assert.equal(plan.selectedKey, null);
  assert.deepEqual(plan.done.map((d) => d.key), ["c1", "c2"]);
});

test("a class with nobody on roll is mentioned, not offered", () => {
  const plan = planToday([
    register({ key: "empty", className: "8-Rose", studentCount: 0, isClassTeacher: true }),
    register({ key: "c1", className: "Grade 8 - Section A", isClassTeacher: true }),
  ]);
  assert.equal(plan.kind, "single", "the empty class does not turn one choice into a question");
  assert.equal(plan.selectedKey, "c1");
  assert.deepEqual(plan.withoutStudents, [{ key: "empty", className: "8-Rose", subjectName: null }]);

  assert.equal(planToday([register({ key: "empty", className: "8-Rose", studentCount: 0 })]).kind, "none");
  assert.equal(planToday([]).kind, "none");
});

test("this academic year's classes only — unless the institution never chose one", () => {
  const classes = [
    { id: "now", academicSession: { isActive: true, isCurrent: true } },
    { id: "next", academicSession: { isActive: true, isCurrent: false } },
    { id: "old", academicSession: { isActive: false, isCurrent: false } },
  ];
  const yearOf = (c: (typeof classes)[number]) => c.academicSession;
  assert.deepEqual(relevantForToday(classes, true, yearOf).map((c) => c.id), ["now"]);
  assert.deepEqual(relevantForToday(classes, false, yearOf).map((c) => c.id), ["now", "next"]);
});
