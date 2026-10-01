import { test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_ROLES, type PermissionKey } from "../authorization/permissions.ts";
import type { SessionUser } from "../auth-tenancy/types.ts";
import type { Institution } from "../institutions/types.ts";
import type { SessionStatus } from "../sessions/types.ts";
import type { TaughtSubjectRow, TeachingLinkRow, TodaySessionRow } from "./repository.ts";
import { getTeacherToday, type TeacherTodayDeps } from "./service.ts";

/**
 * The Today card's data, without a database.
 *
 * Greenwood (a school, daily registers, India) and Northfield (a college,
 * subject-wise). Asha is a class teacher at Greenwood; Vikram teaches at
 * Northfield. Everything the card offers comes from their own links.
 */

const NOW = new Date("2026-10-01T04:00:00Z"); // 09:30 in India

function actor(userId: string, roleKey: string, institutionId: string | null): SessionUser {
  const role = SYSTEM_ROLES.find((candidate) => candidate.key === roleKey)!;
  return {
    userId,
    email: `${userId}@test.local`,
    name: userId,
    institutionId,
    campusId: null,
    roles: [{ key: roleKey, name: role.name, institutionId, campusId: null, permissions: [...role.permissions] as PermissionKey[] }],
  };
}

function institution(id: string, type: "SCHOOL" | "COLLEGE", timezone = "Asia/Kolkata"): Institution {
  return { id, name: id, type, timezone, settings: {} } as unknown as Institution;
}

function link(
  cohortId: string,
  name: string,
  options: { role?: "PRIMARY" | "ASSISTANT"; institutionId?: string; current?: boolean } = {},
): TeachingLinkRow {
  return {
    cohortId,
    role: options.role ?? "PRIMARY",
    cohort: {
      id: cohortId,
      name,
      termLabel: "2026-2027",
      institutionId: options.institutionId ?? "greenwood",
      academicSession: { isActive: true, isCurrent: options.current ?? true },
    },
  };
}

function subject(id: string, cohortId: string, name: string, code: string): TaughtSubjectRow {
  return { id, cohortId, subject: { name, code } };
}

function session(
  id: string,
  cohortId: string,
  status: SessionStatus,
  cohortSubjectId: string | null = null,
): TodaySessionRow {
  return { id, cohortId, cohortSubjectId, status, startedAt: NOW };
}

interface Fixture {
  institutions?: Institution[];
  links?: TeachingLinkRow[];
  subjects?: TaughtSubjectRow[];
  students?: Record<string, number>;
  sessions?: TodaySessionRow[];
  hasCurrentYear?: boolean;
}

interface Calls {
  links: Array<[string, string]>;
  subjects: Array<[string, string, string[]]>;
  sessions: Array<[string, string[], Date, Date]>;
}

function deps(fixture: Fixture): { deps: TeacherTodayDeps; calls: Calls } {
  const calls: Calls = { links: [], subjects: [], sessions: [] };
  const institutions = fixture.institutions ?? [institution("greenwood", "SCHOOL"), institution("northfield", "COLLEGE")];
  return {
    calls,
    deps: {
      now: () => NOW,
      getInstitutionById: async (id) => institutions.find((i) => i.id === id) ?? null,
      listTeachingLinks: async (userId, institutionId) => {
        calls.links.push([userId, institutionId]);
        return fixture.links ?? [];
      },
      institutionHasCurrentYear: async () => fixture.hasCurrentYear ?? true,
      listTaughtSubjects: async (userId, institutionId, cohortIds) => {
        calls.subjects.push([userId, institutionId, cohortIds]);
        return (fixture.subjects ?? []).filter((s) => cohortIds.includes(s.cohortId));
      },
      countActiveStudents: async (cohortIds) =>
        new Map(cohortIds.map((id) => [id, fixture.students?.[id] ?? 30])),
      listSessionsBetween: async (institutionId, cohortIds, start, end) => {
        calls.sessions.push([institutionId, cohortIds, start, end]);
        return (fixture.sessions ?? []).filter((s) => cohortIds.includes(s.cohortId));
      },
    },
  };
}

const asha = actor("asha", "CLASS_TEACHER", "greenwood");
const vikram = actor("vikram", "DEPARTMENT_FACULTY", "northfield");

// ---------------------------------------------------------------------------
// School
// ---------------------------------------------------------------------------

test("a teacher with one class: today's date and that class, preselected — nothing to choose", async () => {
  const { deps: d, calls } = deps({ links: [link("g8a", "Grade 8 - Section A")] });
  const today = (await getTeacherToday(asha, d))!;
  assert.equal(today.kind, "single");
  assert.equal(today.attendanceMode, "DAILY");
  assert.equal(today.date.iso, "2026-10-01");
  assert.equal(today.date.timeZone, "Asia/Kolkata");
  assert.equal(today.selectedKey, "g8a");
  const [only] = today.choices;
  assert.equal(only.className, "Grade 8 - Section A");
  assert.equal(only.isClassTeacher, true);
  assert.deepEqual(only.primary, {
    label: "Take today's attendance",
    href: "/dashboard/attendance/g8a/capture?start=1&from=today",
  });
  // Who and where come from the session, never from an argument.
  assert.deepEqual(calls.links, [["asha", "greenwood"]]);
});

