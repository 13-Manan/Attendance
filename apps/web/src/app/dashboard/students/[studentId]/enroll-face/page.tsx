import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { requireSameInstitution } from "@/modules/authorization/service";
import { getStudentById } from "@/modules/students/repository";
import { studentDisplayName } from "@/modules/students/types";
import { getStudentFaceEnrollment } from "@/modules/face-enrollment/service";
import type { FaceSampleRecord } from "@/modules/face-enrollment/types";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { TableScroll } from "@/components/ui/table-scroll";
import { StaffEnrollmentClient } from "./staff-enrollment-client";
import { DeleteFaceData } from "./delete-face-data";

/**
 * One student's face enrollment, from a member of staff's desk.
 *
 * Gated on `faceEmbedding.manage` *and* on the student belonging to this
 * actor's institution. Both, not either: an administrator who legitimately
 * manages biometrics at one institution must still be refused a student at
 * another, and a permission check alone would let them through.
 *
 * ## Why the history shows retired samples
 *
 * Their absence is the thing worth seeing. "Enrolled in September, withdrawn in
 * November by A. Deshpande" and "never enrolled" produce the same empty list of
 * active templates and mean completely different things — the first is a
 * decision somebody made and may need to explain.
 *
 * Nothing on this page is biometric. Every column is metadata: when, which
 * model, how it was captured, who acted. The vector cannot appear here even by
 * mistake, because the repository that feeds it selects field by field and
 * Prisma cannot type the column it would have to name.
 */

