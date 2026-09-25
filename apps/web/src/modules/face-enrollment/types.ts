import type { FaceQualityReason } from "@attendance/shared-types";
import { MAX_SAMPLES_PER_STUDENT, type FaceEnrollmentStatusSummary } from "./policy";

export type { FaceQualityReason };

/**
 * How the image reached the server. Mirrors the `FaceCaptureSource` enum in
 * schema.prisma; declared here as well so a client component can name a source
 * without importing the Prisma client.
 */
export type FaceCaptureSource = "CAMERA" | "UPLOAD";

/** Who performed the enrollment. Mirrors `FaceEnrollmentChannel`. */
export type FaceEnrollmentChannel = "STAFF" | "SELF";

/** Mirrors `FaceSampleRetirementReason`. */
export type FaceSampleRetirementReason =
  | "REPLACED"
  | "WITHDRAWN"
  | "RETENTION"
  | "STUDENT_INACTIVE";

/**
 * Every way an enrollment can be turned down.
 *
 * The quality reasons come from the model and describe the photograph. The
 * rest describe the request: who asked, what is already stored, and whether
 * the pipeline is in a state where storing anything would be safe. They are
 * one union because the caller does one thing with them — shows a sentence and
 * decides whether retaking the photo could possibly help.
 */
export type FaceEnrollmentRefusal =
  | Exclude<FaceQualityReason, "ok">
  /** The actor may not touch this student. */
  | "cross_institution"
  /** This institution does not permit students to enrol themselves. */
  | "self_enrollment_disabled"
  /** The student holds the maximum number of active samples. */
  | "sample_limit"
  /** This exact face is already stored for this student. */
  | "already_enrolled"
  /** Recognition would confidently call this face a different student. */
  | "duplicate_identity"
  /** Recognition could not tell this student from another one. */
  | "ambiguous_identity"
  /** The face does not match any sample already stored for this student. */
  | "does_not_match_student"
  /** The model returned a vector that breaks the embedding contract. */
  | "invalid_embedding"
  /** The face service could not be reached, or refused the request. */
  | "service_error"
  /** A gallery provider whose identification feature is not enabled (Azure
   * Face Limited Access pending). Nothing was sent to it. */
  | "recognition_not_enabled"
  /** A gallery provider keeps one gallery per class, and this student is in
   * no class to add them to. */
  | "no_active_class";

/**
 * The externally-safe shape returned to a caller (Server Action, Route
 * Handler, UI). By construction it contains NO embedding — the vector never
 * leaves the server module that wrote it. Any additional field added here must
 * be justified against the Phase 3 security invariant: "Never return raw face
 * embeddings to normal student-facing APIs."
 *
 * Both branches carry the student's enrollment status, because every caller
 * needs it immediately afterwards: the capture UI has to know how many sample
 * slots are left, and it must know that whether the attempt succeeded or was
 * turned down.
 */
export type FaceEnrollmentResult =
  | {
      ok: true;
      embeddingId: string;
      qualityScore: number;
      /** Human-safe wording for a successful capture. */
      message: string;
      status: FaceEnrollmentStatusSummary;
      /** True when this capture replaced the student's previous templates. */
      replaced: number;
    }
  | {
      ok: false;
      reason: FaceEnrollmentRefusal;
      message: string;
      status: FaceEnrollmentStatusSummary;
      /**
       * Whether taking another photograph could plausibly succeed. `false` for
       * a refusal about permissions, policy or stored data — where a retake is
       * wasted effort and the UI should offer something else instead.
       */
      retryable: boolean;
      /**
       * Staff path, `duplicate_identity` only: the student this face collided
       * with. Present so the UI can offer the one resolution a retake cannot —
       * "these are different people" (identical twins) — bound to exactly this
       * student. Never set on the self-enrollment path.
       */
      collidedWith?: { studentId: string; label: string | null };
    };

/**
 * One stored template, as an administrator sees it.
 *
 * Metadata only. There is no field here that could carry a vector or an image,
 * which is the point: the history view is reachable by every account with
 * `faceEmbedding.manage`, and the shape it receives is what stops a future
 * edit from widening that.
 */
