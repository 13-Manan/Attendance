/**
 * What teachers and admins are told about recognition, in one place.
 *
 * Two audiences. A teacher is told what the product can do right now —
 * "Face recognition ready", "Face recognition unavailable" — never which
 * backend is loaded, because there is nothing they could do with that. An
 * admin additionally gets the provider and version as diagnostics.
 *
 * What neither audience gets is a nicer name for something that does not
 * work. The mock backend cannot identify anybody, and every string here that
 * describes it says so in those words.
 */

import type { IdentificationStatus } from "@attendance/shared-types";

/** The model the service reports, as the capture/review screens see it. */
export interface RecognitionModelState {
  modelName: string;
  modelVersion: string;
  productionEligible: boolean;
  /** Gallery providers only (Azure AI Face): whether the provider currently
   * allows identification. Absent for embedding backends and older rows. */
  identification?: IdentificationStatus;
}

export type RecognitionAvailability =
  /** A production-approved model. Results are still suggestions. */
  | "ready"
  /** A real model that has not been approved for production use. */
  | "not_approved"
  /** A real provider that detects faces but may not identify them yet —
   * Azure Face before Limited Access is granted, or while it is unreachable. */
  | "identification_pending"
  /** The test stand-in: it produces vectors, not identifications. */
  | "unavailable";

/** The name the face-ai service reports for its test stand-in. Matched, not
 * renamed: the product must be able to tell when that is what is running. */
const TEST_STAND_IN_MODEL = "mock";

export function recognitionAvailability(model: RecognitionModelState): RecognitionAvailability {
  if (model.modelName === TEST_STAND_IN_MODEL) return "unavailable";
  if (
    model.identification !== undefined &&
    model.identification !== "enabled" &&
    model.identification !== "not_applicable"
  ) {
    return "identification_pending";
  }
  return model.productionEligible ? "ready" : "not_approved";
}

export interface AvailabilityMessage {
  availability: RecognitionAvailability;
  headline: string;
  detail: string;
  /** Provider and version, for admins only. Null for everyone else. */
  diagnostics: string | null;
}

export function describeRecognitionAvailability(
  model: RecognitionModelState,
  opts: { showDiagnostics: boolean },
): AvailabilityMessage {
  const availability = recognitionAvailability(model);
  const diagnostics = opts.showDiagnostics
    ? `Provider: ${model.modelName} · ${model.modelVersion} · ${
        model.productionEligible ? "production-approved" : "not production-approved"
      }${model.identification ? ` · identification ${model.identification.replace("_", " ")}` : ""}`
    : null;
  switch (availability) {
    case "ready":
      return {
        availability,
        headline: "Face recognition ready",
        detail: "Recognition results require confirmation. Nothing counts until you confirm it.",
        diagnostics,
      };
    case "not_approved":
      return {
        availability,
        headline: "Recognition results require confirmation",
        detail:
          "Faces are compared for real, but the recognition model is not approved for production use. Treat every match as a suggestion and confirm each student yourself.",
        diagnostics,
      };
    case "identification_pending":
      // "not_approved" is Microsoft's Limited Access gate and lasts until they
      // decide; anything else is the provider being unreachable right now.
      return model.identification === "not_approved"
        ? {
            availability,
            headline: "Face identification is awaiting Azure approval",
            detail:
              "Faces in the photo are detected and counted for real, but Microsoft has not yet approved face identification for this system, so nobody is matched. Nobody is marked present or absent automatically: decide every student yourself.",
            diagnostics,
          }
        : {
            availability,
            headline: "Face identification is temporarily unavailable",
            detail:
              "Faces in the photo are detected and counted, but the identification service could not be reached, so nobody is matched. Nobody is marked present or absent automatically: decide every student yourself.",
            diagnostics,
          };
    case "unavailable":
      return {
        availability,
        headline: "Face recognition unavailable",
        detail:
          "Real face identification is not available on this system: it is running a test stand-in that cannot tell one real face from another. Face counts are real; any student match is not. Decide every student yourself.",
        diagnostics,
      };
  }
}

// ---------------------------------------------------------------------------
// Counts and per-student labels
// ---------------------------------------------------------------------------

export interface RecognitionCounts {
  present: number;
  review: number;
  notDetected: number;
  unknownFaces: number;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 Present suggestions / 2 Need review / 1 Not detected / 0 Unknown faces". */
export function recognitionCountLabels(c: RecognitionCounts): {
  present: string;
  review: string;
  notDetected: string;
  unknownFaces: string;
} {
  return {
    present: plural(c.present, "Present suggestion", "Present suggestions"),
    review: `${c.review} ${c.review === 1 ? "Needs review" : "Need review"}`,
    notDetected: `${c.notDetected} Not detected`,
    unknownFaces: plural(c.unknownFaces, "Unknown face", "Unknown faces"),
  };
}

export function percent(similarity: number | null): string | null {
  if (similarity === null || !Number.isFinite(similarity)) return null;
  return `${Math.round(Math.max(0, Math.min(1, similarity)) * 100)}%`;
}

/**
 * The one-line result shown beside a student on the review board.
 *
 *   "Present — 91%"      a confident, unconfirmed suggestion
 *   "Needs review — 58%" matched, but not confidently enough to suggest
 *   "Face too small"     their face was found, but too small to trust
 *   "No reliable match"  compared, and nobody in the photos was them
 *
 * Returns null when recognition has nothing to say about the student
 * (no template, recognition did not run, already decided by a person); the
 * caller's own reason text covers those.
 */
export function studentResultLabel(args: {
  /** The row's `aiSuggestion`; only `"PRESENT"` is read. */
  suggestion: string | null;
  aiResult: string;
  aiConfidence: number | null;
  reason: string | null;
}): string | null {
  const pct = percent(args.aiConfidence);
  if (args.reason === "face_too_small") return "Face too small";
  if (args.suggestion === "PRESENT") return pct ? `Present — ${pct}` : "Present";
  if (args.aiResult === "NEEDS_REVIEW") return pct ? `Needs review — ${pct}` : "Needs review";
  if (args.reason === "no_match") return "No reliable match";
  return null;
}
