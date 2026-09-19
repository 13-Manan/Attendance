import { EMBEDDING_DIMENSION } from "@attendance/shared-types";

/**
 * What enrollment is allowed to do, as pure functions.
 *
 * No Prisma, no session, no network. Every decision that could put the wrong
 * face against a student's name, or let a student enrol where the institution
 * has not permitted it, is made here so it can be asserted directly rather
 * than inferred from the behaviour of a service that also writes to a
 * database.
 *
 * The service is the only caller. It is deliberately thin over this file: a
 * rule that lives inside an `await` chain is a rule nobody can test in
 * isolation, and these are the rules that matter most.
 */

// ---------------------------------------------------------------------------
// How many templates a student may hold
// ---------------------------------------------------------------------------

/**
 * Active templates per student.
 *
 * Several samples genuinely help — a student photographed once in bad light is
 * a student the model struggles with all term — but every extra template is
 * another vector every classroom search compares against, and false acceptance
 * grows with the size of that pool. Five is enough to cover glasses, a
 * haircut and two lighting conditions without doubling the search space.
 *
 * Reaching the cap is not an error. It means the next enrollment has to be a
 * replacement, which is a decision somebody should make deliberately rather
 * than a sixth sample they did not know they were adding.
 */
export const MAX_SAMPLES_PER_STUDENT = 5;

// ---------------------------------------------------------------------------
// Embedding normalisation
// ---------------------------------------------------------------------------

/**
 * How far from unit length a vector may be and still be called normalised.
 *
 * Summing 512 squared float32 values accumulates error, so an exact `=== 1` is
 * not achievable even from a backend doing everything right. 1e-3 is orders of
 * magnitude above that accumulation and orders of magnitude below any real
 * mistake — a backend that forgot to normalise returns a norm in the tens or
 * hundreds, not 1.0004.
 */
export const EMBEDDING_NORM_TOLERANCE = 1e-3;

export type EmbeddingRejection =
  | { ok: true }
  | { ok: false; problem: "wrong_dimension"; detail: string }
  | { ok: false; problem: "not_finite"; detail: string }
  | { ok: false; problem: "not_normalised"; detail: string };

/**
 * Checks the two promises the model contract makes about a vector.
 *
 * `FaceModelProvider` in services/face-ai documents that every embedding is
 * exactly `EMBEDDING_DIMENSION` long and L2-normalised, and every comparison
 * downstream relies on it: cosine similarity is computed as a dot product, so
 * an un-normalised vector does not produce a slightly wrong score — it
 * produces a score on a different scale, which every threshold in the product
 * then misreads.
 *
 * Checked here rather than trusted because the contract is enforced on the
 * other side of an HTTP boundary, by code that a future model swap replaces.
 * The cost is one pass over 512 floats at enrollment time; the failure it
 * catches is silent, permanent and affects every register taken afterwards.
 */
export function inspectEmbedding(embedding: readonly number[]): EmbeddingRejection {
  if (embedding.length !== EMBEDDING_DIMENSION) {
    return {
      ok: false,
      problem: "wrong_dimension",
      detail: `expected ${EMBEDDING_DIMENSION} dimensions, received ${embedding.length}`,
    };
  }

  let sumOfSquares = 0;
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      return {
        ok: false,
        problem: "not_finite",
        detail: "the vector contains a NaN or an infinity",
      };
    }
    sumOfSquares += value * value;
  }

  const norm = Math.sqrt(sumOfSquares);
  if (Math.abs(norm - 1) > EMBEDDING_NORM_TOLERANCE) {
    return {
      ok: false,
      problem: "not_normalised",
      detail: `L2 norm is ${norm.toFixed(6)}, expected 1 ± ${EMBEDDING_NORM_TOLERANCE}`,
    };
  }

  return { ok: true };
}

/**
 * Cosine similarity of two unit vectors, which is their dot product.
 *
 * Both arguments have passed `inspectEmbedding`, so the normalisation this
 * relies on is a checked fact rather than an assumption. Mirrors
 * `cosine_similarity` in services/face-ai/app/matching.py — the same number
 * has to come out of both, or a template that enrollment called distinct would
 * be a match at attendance time.
 */
export function similarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    total += a[index] * b[index];
  }
  // Clamped because accumulated float error can put an identical pair a hair
  // above 1, and a similarity of 1.0000000002 reads as a bug in a log line.
  return Math.min(1, Math.max(-1, total));
}