test("a teacher with several classes: one simple question, their own class preselected", async () => {
  const { deps: d } = deps({
    links: [
      link("g8b", "Grade 8 - Section B", { role: "ASSISTANT" }),
      link("g8a", "Grade 8 - Section A"),
    ],
  });
  const today = (await getTeacherToday(asha, d))!;
  assert.equal(today.kind, "choose");
  assert.deepEqual(today.choices.map((c) => c.key), ["g8a", "g8b"]);
  assert.equal(today.selectedKey, "g8a");
});

test("a class with no students yet is not offered — one real class still needs no question", async () => {
  const { deps: d } = deps({
    links: [link("rose", "8-Rose"), link("g8a", "Grade 8 - Section A")],
    students: { rose: 0, g8a: 10 },
  });
  const today = (await getTeacherToday(asha, d))!;
  assert.equal(today.kind, "single");
  assert.equal(today.selectedKey, "g8a");
  assert.deepEqual(today.withoutStudents.map((w) => w.className), ["8-Rose"]);
});

test("next year's classes are not today's", async () => {
  const { deps: d } = deps({
    links: [link("g8a", "Grade 8 - Section A"), link("g9a", "Grade 9 - Section A", { current: false })],
  });
  const today = (await getTeacherToday(asha, d))!;
  assert.deepEqual(today.choices.map((c) => c.key), ["g8a"]);
});

// ---------------------------------------------------------------------------
// College
// ---------------------------------------------------------------------------

test("a college teacher with one subject in one section: today's date, subject and section, preselected", async () => {
  const { deps: d } = deps({
    links: [link("cse1", "CSE Sem 3 - Section 1", { institutionId: "northfield" })],
    subjects: [subject("cs301", "cse1", "Data Structures", "CS301")],
  });
  const today = (await getTeacherToday(vikram, d))!;
  assert.equal(today.attendanceMode, "SUBJECT_WISE");
  assert.equal(today.kind, "single");
  const [only] = today.choices;
  assert.equal(only.key, "cse1:cs301");
  assert.deepEqual([only.className, only.subjectName, only.subjectCode], [
    "CSE Sem 3 - Section 1",
    "Data Structures",
    "CS301",
  ]);
  assert.equal(only.primary?.href, "/dashboard/attendance/cse1/capture?subject=cs301&start=1&from=today");
});

test("a college teacher with several subjects and sections: one question across all of them", async () => {
  const { deps: d } = deps({
    links: [
      link("cse1", "CSE Sem 3 - Section 1", { institutionId: "northfield" }),
      link("cse2", "CSE Sem 3 - Section 2", { institutionId: "northfield" }),
    ],
    subjects: [
      subject("os1", "cse1", "Operating Systems", "CS302"),
      subject("ds1", "cse1", "Data Structures", "CS301"),
      subject("ds2", "cse2", "Data Structures", "CS301"),
    ],
  });
  const today = (await getTeacherToday(vikram, d))!;
  assert.equal(today.kind, "choose");
  assert.deepEqual(today.choices.map((c) => c.key), ["cse1:ds1", "cse1:os1", "cse2:ds2"]);
});

test("unauthorized section: a subject without the class link, or a class without the subject, is never offered", async () => {
  const { deps: d, calls } = deps({
    // Linked to section 1 only.
    links: [link("cse1", "CSE Sem 3 - Section 1", { institutionId: "northfield" })],
    subjects: [
      // Assigned a subject in section 2, but not linked to section 2: the
      // capture page would refuse it, so the card must not offer it.
      subject("ds2", "cse2", "Data Structures", "CS301"),
    ],
  });
  const today = (await getTeacherToday(vikram, d))!;
  assert.equal(today.kind, "none", "section 1 has no subject of theirs; section 2 is not theirs");
  assert.deepEqual(today.choices, []);
  // Subjects are only ever looked up among the teacher's own classes.
  assert.deepEqual(calls.subjects, [["vikram", "northfield", ["cse1"]]]);
});

// ---------------------------------------------------------------------------
// Tenancy and permissions
// ---------------------------------------------------------------------------

test("wrong institution: a link into another institution never reaches the card", async () => {
  const { deps: d } = deps({
    links: [
      link("g8a", "Grade 8 - Section A"),
      link("other", "Other School 8A", { institutionId: "elsewhere" }),
    ],
  });
  const today = (await getTeacherToday(asha, d))!;
  assert.deepEqual(today.choices.map((c) => c.key), ["g8a"]);

  // An account whose institution cannot be read gets no card at all.
  const stranger = actor("asha", "CLASS_TEACHER", "elsewhere");
  assert.equal(await getTeacherToday(stranger, deps({ links: [link("g8a", "Grade 8 - Section A")] }).deps), null);
});

