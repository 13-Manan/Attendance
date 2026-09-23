import Link from "next/link";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getFaceCoverage } from "@/modules/face-enrollment/coverage";
import { faceModelInfo } from "@/lib/face-ai-client";
import type { ModelInfoResponse } from "@attendance/shared-types";
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

/**
 * The running model, and whether anybody may rely on it.
 *
 * A licence question and an accuracy question answered in the same place,
 * because an administrator asking "is face recognition working?" is asking
 * both. The service refuses to start on unlicensed weights when
 * `FACE_AI_REQUIRE_PRODUCTION_MODEL` is set, but a deployment that has not set
 * it will happily run the mock — and a mock enrols everybody successfully
 * while recognising nobody. That is exactly the failure this panel exists to
 * make impossible to miss.
 */
function ModelProvenance({ model }: { model: ModelInfoResponse | null }) {
  if (!model) {
    return (
      <Panel
        title="Recognition model"
        description="Which model this deployment runs, and whether its weights are cleared for production use."
      >
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">
          The face service could not be reached, so the running model is unknown. New enrollments
          will fail until it is back. Stored samples are unaffected, and attendance can still be
          taken by hand.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      title="Recognition model"
      description="Which model this deployment runs, and whether its weights are cleared for production use."
    >
      {!model.productionEligible ? (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-medium">This model is not cleared for production use.</span>{" "}
          Its weights have commercial-use status &ldquo;{model.commercialUse}&rdquo;.{" "}
          {model.commercialUse === "not-applicable"
            ? "This backend is a development stub: enrollment works and the whole pipeline is exercised end to end, but no face will ever be matched."
            : "Recognition does run, and enrolled faces can be matched. The unresolved question is the licence behind the weights, not whether the model works — so results must be treated as suggestions and confirmed by a person."}{" "}
          Production recognition stays blocked until a licence-verified model is deployed.
        </p>
      ) : null}

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-neutral-500">Model</dt>
        <dd className="text-neutral-900">{model.modelName}</dd>
        <dt className="text-neutral-500">Version</dt>
        <dd className="font-mono text-xs text-neutral-900">{model.modelVersion}</dd>
        <dt className="text-neutral-500">Weights</dt>
        <dd className="font-mono text-xs text-neutral-900">{model.weightsVersion}</dd>
        <dt className="text-neutral-500">Preprocessing</dt>
        <dd className="font-mono text-xs text-neutral-900">{model.preprocessingVersion}</dd>
        <dt className="text-neutral-500">Embedding</dt>
        <dd className="text-neutral-900">
          {model.embeddingDim} dimensions
          {model.embeddingNormalized ? ", L2-normalised" : ", NOT normalised"}
        </dd>
        <dt className="text-neutral-500">Runtime</dt>
        <dd className="text-neutral-900">{model.runtime}</dd>
        <dt className="text-neutral-500">Commercial use</dt>
        <dd className="text-neutral-900">{model.commercialUse}</dd>
        <dt className="text-neutral-500">Production eligible</dt>
        <dd className="text-neutral-900">{model.productionEligible ? "Yes" : "No"}</dd>
      </dl>

      <p className="text-xs text-neutral-500">
        A template can only be compared against another made by the same model and the same
        preprocessing. Changing either invalidates every stored sample — which is why both are
        recorded on each one, and why a model swap is a re-enrollment rather than a config change.
      </p>
    </Panel>
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

  // Best effort. A face service that is down must not take this page with
  // it: the coverage figures come from our own database and are still true.
  // Asked first, because "enrolled" means enrolled for the model now running.
  const model = await faceModelInfo().catch(() => null);
  const coverage = await getFaceCoverage(user, model);
  const missing = Math.max(0, coverage.activeStudents - coverage.enrolledStudents);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-500">
          Attendance
        </span>
        <h1 className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
          Face enrollment
        </h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Which students the recognition pipeline can actually recognise. A student with no sample
          is never matched, and their register is taken by hand — which is correct, but only if
          somebody knows it is going to happen.
        </p>
      </header>

      <ModelProvenance model={model} />

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
            ? "Every active student can be recognised by the running model."
            : `${missing} active student(s) cannot be recognised by the running model. Attendance still works for them — they are marked by hand.`}
          {coverage.runningModelKnown
            ? ""
            : " The running model is unknown, so samples from any model are counted here."}
        </p>
        {coverage.needsReenrollment > 0 ? (
          <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <span className="font-medium">
              {coverage.needsReenrollment} student(s) must be re-enrolled.
            </span>{" "}
            Their samples were made by a model this deployment no longer runs, so they are kept
            but never compared, and these students will not be recognised until a new sample is
            taken with the running model. They are listed below as &ldquo;Re-enroll&rdquo;.
          </p>
        ) : null}
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
            : `${missing} student(s) have no sample the running model can use${
                coverage.unenrolledShown < missing
                  ? `; the first ${coverage.unenrolledShown} are listed.`
                  : "."
              }`
        }
      >
        {coverage.unenrolled.length === 0 ? (
          <EmptyState>Every active student can be recognised by the running model.</EmptyState>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {coverage.unenrolled.map((student) => (
              <li
                key={student.id}
                className="rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm text-neutral-700"
              >
                <span className="font-mono text-xs text-neutral-500">{student.studentCode}</span>{" "}
                {student.name}
                {student.needsReenrollment ? (
                  <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                    Re-enroll
                  </span>
                ) : null}
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
            {coverage.models.map((stored) => (
              <li key={`${stored.modelName}:${stored.modelVersion}`} className="text-sm text-neutral-700">
                <span className="font-medium text-neutral-900">{stored.modelName}</span>{" "}
                <span className="text-neutral-500">{stored.modelVersion}</span> — {stored.samples}{" "}
                sample(s)
                {model ? (
                  model.modelName === stored.modelName && model.modelVersion === stored.modelVersion ? (
                    <span className="text-green-700"> · running</span>
                  ) : (
                    <span className="text-amber-800"> · not running — never compared</span>
                  )
                ) : null}
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
