import type { FaceQualityReason } from "@attendance/shared-types";

export type { FaceQualityReason };

/**
 * The externally-safe shape returned to a caller (Server Action, Route
 * Handler, UI). By construction it contains NO embedding — the vector never
 * leaves the server module that wrote it. Any additional field added here
 * must be justified against the Phase 3 security invariant: "Never return
 * raw face embeddings to normal student-facing APIs."
 */
export type FaceEnrollmentResult =
  | {
      ok: true;
      embeddingId: string;
      qualityScore: number;
      /** Human-safe wording; the underlying reason will always be "ok" here. */
      message: string;
    }
  | {
      ok: false;
      reason: FaceQualityReason | "cross_institution" | "duplicate" | "service_error";
      message: string;
    };

export const HUMAN_REASON: Record<FaceQualityReason, string> = {
  ok: "Face captured successfully.",
  no_face: "No face was detected. Look at the camera and try again.",
  multiple_faces: "More than one face was detected. Make sure only the student is in frame.",
  face_too_small: "Face is too small in the frame. Move closer to the camera.",
  blurred: "Image is too blurred. Hold the camera steady.",
  too_dark: "Image is too dark. Move to a well-lit area.",
  occluded: "Face is partially covered. Remove any mask, hair, or object blocking the face.",
  bad_angle: "Face is at a poor angle. Look straight at the camera.",
  low_quality: "Image quality is too low. Recapture in better conditions.",
};
