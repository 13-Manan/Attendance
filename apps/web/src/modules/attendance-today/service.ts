import type { SessionUser } from "@/modules/auth-tenancy/types";
import { utcDayRange } from "@/modules/attendance-analytics/service";
import { hasPermission } from "@/modules/authorization/service";
import { getInstitutionById } from "@/modules/institutions/repository";
import { resolveAttendanceMode } from "@/modules/institutions/service";
import type { Institution } from "@/modules/institutions/types";
import { institutionToday, planToday, registerStateOf, relevantForToday } from "./policy";
import * as repo from "./repository";
import type { TeacherToday, TodayRegister } from "./types";

export interface TeacherTodayDeps {
  now?: () => Date;
  getInstitutionById?: (id: string) => Promise<Institution | null>;
  listTeachingLinks?: typeof repo.listTeachingLinks;
  institutionHasCurrentYear?: typeof repo.institutionHasCurrentYear;
  listTaughtSubjects?: typeof repo.listTaughtSubjects;
  countActiveStudents?: typeof repo.countActiveStudents;
  listSessionsBetween?: typeof repo.listSessionsBetween;
}

/**
 * What the Today card offers a teacher: today's date, and the registers they
 * can take today with where each one stands.
 *
 * Derived entirely on the server from the signed-in account — its own faculty
 * links, and at a college its own subject assignments — never from anything
 * the browser sends. That is the whole of its authority: it decides what to
 * *suggest*. The capture and review pages it links to check the class and the
 * subject again, exactly as they did before this card existed.
 *
 * A register counts when capture itself would allow it:
 *  - school (daily): a class the teacher is linked to as faculty;
 *  - college (subject-wise): a subject the teacher is assigned to, in a class
 *    they are also linked to — the subject link alone does not open the
 *    capture page, so offering it would be a dead end.
 *
 * An administrator's institution-wide access is deliberately not used: the
 * card is about the classes a person teaches, not every class they could open.
 *
 * Returns null for an account that cannot take attendance at all.
 */
export async function getTeacherToday(
  actor: SessionUser,
  deps: TeacherTodayDeps = {},
): Promise<TeacherToday | null> {
  if (
    !hasPermission(actor, "attendanceSession.create") ||
    !hasPermission(actor, "attendanceSession.capture")
  ) {
    return null;
  }
  const institutionId = actor.institutionId;
  if (!institutionId) return null;

  const getInstitution = deps.getInstitutionById ?? getInstitutionById;
  const institution = await getInstitution(institutionId);
  if (!institution || institution.id !== institutionId) return null;

  const attendanceMode = resolveAttendanceMode(institution);
  const now = (deps.now ?? (() => new Date()))();
  const date = institutionToday(now, institution.timezone);

  const listLinks = deps.listTeachingLinks ?? repo.listTeachingLinks;
  const hasCurrentYear = deps.institutionHasCurrentYear ?? repo.institutionHasCurrentYear;
  const [links, institutionHasCurrent] = await Promise.all([
    listLinks(actor.userId, institutionId),
    hasCurrentYear(institutionId),
  ]);

  // Tenancy, twice: the query is scoped to the institution, and so is this.
  const relevant = relevantForToday(
    links.filter((link) => link.cohort.institutionId === institutionId),
    institutionHasCurrent,
    (link) => link.cohort.academicSession,
  );

  type Base = Omit<TodayRegister, "state" | "sessionId" | "studentCount">;
  let bases: Base[];
  if (attendanceMode === "DAILY") {
    bases = relevant.map((link) => ({
      key: link.cohortId,
      cohortId: link.cohortId,
      cohortSubjectId: null,
      className: link.cohort.name,
      termLabel: link.cohort.termLabel,
      subjectName: null,
      subjectCode: null,
      isClassTeacher: link.role === "PRIMARY",
    }));
  } else {
    const linkByCohort = new Map(relevant.map((link) => [link.cohortId, link]));
    const listSubjects = deps.listTaughtSubjects ?? repo.listTaughtSubjects;
    const subjects = await listSubjects(actor.userId, institutionId, [...linkByCohort.keys()]);
    bases = subjects.flatMap((subject) => {
      const link = linkByCohort.get(subject.cohortId);
      if (!link) return [];
      return [
        {
          key: `${subject.cohortId}:${subject.id}`,
          cohortId: subject.cohortId,
          cohortSubjectId: subject.id,
          className: link.cohort.name,
          termLabel: link.cohort.termLabel,
          subjectName: subject.subject.name,
          subjectCode: subject.subject.code,
          isClassTeacher: link.role === "PRIMARY",
        },
      ];
    });
  }

  const cohortIds = [...new Set(bases.map((b) => b.cohortId))];
  // The same UTC day Start uses to decide whether today's register already
  // exists, so the card never says "not started" for a register Start would
  // resume. The date shown is the institution's own; for an institution far
  // from UTC the two can disagree for a few hours around midnight. Where the
  // day boundary falls is the sessions module's rule and is unchanged here.
  const { start, end } = utcDayRange(now);
  const countStudents = deps.countActiveStudents ?? repo.countActiveStudents;
  const listSessions = deps.listSessionsBetween ?? repo.listSessionsBetween;
  const [studentCounts, sessions] = await Promise.all([
    countStudents(cohortIds),
    listSessions(institutionId, cohortIds, start, end),
  ]);

  // Newest first from the repository: the first session seen for a register
  // is the live one.
  const sessionByKey = new Map<string, (typeof sessions)[number]>();
  for (const session of sessions) {
    const key =
      attendanceMode === "DAILY"
        ? session.cohortSubjectId === null
          ? session.cohortId
          : null
        : session.cohortSubjectId
          ? `${session.cohortId}:${session.cohortSubjectId}`
          : null;
    if (key && !sessionByKey.has(key)) sessionByKey.set(key, session);
  }

  const registers: TodayRegister[] = bases.map((base) => {
    const session = sessionByKey.get(base.key) ?? null;
    return {
      ...base,
      studentCount: studentCounts.get(base.cohortId) ?? 0,
      state: registerStateOf(session?.status ?? null),
      sessionId: session?.id ?? null,
    };
  });

  return {
    date,
    attendanceMode,
    ...planToday(registers, { canReview: hasPermission(actor, "attendanceRecord.read") }),
  };
}