function formatWhen(value: Date | null): string {
  if (!value) return "Not recorded";
  return value.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const RETIREMENT_WORDS: Record<NonNullable<FaceSampleRecord["retirementReason"]>, string> = {
  REPLACED: "Replaced",
  WITHDRAWN: "Withdrawn",
  RETENTION: "Retention policy",
  STUDENT_INACTIVE: "Student left",
};

const SOURCE_WORDS: Record<NonNullable<FaceSampleRecord["captureSource"]>, string> = {
  CAMERA: "Camera",
  UPLOAD: "Upload",
};

const CHANNEL_WORDS: Record<NonNullable<FaceSampleRecord["channel"]>, string> = {
  STAFF: "Staff",
  SELF: "Self",
};

function SampleState({ sample }: { sample: FaceSampleRecord }) {
  if (sample.isActive) {
    return <Badge tone="positive">In use</Badge>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      <Badge tone="neutral">
        {sample.retirementReason ? RETIREMENT_WORDS[sample.retirementReason] : "Retired"}
      </Badge>
      <span className="text-xs text-neutral-500">
        {formatWhen(sample.retiredAt)}
        {sample.retiredByName ? ` · ${sample.retiredByName}` : ""}
      </span>
    </div>
  );
}

export default async function StaffEnrollFacePage({
  params,
}: {
  params: Promise<{ studentId: string }>;
}) {
  const user = await requirePermissionOrRedirect("faceEmbedding.manage");
  const { studentId } = await params;
  const student = await getStudentById(studentId);
  if (!student) notFound();
  requireSameInstitution(user, student.institutionId);

  const { status, samples, runningModel } = await getStudentFaceEnrollment(user, student.id);
  const productionReady = runningModel?.productionEligible ?? false;
  // A gallery provider (Azure AI Face) that may detect but not yet identify:
  // enrollment is refused before any image leaves, so say so up front.
  const identificationPending =
    runningModel?.templateKind === "gallery" && runningModel.identification !== "enabled";

  return (
    <div className="flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <Link
          href={`/dashboard/students/${student.id}`}
          className="text-sm text-neutral-500 hover:text-neutral-900"
        >
          ← {studentDisplayName(student)}
        </Link>
        <h1 className="text-xl font-semibold text-neutral-900">
          Face enrollment · {studentDisplayName(student)}
        </h1>
        <p className="max-w-3xl text-sm text-neutral-500">
          Student code {student.studentCode}. A capture is turned into a protected biometric
          template; the photograph itself is not stored. Recognition is an assistant — a teacher
          always has the final say over a register.
        </p>
      </header>

      {runningModel && !productionReady ? (
        <p
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <span className="font-medium">
            This deployment is not running a production-eligible face model.
          </span>{" "}
          It is running <span className="font-mono text-xs">{runningModel.modelName}</span>{" "}
          <span className="font-mono text-xs">{runningModel.modelVersion}</span>, whose weights have
          commercial-use status &ldquo;{runningModel.commercialUse}&rdquo;.{" "}
          {runningModel.commercialUse === "not-applicable"
            ? "This backend is a development stub: enrollment works and the whole pipeline is exercised, but it matches nobody."
            : "Recognition does run — captures are compared against enrolled templates and can be matched. What is missing is licence clearance, not capability."}{" "}
          Do not rely on automatic attendance until a licence-verified model is deployed.
        </p>
      ) : null}

      {identificationPending ? (
        <p
          role="status"
          className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
        >
          <span className="font-medium">
            {runningModel?.identification === "not_approved"
              ? "Face identification is awaiting Azure approval."
              : "Face identification is temporarily unavailable."}
          </span>{" "}
          Face enrolment is paused: the face service can detect faces but cannot identify them
          yet, so new samples cannot be added. Existing samples are unaffected, and attendance
          can still be taken by hand.
        </p>
      ) : null}
      {!runningModel ? (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          The face recognition service could not be reached, so a new capture cannot be enrolled
          right now. The samples below are unaffected.
        </p>
      ) : null}

      <Panel
        title="Capture"
        description="Camera or an uploaded photograph. Both are checked for quality, and both are compared against this institution's existing templates before anything is stored."
      >
        <StaffEnrollmentClient studentId={student.id} initialStatus={status} />
      </Panel>

      <Panel
        title="Samples"
        description={
          samples.length === 0
            ? "Nothing has been enrolled for this student."
            : `${status.usableSamples} in use${status.staleSamples > 0 ? `, ${status.staleSamples} from a model no longer running` : ""}, ${samples.length} recorded in total.`
        }
      >
        {samples.length === 0 ? (
          <EmptyState>
            No face sample has ever been enrolled for this student. Their register is taken by hand,
            which is correct — but only if somebody knows it is going to happen.
          </EmptyState>
        ) : (
          <TableScroll minWidth="min-w-[54rem]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
                  <th className="py-2 pr-4 font-medium">Enrolled</th>
                  <th className="py-2 pr-4 font-medium">How</th>
                  <th className="py-2 pr-4 font-medium">Model</th>
                  <th className="py-2 pr-4 font-medium">Quality</th>
                  <th className="py-2 font-medium">State</th>
                </tr>
              </thead>
              <tbody>
                {samples.map((sample) => (
                  <tr key={sample.id} className="border-b border-neutral-100 align-top">
                    <td className="py-3 pr-4 text-sm text-neutral-900">
                      {formatWhen(sample.createdAt)}
                      {sample.enrolledByName ? (
                        <span className="block text-xs text-neutral-500">
                          by {sample.enrolledByName}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">
                      {sample.captureSource ? SOURCE_WORDS[sample.captureSource] : "Not recorded"}
                      <span className="block text-xs text-neutral-500">
                        {sample.channel ? CHANNEL_WORDS[sample.channel] : "Channel not recorded"}
                        {sample.aligned === null
                          ? ""
                          : sample.aligned
                            ? " · aligned"
                            : " · not aligned"}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-sm text-neutral-600">
                      <span className="font-medium text-neutral-900">{sample.modelName}</span>
                      <span className="block font-mono text-xs text-neutral-500">
                        {sample.modelVersion}
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-sm tabular-nums text-neutral-600">
                      {sample.qualityScore === null
                        ? "—"
                        : sample.qualityScore.toFixed(2)}
                    </td>
                    <td className="py-3">
                      <SampleState sample={sample} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        )}
        <p className="text-xs text-neutral-500">
          Retiring a sample stops it being used for recognition immediately and keeps the row here.
          Erasing the biometric data outright is a separate decision, below.
        </p>
      </Panel>

      {/* Reachable by the same `faceEmbedding.manage` that gates this page, so
          the administrator who receives an erasure request can act on it here
          rather than asking somebody with database access. */}
      <DeleteFaceData studentId={student.id} studentCode={student.studentCode} />
    </div>
  );
}