export interface FaceSampleRecord {
  id: string;
  createdAt: Date;
  modelName: string;
  modelVersion: string;
  weightsVersion: string | null;
  preprocessingVersion: string | null;
  embeddingDim: number;
  aligned: boolean | null;
  qualityScore: number | null;
  captureSource: FaceCaptureSource | null;
  channel: FaceEnrollmentChannel | null;
  enrolledByName: string | null;
  isActive: boolean;
  retiredAt: Date | null;
  retiredByName: string | null;
  retirementReason: FaceSampleRetirementReason | null;
}

/**
 * Appended, for staff only, to a successful enrollment whose face closely
 * resembles another student's. Not a refusal: both students are enrolled, and
 * attendance is where the two are told apart — or sent to a teacher when they
 * cannot be.
 */
/**
 * Why both of two similar students need a full set: attendance finds a pair
 * it cannot tell apart from the pair's own templates. With five each it found
 * three of the four identical-twin pairs measured at that size every time;
 * with one each, in 3-40% of enrolments
 * (services/face-ai/docs/CALIBRATION.md, "Twins").
 */
const COMPLETE_BOTH =
  "Take all five guided photographs of both students — with fewer, attendance may not see that the two look alike.";

export function describeLookalike(otherStudentLabel: string): string {
  return `Note: this face closely resembles ${otherStudentLabel}. Both stay enrolled; when a classroom photograph cannot tell them apart, it is sent to review rather than guessed. ${COMPLETE_BOTH}`;
}

/** Staff only: after confirming two students are different people. */
export function describeConfirmedDistinct(otherStudentLabel: string): string {
  return `Saved as a different person from ${otherStudentLabel}. A classroom match to either of them is sent to review rather than guessed. ${COMPLETE_BOTH}`;
}

export const HUMAN_REASON: Record<FaceQualityReason, string> = {
  ok: "Face captured successfully.",
  no_face: "No face was detected. Look at the camera and try again.",
  multiple_faces: "More than one face was detected. Make sure only the student is in frame.",
  face_too_small: "Face is too small in the frame. Move closer to the camera.",
  blurred: "The face is blurred. Hold the camera steady and let it focus before capturing.",
  too_dark: "Image is too dark. Move to a well-lit area.",
  too_bright: "Image is too bright. Move out of direct light or away from a window.",
  occluded: "Face is partially covered. Remove any mask, hair, or object blocking the face.",
  bad_angle: "Face is at a poor angle. Look straight at the camera.",
  low_quality: "Image quality is too low. Recapture in better conditions.",
};

/**
 * Refusals a different photograph cannot fix.
 *
 * Everything else is a quality reason, and every quality reason is about the
 * image. Offering "retake" for a policy refusal sends somebody round a loop
 * that was never going to end.
 */
const TERMINAL_REFUSALS: ReadonlySet<FaceEnrollmentRefusal> = new Set<FaceEnrollmentRefusal>([
  "cross_institution",
  "self_enrollment_disabled",
  "sample_limit",
  "already_enrolled",
  "duplicate_identity",
  "ambiguous_identity",
  "invalid_embedding",
  "recognition_not_enabled",
  "no_active_class",
]);

export function isRetryable(reason: FaceEnrollmentRefusal): boolean {
  return !TERMINAL_REFUSALS.has(reason);
}

/**
 * Narrows a refusal to one the model produced about the photograph.
 *
 * A type guard rather than a bare `in` check, so the switch below stays
 * exhaustive: without the narrowing, TypeScript still believes a quality
 * reason can reach the `default` branch and the `never` assignment that proves
 * every case is handled would not compile.
 */
function isQualityRefusal(
  reason: FaceEnrollmentRefusal,
): reason is Exclude<FaceQualityReason, "ok"> {
  return reason in HUMAN_REASON;
}

