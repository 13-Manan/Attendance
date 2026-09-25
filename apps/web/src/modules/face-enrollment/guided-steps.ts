import type { FaceEnrollmentRefusal } from "./types";
import { MAX_SAMPLES_PER_STUDENT } from "./policy";

/**
 * The guided enrollment sequence: which photograph to ask for next, and the
 * one-line verdict shown the moment a capture comes back.
 *
 * ## Why a sequence
 *
 * Five samples of the same frontal pose in the same light are one sample
 * stored five times. A classroom photograph catches students half-turned,
 * mid-laugh, under a window — so the set asks for those, one each.
 *
 * ## What the sequence does not check
 *
 * Whether the head was actually turned. The service does report an estimated
 * yaw, but on calibration portraits that were all meant to be frontal it read
 * anywhere from −18° to +16°, so no threshold separates "turned slightly" from
 * "frontal" on that estimator. Every step is therefore a prompt, not a gate:
 * a good photograph is accepted whichever way the head was pointing, and
 * nothing here tells the person a turn was detected.
 *
 * ## Glasses
 *
 * A student enrolled without glasses who wears them in class is compared
 * across a change the recogniser handles badly: between photographs of one
 * person on different days, a change of glasses left half the pairs below the
 * review floor, against a tenth with no change (services/face-ai/docs/
 * CALIBRATION.md, "Pose, eyes, expression and glasses"). It never made two
 * people look the same — the cost is missed recognition, not a wrong one. So
 * the last step asks anyone who wears glasses only some of the time for one
 * photograph the other way.
 *
 * ## Left and right
 *
 * Always the subject's own left and right. The live preview is mirrored and
 * the stored bytes are not (see face-capture.tsx); "your left" means the same
 * thing in both, where "turn toward the left of the screen" would not.
 */

export type GuidedStepKey = "frontal" | "left" | "right" | "expression" | "lighting";

export interface GuidedStep {
  key: GuidedStepKey;
  title: string;
  /** Instruction to the person in front of the camera. */
  instruction: string;
}

const STEPS: Record<GuidedStepKey, { title: string; self: string; student: string }> = {
  frontal: {
    title: "Straight on",
    self: "Look straight at the camera with a relaxed face.",
    student: "Ask the student to look straight at the camera with a relaxed face.",
  },
  left: {
    title: "Slightly to the left",
    self: "Turn your head a little to your left — about a quarter of the way, both eyes still visible.",
    student:
      "Ask the student to turn their head a little to their own left — about a quarter of the way, both eyes still visible.",
  },
  right: {
    title: "Slightly to the right",
    self: "Turn your head a little to your right — about a quarter of the way, both eyes still visible.",
    student:
      "Ask the student to turn their head a little to their own right — about a quarter of the way, both eyes still visible.",
  },
  expression: {
    title: "Different expression",
    self: "Face the camera again with a natural smile.",
    student: "Ask the student to face the camera again with a natural smile.",
  },
  lighting: {
    title: "Different light",
    self:
      "Move to different light — nearer a window, or under the room lights — and face the camera. " +
      "If you wear glasses on some days and not others, take this one the other way from the first four.",
    student:
      "Move to different light — nearer a window, or under the room lights — and have the student face the camera. " +
      "If they wear glasses on some days and not others, take this one the other way from the first four.",
  },
};

export const GUIDED_STEP_ORDER: readonly GuidedStepKey[] = [
  "frontal",
  "left",
  "right",
  "expression",
  "lighting",
];

export function guidedStep(key: GuidedStepKey, subject: "student" | "self"): GuidedStep {
  const s = STEPS[key];
  return { key, title: s.title, instruction: subject === "self" ? s.self : s.student };
}

/**
 * Which step to ask for, given how many usable samples are stored.
 *
 * Derived from the server's counter rather than held in component state, so a
 * refreshed page, a second device or a sample retired by an admin all land on
 * the right step. Null once the set is complete. Stale samples (made by a model
 * no longer running) do not count: they are never compared, so the set is
 * rebuilt from the first step.
 */
export function currentGuidedStep(usableSamples: number): GuidedStepKey | null {
  if (usableSamples < 0) return GUIDED_STEP_ORDER[0];
  if (usableSamples >= Math.min(GUIDED_STEP_ORDER.length, MAX_SAMPLES_PER_STUDENT)) return null;
  return GUIDED_STEP_ORDER[usableSamples];
}

/**
 * The short verdict shown above the longer explanation.
 *
 * The long sentence (`describeRefusal`) says why and what to do; this is what
 * someone holding a tablet at arm's length can read at a glance.
 */
export function captureFeedbackHeadline(
  outcome: { ok: true } | { ok: false; reason: FaceEnrollmentRefusal },
): string {
  if (outcome.ok) return "Good — capture accepted";
  switch (outcome.reason) {
    case "face_too_small":
      return "Move closer";
    case "bad_angle":
      return "Face the camera";
    case "too_dark":
      return "Too dark";
    case "too_bright":
      return "Too bright";
    case "blurred":
      return "Face is blurry";
    case "multiple_faces":
      return "Only one face should be visible";
    case "no_face":
      return "No face found";
    case "occluded":
      return "Face is covered";
    case "low_quality":
      return "Photo quality too low";
    case "already_enrolled":
      return "Already saved";
    case "sample_limit":
      return "All samples taken";
    case "does_not_match_student":
      return "Doesn't look like the same student";
    case "duplicate_identity":
    case "ambiguous_identity":
      return "Could not be saved";
    case "cross_institution":
    case "self_enrollment_disabled":
      return "Not allowed";
    case "invalid_embedding":
    case "service_error":
      return "Face service problem";
    case "recognition_not_enabled":
      return "Face enrolment paused";
    case "no_active_class":
      return "Add the student to a class first";
    default: {
      const exhaustive: never = outcome.reason;
      return exhaustive;
    }
  }
}
