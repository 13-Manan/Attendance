import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getFaceCoverage } from "@/modules/face-enrollment/coverage";
import { Panel, EmptyState } from "@/components/ui/panel";
import { TableScroll } from "@/components/ui/table-scroll";

/**
 * Face enrollment coverage, institution-wide.
 *
 * Gated on `faceEmbedding.manage`, not on `institution.read`: who is and is
 * not enrolled is information about students' biometrics, and it belongs to
 * the people who administer that rather than to everyone who may read a
 * settings page.
 *
 * ## Nothing on this page is biometric
 *
 * No vector, no photograph, no link to one. Every figure here is a count, and
 * the only per-student information is a name and a code that this
 * administrator can already read on the students screen. The module that
 * produces it explains why in full.
 *
 * ## Why coverage rather than a list of enrollments
 *
 * The failure this page exists to prevent is silent: a class nobody enrolled
 * looks exactly like a class where recognition is not working, on the first
 * morning somebody tries to use it. A number per class, worst first, turns
 * that into something an administrator can act on in the week before term.
 */

function percent(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

function CoverageBar({ part, whole }: { part: number; whole: number }) {
  const ratio = whole === 0 ? 0 : Math.min(1, part / whole);
  const tone = ratio >= 0.9 ? "bg-green-600" : ratio >= 0.5 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="h-1.5 w-full max-w-40 rounded-full bg-neutral-200">
      <div
        className={`h-1.5 rounded-full ${tone}`}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </div>
  );
}

export default async function FaceEnrollmentPage() {
  const user = await requirePermissionOrRedirect("faceEmbedding.manage");

  if (!user.institutionId) {
    return (
      <p className="text-sm text-neutral-500">
        Platform-level accounts aren&apos;t scoped to a single institution, so there is no
        enrollment coverage to show here.
      </p>
    );
  }

  const coverage = await getFaceCoverage(user);
  const missing = Math.max(0, coverage.activeStudents - coverage.enrolledStudents);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Face enrollment</h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Which students the recognition pipeline can actually recognise. A student with no sample
          is never matched, and their register is taken by hand — which is correct, but only if
          somebody knows it is going to happen.
        </p>
      </header>

      <Panel
        title="Coverage"
        description="Counted across active students. A student may have several samples; both numbers are shown."
      >
        <dl className="grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Active students</dt>
            <dd className="text-2xl font-semibold text-neutral-900">{coverage.activeStudents}</dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Enrolled</dt>
            <dd className="text-2xl font-semibold text-neutral-900">
              {coverage.enrolledStudents}{" "}
              <span className="text-sm font-normal text-neutral-500">
                ({percent(coverage.enrolledStudents, coverage.activeStudents)})
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-xs uppercase tracking-wide text-neutral-500">Samples stored</dt>
            <dd className="text-2xl font-semibold text-neutral-900">{coverage.samples}</dd>
          </div>
        </dl>
        <p className="text-xs text-neutral-500">
          {missing === 0
            ? "Every active student has at least one sample."
            : `${missing} active student(s) have none. Attendance still works for them — they are marked by hand.`}
        </p>
      </Panel>

      <Panel
        title="By class"
        description="Worst coverage first, because this list is a to-do rather than a roster."
      >
        {coverage.cohorts.length === 0 ? (
          <EmptyState>
            No student is enrolled in a class yet, so there is nothing to measure coverage against.
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[34rem]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4 font-medium">Class</th>
                  <th className="py-2 pr-4 font-medium">Students</th>
                  <th className="py-2 pr-4 font-medium">Enrolled</th>
                  <th className="py-2 font-medium">Coverage</th>
                </tr>
              </thead>
              <tbody>
                {coverage.cohorts.map((cohort) => (
                  <tr key={cohort.cohortId} className="border-b border-neutral-100">
                    <td className="py-3 pr-4 text-sm font-medium text-neutral-900">
                      {cohort.cohortName}
                      {cohort.termLabel ? (
                        <span className="font-normal text-neutral-500"> · {cohort.termLabel}</span>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">{cohort.students}</td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">{cohort.enrolled}</td>
                    <td className="py-3">
                      <div className="flex items-center gap-2">
                        <CoverageBar part={cohort.enrolled} whole={cohort.students} />
                        <span className="text-sm text-neutral-600">
                          {percent(cohort.enrolled, cohort.students)}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
      </Panel>

      <Panel
        title="Not enrolled"
        description={
          missing === 0
            ? "Nobody is missing."
            : `${missing} student(s) have no sample${
                coverage.unenrolledShown < missing
                  ? `; the first ${coverage.unenrolledShown} are listed.`
                  : "."
              }`
        }
      >
        {coverage.unenrolled.length === 0 ? (
          <EmptyState>Every active student has at least one sample.</EmptyState>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {coverage.unenrolled.map((student) => (
              <li
                key={student.id}
                className="rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm text-neutral-700"
              >
                <span className="font-mono text-xs text-neutral-500">{student.studentCode}</span>{" "}
                {student.name}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-neutral-500">
          Enrollment happens on a student&apos;s own record, where the quality check and the
          consent conversation belong.{" "}
          <Link
            href="/dashboard/students"
            className="font-medium text-neutral-900 underline underline-offset-4"
          >
            Go to students
          </Link>
          .
        </p>
      </Panel>

      <Panel
        title="Models in use"
        description="Which model produced the stored samples. Samples from different models are not comparable."
      >
        {coverage.models.length === 0 ? (
          <EmptyState>No samples are stored, so no model has been used.</EmptyState>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {coverage.models.map((model) => (
              <li key={`${model.modelName}:${model.modelVersion}`} className="text-sm text-neutral-700">
                <span className="font-medium text-neutral-900">{model.modelName}</span>{" "}
                <span className="text-neutral-500">{model.modelVersion}</span> — {model.samples}{" "}
                sample(s)
              </li>
            ))}
          </ul>
        )}
        {coverage.models.length > 1 ? (
          <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
            More than one model has produced the samples stored here. Similarity scores from
            different models mean different things, so a threshold tuned for one of them is not
            tuned for the other. Re-enrolling the older set is the way to resolve it.
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
