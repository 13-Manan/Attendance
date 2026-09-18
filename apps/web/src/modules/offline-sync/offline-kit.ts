import { requirePermission } from "@/modules/authorization/service";
import { requireCohortAccess } from "@/modules/authorization/cohort-access";
import {
  listCapturableCohortsForActor,
  listCohortSubjectsForCapture,
} from "@/modules/attendance-capture/service";
import {
  listCohortRoster,
  listCohortSubjectRoster,
} from "@/modules/attendance-review/repository";

/**
 * What a device needs cached, while it still has a network, in order to take a
 * register later without one.
 *
 * ## The premise
 *
 * Offline capture is not "the app keeps working with whatever is on screen".
 * A teacher opening a class in a basement classroom needs the roster, and a
 * roster lives on a server. So it has to be fetched *in advance*, deliberately,
 * on a screen that says what it is doing — which is `/dashboard/offline`.
 *
 * ## What is in a kit, and what is emphatically not
 *
 * In: the classes this teacher may take a register for, their subjects where
 * the institution is subject-wise, and the enrolled students' names and codes.
 * Exactly what a paper register carries, and no more.
 *
 * Not in — and this is the line that does not move:
 *
 * - **No face templates, embeddings, or descriptors.** Biometric data never
 *   reaches the browser (ARCHITECTURE.md). A "downloaded roster" that included
 *   them would be every student's biometric identifier on a tablet that gets
 *   left on a desk, and it would make "local AI" mean in-browser matching,
 *   which this system does not do.
 * - **No photographs.** Not the enrolment photos, not previous sessions'
 *   capture images.
 * - **No attendance history.** A teacher taking today's register does not need
 *   last term's percentages, and a device that never goes online again should
 *   not be carrying them.
 *
 * The consequence is the honest one: an offline register is marked by a human,
 * or by a local AI node the institution runs on its own network. It is never
 * marked by the tablet on its own.
 */

export interface OfflineKitStudent {
  studentId: string;
  fullName: string;
  /** The institution's own identifier — what a teacher reads off a list. */
  rollNumber: string | null;
}

export interface OfflineKitClass {
  /** Stable key for the cached entry: cohort, or cohort+subject. */
  key: string;
  cohortId: string;
  cohortName: string;
  termLabel: string | null;
  attendanceMode: "DAILY" | "SUBJECT_WISE";
  cohortSubjectId: string | null;
  subjectName: string | null;
  subjectCode: string | null;
  students: OfflineKitStudent[];
}

export interface OfflineKitDeps {
  listCohorts?: typeof listCapturableCohortsForActor;
  listSubjects?: typeof listCohortSubjectsForCapture;
  loadCohortRoster?: typeof listCohortRoster;
  loadSubjectRoster?: typeof listCohortSubjectRoster;
  checkCohortAccess?: typeof requireCohortAccess;
}

/**
 * How many classes one download covers.
 *
 * A cap, because an administrator with `cohort.manage` can see every cohort in
 * the institution, and "download everything for offline" for them would mean
 * pulling thousands of students onto a laptop that only needed one class. The
 * teachers this feature is for have a handful of classes and are unaffected.
 */
export const MAX_OFFLINE_CLASSES = 24;

export async function buildOfflineKit(
  actor: Parameters<typeof listCapturableCohortsForActor>[0],
  deps: OfflineKitDeps = {},
): Promise<OfflineKitClass[]> {
  requirePermission(actor, "attendanceSession.capture");

  const listCohorts = deps.listCohorts ?? listCapturableCohortsForActor;
  const listSubjects = deps.listSubjects ?? listCohortSubjectsForCapture;
  const cohortRoster = deps.loadCohortRoster ?? listCohortRoster;
  const subjectRoster = deps.loadSubjectRoster ?? listCohortSubjectRoster;
  const checkAccess = deps.checkCohortAccess ?? requireCohortAccess;

  const cohorts = await listCohorts(actor);
  const classes: OfflineKitClass[] = [];

  for (const cohort of cohorts) {
    if (classes.length >= MAX_OFFLINE_CLASSES) break;

    // The same check the capture flow makes. Downloading a roster is reading
    // a roster, and it must not be a way around cohort ownership.
    await checkAccess(actor, cohort.id);

    if (cohort.attendanceMode === "DAILY") {
      const students = await cohortRoster(cohort.id);
      classes.push({
        key: cohort.id,
        cohortId: cohort.id,
        cohortName: cohort.name,
        termLabel: cohort.termLabel,
        attendanceMode: "DAILY",
        cohortSubjectId: null,
        subjectName: null,
        subjectCode: null,
        students: students.map(toKitStudent),
      });
      continue;
    }

    const subjects = await listSubjects(actor, cohort.id);
    for (const subject of subjects) {
      if (classes.length >= MAX_OFFLINE_CLASSES) break;
      const students = await subjectRoster(subject.id);
      classes.push({
        key: `${cohort.id}:${subject.id}`,
        cohortId: cohort.id,
        cohortName: cohort.name,
        termLabel: cohort.termLabel,
        attendanceMode: "SUBJECT_WISE",
        cohortSubjectId: subject.id,
        subjectName: subject.subjectName,
        subjectCode: subject.subjectCode,
        students: students.map(toKitStudent),
      });
    }
  }

  return classes;
}

function toKitStudent(student: {
  studentId: string;
  studentCode: string;
  firstName: string;
  lastName: string;
}): OfflineKitStudent {
  return {
    studentId: student.studentId,
    fullName: `${student.firstName} ${student.lastName}`.trim(),
    rollNumber: student.studentCode || null,
  };
}