// ---------------------------------------------------------------------------
// Duplicate and ambiguous enrollment
// ---------------------------------------------------------------------------

export interface NeighbourTemplate {
  embeddingId: string;
  studentId: string;
  similarity: number;
}

/**
 * Above this, a new capture is the *same photograph* of the student, not a
 * second sample of them.
 *
 * Two genuine captures of one person minutes apart still differ — expression,
 * head angle, sensor noise — and land well below this. A value this high is
 * reached by re-submitting bytes that already produced a template, which
 * spends one of five sample slots on a vector the search already has.
 *
 * It is not a refusal on safety grounds, and it is reported differently from a
 * collision with another student: nothing is wrong with the face, there is
 * simply nothing to gain from storing it twice.
 */
export const SAME_TEMPLATE_SIMILARITY = 0.99;

export type EnrollmentCollision =
  | { kind: "none" }
  /** The same face is already stored for this student. */
  | { kind: "already_enrolled"; embeddingId: string; similarity: number }
  /** Recognition would confidently call this face a different student. */
  | { kind: "belongs_to_other_student"; studentId: string; embeddingId: string; similarity: number }
  /** Recognition would not be sure which of the two students this is. */
  | { kind: "ambiguous_with_other_student"; studentId: string; embeddingId: string; similarity: number };

/**
 * Decides whether a new template may be stored against a student.
 *
 * ## Why the recognition engine's own thresholds
 *
 * The question this answers is not "are these two faces similar" in the
 * abstract — it is "would the attendance pipeline confuse these two people".
 * Only the pipeline's configured thresholds answer that. A separate,
 * independently tuned enrollment threshold could pass a pair that the engine
 * goes on to confuse every morning, and the institution would have configured
 * both numbers believing they were consistent.
 *
 * So: at or above `presentMin`, the engine would call this face that other
 * student with confidence, and storing it here makes at least one of the two
 * unmatchable. Between `reviewMin` and `presentMin` the engine would send it
 * to a human every session, which is an attendance register that never settles.
 * Both are refused at the point the problem is cheap to fix — while somebody is
 * still standing at the camera.
 *
 * ## Order of precedence
 *
 * A collision with another student outranks a duplicate of this student's own
 * face. If a capture is both nearly identical to an existing sample of this
 * student *and* a confident match for somebody else, the second fact is the
 * one that needs acting on, and reporting "you already enrolled that" would
 * hide it.
 *
 * ## What is not a collision
 *
 * Matching this student's own existing templates at any similarity below
 * `SAME_TEMPLATE_SIMILARITY`. That is what a correct second sample looks like,
 * and refusing it would mean a student could only ever be enrolled once.
 */
