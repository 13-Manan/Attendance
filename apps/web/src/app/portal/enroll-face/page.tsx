import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { MAX_SAMPLES_PER_STUDENT } from "@/modules/face-enrollment/policy";
import {
  getOwnFaceEnrollmentOverview,
  type OwnFaceEnrollmentOverview,
} from "@/modules/face-enrollment/self-enrollment";
import { SelfEnrollmentClient } from "./self-enrollment-client";

/**
 * A student enrolling their own face.
 *
 * ## What this page never learns
 *
 * Another student's id, or its own. The service resolves the caller's linked
 * Student profile from the session, and the action below accepts no student id
 * at all — so the only face reachable from this page is the caller's, and that
 * is a property of the shape of the call rather than of a check somebody
 * remembered to write.
 *
 * ## Camera only
 *
 * The capture below offers the device camera and nothing else, and the server
 * refuses anything that did not come through it (self-enrollment.ts). Staff
 * enrollment, which accepts uploads, is a different page and a different path.
 *
 * ## Where self-enrollment is permitted
 *
 * Not everywhere. A college student has a device, an account and a reason to
 * be trusted with their own enrollment; a school pupil usually has none of the
 * three, and the school workflow is a member of staff with a tablet and the
 * pupil in front of them — which is also where consent is actually obtained.
 * The institution decides, defaulting on the institution type, and this page
 * explains the refusal rather than showing a camera that leads to one.
 */
export default async function StudentSelfEnrollFacePage() {
  const user = await requirePermissionOrRedirect("faceEmbedding.enroll.own");

  let enrollment: OwnFaceEnrollmentOverview;
  try {
    enrollment = await getOwnFaceEnrollmentOverview(user);
  } catch {
    // The only expected failure is an account with no linked Student profile,
    // which is a data problem a student cannot fix and should not be shown a
    // stack trace for.
    return (
      <div className="mx-auto flex max-w-md flex-col gap-4">
        <h1 className="text-xl font-semibold text-neutral-900">Face enrollment</h1>
        <p className="text-sm text-neutral-600">
          Your account is not linked to a student record, so there is nothing to enrol against.
          Please ask your institution&apos;s office to link it.
        </p>
      </div>
    );
  }

  const { status, selfEnrollmentEnabled } = enrollment;

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-neutral-900">Face enrollment</h1>
        <p className="text-sm text-neutral-600">
          Your face template is protected biometric data. It is used only to mark you present in the
          classes you are enrolled in, the photograph itself is never stored, and a teacher always
          has the final say over your register.
        </p>
      </header>

      <EnrollmentStatus enrollment={enrollment} />

      <SelfEnrollmentClient
        initialStatus={status}
        unavailableReason={
          selfEnrollmentEnabled
            ? null
            : "Your institution enrols faces through a member of staff rather than from this page. Please ask at the office — there is nothing you need to do here."
        }
      />

      {selfEnrollmentEnabled ? (
        <section className="flex flex-col gap-2 border-t border-neutral-200 pt-4">
          <h2 className="text-sm font-semibold text-neutral-900">Your rights</h2>
          <p className="text-xs text-neutral-500">
            You can ask your institution to delete your face data at any time. Doing so does not
            affect your attendance record — registers already taken are kept, and from then on your
            attendance is marked by hand.
          </p>
        </section>
      ) : null}
    </div>
  );
}

function formatEnrolledOn(value: Date): string {
  return value.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** Who a student asks to confirm a twin or lookalike, at their kind of institution. */
function twinReviewers(type: OwnFaceEnrollmentOverview["institutionType"]): string {
  return type === "COLLEGE" ? "your HOD or the Director" : "your Class Teacher or Principal";
}

/**
 * Where the student stands, in a sentence, before the camera. As of this
 * render: the capture below keeps its own count as photographs are saved, and
 * refreshes this.
 */
function EnrollmentStatus({ enrollment }: { enrollment: OwnFaceEnrollmentOverview }) {
  const { status, selfEnrollmentEnabled, enrolledOn, twinReview, institutionType } = enrollment;

  let title: string;
  let details: string[];
  if (status.status !== "ENROLLED" && twinReview === "pending") {
    // Never who the other student is: a state, and who can resolve it.
    title = "Your face could not be enrolled yet.";
    details = [
      "Your face appears to match another student.",
      `If you are a twin or a lookalike, please contact ${twinReviewers(institutionType)} for confirmation. Once they have confirmed it, try again here.`,
    ];
  } else if (status.status !== "ENROLLED" && twinReview === "not_confirmed") {
    title = "Your face could not be enrolled.";
    details = [
      `It appears to match another enrolled student. Please contact your ${institutionType === "COLLEGE" ? "college" : "school"}'s administrator.`,
    ];
  } else if (status.status === "ENROLLED") {
    title = "Your face is enrolled.";
    details = [
      enrolledOn ? `Enrolled on ${formatEnrolledOn(enrolledOn)}` : null,
      `${status.usableSamples} of ${MAX_SAMPLES_PER_STUDENT} photos saved`,
      status.modelUnknown
        ? "The face service could not be reached just now, so this was not re-checked."
        : null,
    ].filter((line): line is string => line !== null);
  } else if (status.status === "NEEDS_REENROLLMENT") {
    title = "Your face needs to be enrolled again.";
    details = [
      "The attendance recognition system was updated, so your earlier photos can no longer be used.",
      status.remainingSlots > 0
        ? selfEnrollmentEnabled
          ? "Take new photos with your camera below."
          : ""
        : "Your photo slots are full. Please ask your institution's office to clear your earlier photos, then enroll again.",
    ].filter((line) => line.length > 0);
  } else {
    title = "Your face has not been enrolled yet.";
    details = selfEnrollmentEnabled
      ? [
          twinReview === "confirmed"
            ? "Staff have confirmed you are a different person from the student your face matched. You can enroll now."
            : "Enroll your face using your device camera so attendance can recognize you.",
        ]
      : [];
  }

  const tone =
    status.status === "ENROLLED"
      ? "border-green-200 bg-green-50 text-green-900"
      : twinReview === "pending" || twinReview === "not_confirmed"
        ? "border-amber-200 bg-amber-50 text-amber-950"
        : "border-neutral-200 bg-neutral-50 text-neutral-900";

  return (
    <section
      aria-label="Face enrollment status"
      className={`flex flex-col gap-1 rounded-md border px-4 py-3 ${tone}`}
    >
      <p className="text-sm font-medium">{title}</p>
      {details.map((line) => (
        <p key={line} className="text-xs text-neutral-600">
          {line}
        </p>
      ))}
    </section>
  );
}
