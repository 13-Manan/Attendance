import type { AttendanceMode } from "@/modules/institutions/types";

/**
 * Where today's register for one class — or, at a college, one class's
 * subject — stands, in the words a teacher needs: has it been started, is it
 * half done, is it waiting for them, is it finished.
 */
export type TodayRegisterState = "not_started" | "in_progress" | "in_review" | "done";

/**
 * One register a teacher could take today. Built on the server from the
 * signed-in teacher's own class (and subject) assignments; nothing here comes
 * from the browser.
 */
export interface TodayRegister {
  /** Stable key for the selector: the class, or the class and its subject. */
  key: string;
  cohortId: string;
  /** Null for a school's daily register. */
  cohortSubjectId: string | null;
  className: string;
  termLabel: string | null;
  subjectName: string | null;
  subjectCode: string | null;
  /** Active students in the class — the count Start itself reports. */
  studentCount: number;
  /** The teacher is this class's class teacher (its primary faculty link). */
  isClassTeacher: boolean;
  state: TodayRegisterState;
  /** Today's register, when one has been opened and not discarded. */
  sessionId: string | null;
}

export interface TodayLink {
  label: string;
  href: string;
}

export interface TodayRegisterView extends TodayRegister {
  /** "Not started", "In progress", "Needs review", "Completed" — or "Sent for review" for an operator. */
  statusLabel: string;
  /** What the big button does for this register. Null once today's is done. */
  primary: TodayLink | null;
  /** Today's register, once it can be looked at (in review or confirmed). */
  viewToday: TodayLink | null;
  /** Earlier registers for the class. */
  history: TodayLink;
}

/**
 * How the Today card should ask:
 *  - `single`   one register to act on — no question at all;
 *  - `choose`   several — one question, with the likeliest preselected;
 *  - `all_done` everything taken today;
 *  - `none`     nothing the teacher can take (no classes, or no students yet).
 */
export type TodayPlanKind = "none" | "single" | "choose" | "all_done";

export interface TodayDate {
  /** `YYYY-MM-DD` in the institution's timezone. */
  iso: string;
  /** "Thursday, October 1". */
  long: string;
  /** "Thu, Oct 1". */
  short: string;
  /** The timezone the date was read in (the institution's, or UTC). */
  timeZone: string;
}

export interface TeacherToday {
  date: TodayDate;
  attendanceMode: AttendanceMode;
  kind: TodayPlanKind;
  /** Registers to act on today, likeliest first. */
  choices: TodayRegisterView[];
  /** The preselected register; null when there is nothing to act on. */
  selectedKey: string | null;
  /** Registers already confirmed today. */
  done: TodayRegisterView[];
  /** Classes with nobody on roll yet, so there is nothing to take. */
  withoutStudents: Array<{ key: string; className: string; subjectName: string | null }>;
}