export function classifyEnrollmentCollision(
  neighbours: readonly NeighbourTemplate[],
  targetStudentId: string,
  thresholds: { presentMin: number; reviewMin: number },
): EnrollmentCollision {
  let strongestOther: NeighbourTemplate | null = null;
  let strongestOwn: NeighbourTemplate | null = null;

  for (const neighbour of neighbours) {
    const bucket = neighbour.studentId === targetStudentId ? "own" : "other";
    if (bucket === "other") {
      if (!strongestOther || neighbour.similarity > strongestOther.similarity) {
        strongestOther = neighbour;
      }
    } else if (!strongestOwn || neighbour.similarity > strongestOwn.similarity) {
      strongestOwn = neighbour;
    }
  }

  if (strongestOther) {
    if (strongestOther.similarity >= thresholds.presentMin) {
      return {
        kind: "belongs_to_other_student",
        studentId: strongestOther.studentId,
        embeddingId: strongestOther.embeddingId,
        similarity: strongestOther.similarity,
      };
    }
    if (strongestOther.similarity >= thresholds.reviewMin) {
      return {
        kind: "ambiguous_with_other_student",
        studentId: strongestOther.studentId,
        embeddingId: strongestOther.embeddingId,
        similarity: strongestOther.similarity,
      };
    }
  }

  if (strongestOwn && strongestOwn.similarity >= SAME_TEMPLATE_SIMILARITY) {
    return {
      kind: "already_enrolled",
      embeddingId: strongestOwn.embeddingId,
      similarity: strongestOwn.similarity,
    };
  }

  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Self-enrollment
// ---------------------------------------------------------------------------

/** `Institution.settings` key for the enrollment-channel policy. */
export const FACE_ENROLLMENT_SETTINGS_KEY = "faceEnrollmentPolicy";

export interface FaceEnrollmentPolicySettings {
  /**
   * Whether a student may enrol their own face from the student portal.
   *
   * Unset means "use the default for this institution type" rather than
   * `false`, so an institution that has never opened the settings page behaves
   * the way its type implies instead of having the feature silently off.
   */
  selfEnrollmentEnabled?: boolean;
}

/**
 * The default, by institution type.
 *
 * A college student has a device, an account and a reason to be trusted with
 * their own enrolment. A school pupil typically has none of the three, and the
 * school workflow is a member of staff with a tablet and the pupil in front of
 * them — which is also the workflow where consent is actually obtained. So
 * colleges default on and schools default off, and either can say otherwise.
 *
 * Mirrors how `resolveAttendanceMode` derives daily-versus-subject attendance:
 * the type sets the default, settings decide.
 */
export function defaultSelfEnrollmentEnabled(institutionType: string): boolean {
  return institutionType === "COLLEGE";
}

/**
 * Whether this institution permits student self-enrollment.
 *
 * Takes the two fields it reads rather than a Prisma `Institution`, so it
 * stays pure and so a caller cannot pass a row from the wrong tenant by
 * passing a whole object nobody looked at.
 */
export function resolveSelfEnrollmentEnabled(institution: {
  type: string;
  settings: unknown;
}): boolean {
  const settings = (institution.settings ?? {}) as Record<string, unknown>;
  const policy = settings[FACE_ENROLLMENT_SETTINGS_KEY] as
    | FaceEnrollmentPolicySettings
    | undefined;
  if (typeof policy?.selfEnrollmentEnabled === "boolean") {
    return policy.selfEnrollmentEnabled;
  }
  return defaultSelfEnrollmentEnabled(institution.type);
}

// ---------------------------------------------------------------------------
// Enrollment status
// ---------------------------------------------------------------------------

export interface TemplateModel {
  modelName: string;
  modelVersion: string;
}

/**
 * Whether the recognition pipeline can actually recognise this student.
 *
 * Three states, because "has a template" and "has a template that works" are
 * different facts and only the second one decides whether a register fills
 * itself. A template produced by a model the deployment no longer runs is
 * filtered out of every candidate search — it is stored, it is visible, and it
 * will never match.
 */
export type FaceEnrollmentStatus =
  | "NOT_ENROLLED"
  | "ENROLLED"
  /** Templates exist, but none were made by the model now running. */
  | "NEEDS_REENROLLMENT";

export interface FaceEnrollmentStatusSummary {
  status: FaceEnrollmentStatus;
  /** Active templates the running model can compare against. */
  usableSamples: number;
  /** Active templates from some other model. Stored, shown, never matched. */
  staleSamples: number;
  /** How many more samples may be added before a replacement is required. */
  remainingSlots: number;
  /**
   * True when the running model could not be determined — the service was
   * unreachable, or the deployment has not been asked. Staleness is unknown
   * rather than false, and the UI must say so instead of implying everything
   * is fine.
   */
  modelUnknown: boolean;
}

/**
 * Derives the status from a student's active templates and the running model.
 *
 * `runningModel` is nullable on purpose. When the face service cannot be
 * reached, every template's comparability is unknown — and answering
 * "NEEDS_REENROLLMENT" would tell an administrator to re-photograph a whole
 * school because a health check timed out. Unknown is reported as unknown, the
 * samples are counted as usable, and the caller shows the caveat.
 */
export function summariseEnrollmentStatus(
  activeTemplates: readonly TemplateModel[],
  runningModel: TemplateModel | null,
): FaceEnrollmentStatusSummary {
  const total = activeTemplates.length;
  const remainingSlots = Math.max(0, MAX_SAMPLES_PER_STUDENT - total);

  if (total === 0) {
    return {
      status: "NOT_ENROLLED",
      usableSamples: 0,
      staleSamples: 0,
      remainingSlots,
      modelUnknown: runningModel === null,
    };
  }

  if (runningModel === null) {
    return {
      status: "ENROLLED",
      usableSamples: total,
      staleSamples: 0,
      remainingSlots,
      modelUnknown: true,
    };
  }

  const usableSamples = activeTemplates.filter(
    (template) =>
      template.modelName === runningModel.modelName &&
      template.modelVersion === runningModel.modelVersion,
  ).length;

  return {
    status: usableSamples > 0 ? "ENROLLED" : "NEEDS_REENROLLMENT",
    usableSamples,
    staleSamples: total - usableSamples,
    remainingSlots,
    modelUnknown: false,
  };
}
