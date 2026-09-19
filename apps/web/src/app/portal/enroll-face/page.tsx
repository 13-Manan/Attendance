import { requirePermissionOrRedirect } from "@/modules/auth-tenancy/session";
import { getOwnFaceEnrollment } from "@/modules/face-enrollment/service";
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

  let enrollment: Awaited<ReturnType<typeof getOwnFaceEnrollment>>;
  try {
    enrollment = await getOwnFaceEnrollment(user);
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