test("an account that cannot take attendance gets no card", async () => {
  for (const roleKey of ["STUDENT", "HOD"] as const) {
    const who = actor("x", roleKey, "greenwood");
    const can = who.roles[0].permissions.includes("attendanceSession.create") &&
      who.roles[0].permissions.includes("attendanceSession.capture");
    const today = await getTeacherToday(who, deps({ links: [link("g8a", "Grade 8 - Section A")] }).deps);
    assert.equal(today === null, !can, roleKey);
  }
  assert.equal(await getTeacherToday(actor("p", "CLASS_TEACHER", null), deps({}).deps), null);
});

test("an administrator's institution-wide access is not used: the card shows only what they teach", async () => {
  const principal = actor("principal", "SCHOOL_ADMIN", "greenwood");
  const { deps: d, calls } = deps({ links: [] });
  const today = (await getTeacherToday(principal, d))!;
  assert.equal(today.kind, "none");
  assert.deepEqual(calls.links, [["principal", "greenwood"]]);
});

// ---------------------------------------------------------------------------
// Today's register
// ---------------------------------------------------------------------------

test("date handling: the date is the institution's; the register window is Start's own UTC day", async () => {
  const late = new Date("2026-10-01T20:00:00Z"); // 01:30 on 2 October in India
  const { deps: d, calls } = deps({ links: [link("g8a", "Grade 8 - Section A")] });
  const today = (await getTeacherToday(asha, { ...d, now: () => late }))!;
  assert.equal(today.date.iso, "2026-10-02");
  const [[, , start, end]] = calls.sessions;
  assert.equal(start.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(end.toISOString(), "2026-10-02T00:00:00.000Z");

  const utcSchool = deps({
    institutions: [institution("greenwood", "SCHOOL", "UTC")],
    links: [link("g8a", "Grade 8 - Section A")],
  });
  assert.equal((await getTeacherToday(asha, { ...utcSchool.deps, now: () => late }))!.date.iso, "2026-10-01");
});

test("already-created register: continued, reviewed, or shown as done — never started twice", async () => {
  const cases: Array<[SessionStatus, string | null, string]> = [
    ["CAPTURING", "Continue today's attendance", "/dashboard/attendance/g8a/capture?start=1&from=today"],
    ["REVIEW", "Review today's attendance", "/dashboard/attendance/g8a/review/s1"],
    ["CANCELLED", "Take today's attendance", "/dashboard/attendance/g8a/capture?start=1&from=today"],
  ];
  for (const [status, label, href] of cases) {
    const { deps: d } = deps({
      links: [link("g8a", "Grade 8 - Section A")],
      // The repository never returns a discarded session; this proves the
      // card would read one as "not started" if it did.
      sessions: [session("s1", "g8a", status)],
    });
    const [only] = (await getTeacherToday(asha, d))!.choices;
    assert.equal(only.primary?.label, label, status);
    assert.equal(only.primary?.href, href, status);
  }

  const { deps: done } = deps({
    links: [link("g8a", "Grade 8 - Section A")],
    sessions: [session("s1", "g8a", "FINALIZED")],
  });
  const finished = (await getTeacherToday(asha, done))!;
  assert.equal(finished.kind, "all_done");
  assert.equal(finished.done[0].viewToday?.href, "/dashboard/attendance/g8a/review/s1");
});

test("today's register is matched to the right register: a subject's lecture is not the class's daily register", async () => {
  const { deps: d } = deps({
    links: [link("cse1", "CSE Sem 3 - Section 1", { institutionId: "northfield" })],
    subjects: [
      subject("ds1", "cse1", "Data Structures", "CS301"),
      subject("os1", "cse1", "Operating Systems", "CS302"),
    ],
    sessions: [session("s-ds", "cse1", "REVIEW", "ds1")],
  });
  const today = (await getTeacherToday(vikram, d))!;
  const byKey = new Map(today.choices.map((c) => [c.key, c]));
  assert.equal(byKey.get("cse1:ds1")?.state, "in_review");
  assert.equal(byKey.get("cse1:os1")?.state, "not_started");
  assert.equal(today.selectedKey, "cse1:os1", "the lecture not yet taken is the likelier next one");

  // In a daily school, a stray subject session is not today's register.
  const school = deps({
    links: [link("g8a", "Grade 8 - Section A")],
    sessions: [session("s-x", "g8a", "REVIEW", "cs-x")],
  });
  assert.equal((await getTeacherToday(asha, school.deps))!.choices[0].state, "not_started");
});

test("an attendance operator captures but does not review: a register in review is sent, not a button", async () => {
  const operator = actor("otto", "ATTENDANCE_OPERATOR", "greenwood");
  const { deps: d } = deps({
    links: [link("g8a", "Grade 8 - Section A", { role: "ASSISTANT" }), link("g8b", "Grade 8 - Section B", { role: "ASSISTANT" })],
    sessions: [session("s1", "g8a", "REVIEW")],
  });
  const today = (await getTeacherToday(operator, d))!;
  assert.deepEqual(today.choices.map((c) => c.key), ["g8b"], "only the register still to capture is offered");
  assert.equal(today.kind, "single");
  const [sent] = today.done;
  assert.equal(sent.statusLabel, "Sent for review");
  assert.equal(sent.primary, null);
  assert.equal(sent.viewToday, null, "no link to a review board this account cannot open");
});