/**
 * What the person in front of the camera is told.
 *
 * ## Why the channel changes the wording
 *
 * Two of these refusals are the result of comparing this face against other
 * students' stored templates. Telling a member of staff "this matches Priya
 * Sharma" is the only way they can resolve it — nearly always the two records
 * are the same person enrolled twice, and they administer both. Telling a
 * *student* the same thing would hand them a biometric inference about a
 * classmate that they have no business receiving, in exchange for nothing they
 * could act on. So the staff wording names the collision and the student
 * wording does not.
 *
 * `otherStudentLabel` is therefore only ever passed on the staff path, and is
 * omitted rather than blanked when the caller could not resolve a name.
 */
export function describeRefusal(
  reason: FaceEnrollmentRefusal,
  context: { channel: FaceEnrollmentChannel; otherStudentLabel?: string | null },
): string {
  if (isQualityRefusal(reason)) {
    return HUMAN_REASON[reason];
  }

  const staff = context.channel === "STAFF";
  const other = context.otherStudentLabel?.trim();

  switch (reason) {
    case "cross_institution":
      return "That student belongs to another institution.";

    case "self_enrollment_disabled":
      return staff
        ? "This institution does not allow students to enrol their own face."
        : "Your institution enrols faces through a member of staff. Please ask at the office — you do not need to do anything here.";

    case "sample_limit":
      return staff
        ? `This student already holds the maximum of ${MAX_SAMPLES_PER_STUDENT} face samples. Replace the set, or retire one, before adding another.`
        : `You already have the maximum of ${MAX_SAMPLES_PER_STUDENT} face samples saved. Ask your institution to replace them if your appearance has changed.`;

    case "already_enrolled":
      return staff
        ? "That is the same photograph as a sample already stored for this student. Capture a different one — a second copy adds nothing the search does not already have."
        : "That is the same photograph you have already saved. Take a new one, or leave it as it is.";

    case "duplicate_identity":
      return staff
        ? other
          ? `This face already belongs to ${other}. If they are the same person, merge the student records instead of enrolling this sample. If you have checked that they are different people — identical twins, for example — you can confirm that and enrol it: attendance will then send any capture it cannot tell apart to review.`
          : "This face is already enrolled against a different student at this institution. If they are the same person, merge the student records instead. If they are different people — identical twins, for example — you can confirm that and enrol this sample."
        : "That photograph could not be saved. Please speak to your institution's office — they can sort this out.";

    case "ambiguous_identity":
      return staff
        ? other
          ? `This face is close enough to ${other}'s that recognition would send every capture of either of them to a human. Enrol a clearer, straight-on photograph, or take both by hand.`
          : "This face is close enough to another student's that recognition could not reliably tell them apart. Enrol a clearer, straight-on photograph."
        : "That photograph could not be saved. Please speak to your institution's office — they can sort this out.";

    case "does_not_match_student":
      return staff
        ? "This face does not match any sample already stored for this student, so it was not added — the likeliest explanation is that it is a photograph of somebody else. Check you have the right student, then try a clearer, straight-on photograph. If their appearance has genuinely changed, replace the whole set instead of adding to it."
        : "That photograph did not match the face already saved for you, so it was not added. Try again looking straight at the camera in good light — if it still will not save, ask your institution's office.";

    case "invalid_embedding":
      return staff
        ? "The face service returned a template that does not meet the expected format, so nothing was stored. This is a problem with the deployment rather than with the photograph — report it before enrolling anyone else."
        : "Face enrolment is not working correctly at the moment. Please try again later, or ask your institution's office.";

    case "service_error":
      return "The face recognition service is temporarily unavailable. Please try again in a moment.";

    case "recognition_not_enabled":
      return staff
        ? "Face enrolment is paused: face identification is awaiting Azure approval for this system. The photograph was not sent anywhere and nothing was stored. Attendance can still be taken by hand."
        : "Face enrolment is not available yet. Nothing was saved. Your institution will let you know when it opens.";

    case "no_active_class":
      return staff
        ? "This student is not in any class yet. Faces are enrolled per class, so add the student to their class first, then capture again."
        : "You are not in any class yet, so your face cannot be saved. Please ask your institution's office.";

    default: {
      // Exhaustiveness: a reason added to the union without a sentence here
      // fails the build rather than reaching somebody as an empty message.
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
