import type { ModelInfoResponse } from "@attendance/shared-types";
import type { FaceEnrollmentStatusSummary } from "@/modules/face-enrollment/policy";
import type { FaceSampleRecord } from "@/modules/face-enrollment/types";
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/ui/panel";
import { TableScroll } from "@/components/ui/table-scroll";

/**
 * The parts of a face enrollment screen that say what the service can do and
 * what is stored: shared by the administrator's screen and a college
 * department's, so the two can never tell a member of staff different things.
 * Metadata only — nothing here can hold a vector or an image.
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

/** What the running face model can and cannot do, said before anybody takes a photograph. */
export function EnrollmentNotices({ runningModel }: { runningModel: ModelInfoResponse | null }) {
  const productionReady = runningModel?.productionEligible ?? false;
  // A gallery provider (Azure AI Face) that may detect but not yet identify:
  // enrollment is refused before any image leaves, so say so up front.
  const identificationPending =
    runningModel?.templateKind === "gallery" && runningModel.identification !== "enabled";
  return (
    <>
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
    </>
  );
}

/** Every sample stored for one student, retired ones included — see the page's note on why. */
export function SampleHistory({
  status,
  samples,
  erasure = "Erasing the biometric data outright is a separate decision, below.",
}: {
  status: FaceEnrollmentStatusSummary;
  samples: FaceSampleRecord[];
  /** Where erasing a student's biometric data outright is done, seen from this screen. */
  erasure?: string;
}) {
  return (
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
        Retiring a sample stops it being used for recognition immediately and keeps the row here.{" "}
        {erasure}
      </p>
    </Panel>
  );
}
