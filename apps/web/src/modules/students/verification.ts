/**
 * Whether a student is fully set up — "verified" — computed from records that
 * already exist. Nothing is stored: there is no verification column, and a
 * student's status changes the moment the records it is read from change.
 *
 * ## The checklist
 *
 * | Item            | Complete when                                                  | Read from                    |
 * |-----------------|----------------------------------------------------------------|------------------------------|
 * | Student account | the student has a Student Portal login, and it is active      | `Student.userId` → `User`    |
 * | Student details | name and student ID on file, and placed in a class            | `Student`, `Enrollment`      |
 * | Face enrollment | an active face sample made by the model this deployment runs  | `FaceEmbedding`              |
 *
 * Face enrollment uses the rule the Face enrollment coverage page already uses
 * (modules/face-enrollment/coverage.ts): a student whose every sample came
 * from another model is exactly as unrecognisable as one with none, so they
 * are not counted as enrolled. When the running model cannot be asked, any
 * active sample counts, as it does there.
 *
 * A student who is not on roll has no verification state: they are out of
 * every register and out of recognition, and "incomplete" would ask somebody
 * to finish setting up a student who has left.
 *
 * A new requirement is a new item here — no column, no migration.
 */

export type VerificationFilter = "" | "complete" | "incomplete" | "face_pending";

export const VERIFICATION_FILTERS: ReadonlyArray<{ key: Exclude<VerificationFilter, "">; label: string }> = [
  { key: "complete", label: "Complete" },
  { key: "incomplete", label: "Incomplete" },
  { key: "face_pending", label: "Face enrollment pending" },
];

export function parseVerificationFilter(value: unknown): VerificationFilter {
  return VERIFICATION_FILTERS.some((option) => option.key === value) ? (value as VerificationFilter) : "";
}

export type FaceVerificationState =
  | "enrolled"
  | "pending"
  | "needs_reenrollment"
  | "blocked_pending_review"
  | "blocked_not_confirmed";

export interface VerificationFacts {
  onRoll: boolean;
  login: "active" | "disabled" | "none";
  /** In at least one class (an active placement). */
  placed: boolean;
  /** Active samples made by the running model — or any active sample, when it is unknown. */
  usableFaceSamples: number;
  /** Active samples made by any model. */
  activeFaceSamples: number;
  /** The student's own twin / lookalike review, if an enrollment was refused for one. */
  twinReview: "pending" | "not_confirmed" | "confirmed" | null;
  /** When the earliest usable sample was taken. */
  faceEnrolledSince: Date | null;
}

export type VerificationItemKey = "account" | "details" | "face";

export interface VerificationItem {
  key: VerificationItemKey;
  label: string;
  complete: boolean;
  detail: string;
}

export interface StudentVerification {
  overall: "complete" | "incomplete" | "off_roll";
  face: FaceVerificationState;
  items: VerificationItem[];
}

function faceState(facts: VerificationFacts): FaceVerificationState {
  if (facts.usableFaceSamples > 0) return "enrolled";
  if (facts.twinReview === "pending") return "blocked_pending_review";
  if (facts.twinReview === "not_confirmed") return "blocked_not_confirmed";
  if (facts.activeFaceSamples > 0) return "needs_reenrollment";
  return "pending";
}

const FACE_DETAIL: Record<FaceVerificationState, string> = {
  enrolled: "Face enrolled",
  pending: "Face enrollment pending",
  needs_reenrollment: "Face needs re-enrolling — its samples were made by a recognition model this deployment no longer runs",
  blocked_pending_review: "Blocked — twin/lookalike confirmation required",
  blocked_not_confirmed: "Blocked — not confirmed as different people",
};

export function computeVerification(facts: VerificationFacts): StudentVerification {
  const face = faceState(facts);
  const faceDetail =
    face === "enrolled"
      ? `${FACE_DETAIL.enrolled} · ${facts.usableFaceSamples} ${facts.usableFaceSamples === 1 ? "sample" : "samples"}`
      : face === "pending" && facts.twinReview === "confirmed"
        ? `${FACE_DETAIL.pending} — the twin/lookalike pair was confirmed, so enrollment can go ahead`
        : FACE_DETAIL[face];

  const items: VerificationItem[] = [
    {
      key: "account",
      label: "Student account",
      complete: facts.login === "active",
      detail:
        facts.login === "active"
          ? "Student Portal login active"
          : facts.login === "disabled"
            ? "Login disabled"
            : "No student login yet",
    },
    {
      key: "details",
      label: "Student details",
      complete: facts.placed,
      detail: facts.placed
        ? "Name, student ID and class on file"
        : "Not placed in a class — they will not appear on any register",
    },
    { key: "face", label: "Face enrollment", complete: face === "enrolled", detail: faceDetail },
  ];

  return {
    overall: !facts.onRoll ? "off_roll" : items.every((item) => item.complete) ? "complete" : "incomplete",
    face,
    items,
  };
}

/** The items still to do, as a short phrase for a list row. */
export function missingSummary(verification: StudentVerification): string {
  const missing = verification.items.filter((item) => !item.complete);
  return missing
    .map((item) =>
      item.key === "face"
        ? verification.face === "blocked_pending_review" || verification.face === "blocked_not_confirmed"
          ? "Face blocked — twin review"
          : verification.face === "needs_reenrollment"
            ? "Face needs re-enrolling"
            : "Face enrollment pending"
        : item.key === "account"
          ? "No active login"
          : "Not in a class",
    )
    .join(" · ");
}

// ---------------------------------------------------------------------------
// The same rules as a database filter
// ---------------------------------------------------------------------------

/** The running model, when known: a sample counts only if it was made by it. */
export type FaceModelFilter = { modelName: string; modelVersion: string } | null;

type FaceSampleMatch = { isActive: true; modelName?: string; modelVersion?: string };

/**
 * A `StudentWhereInput` fragment, written out locally so this module stays
 * pure; the repository is where the compiler checks it against Prisma.
 */
export type VerificationClause =
  | { status: "ACTIVE" }
  | { faceEmbeddings: { some: FaceSampleMatch } | { none: FaceSampleMatch } }
  | { user: { is: { status: "ACTIVE" | { not: "ACTIVE" } } } }
  | { userId: null }
  | { enrollments: { some: { status: "ACTIVE" } } | { none: { status: "ACTIVE" } } }
  | { OR: VerificationClause[] };

function usableSample(model: FaceModelFilter): FaceSampleMatch {
  return model ? { isActive: true, modelName: model.modelName, modelVersion: model.modelVersion } : { isActive: true };
}

/**
 * The checklist as SQL conditions — the same three rules as
 * `computeVerification`, so a filtered list and its badges agree. A student's
 * twin review does not appear here: a blocked student has no usable face,
 * which already makes them pending and incomplete.
 */
export function verificationClauses(filter: VerificationFilter, model: FaceModelFilter): VerificationClause[] {
  if (filter === "") return [];
  const sample = usableSample(model);
  if (filter === "face_pending") {
    return [{ status: "ACTIVE" }, { faceEmbeddings: { none: sample } }];
  }
  if (filter === "complete") {
    return [
      { status: "ACTIVE" },
      { user: { is: { status: "ACTIVE" } } },
      { enrollments: { some: { status: "ACTIVE" } } },
      { faceEmbeddings: { some: sample } },
    ];
  }
  return [
    { status: "ACTIVE" },
    {
      OR: [
        { userId: null },
        { user: { is: { status: { not: "ACTIVE" } } } },
        { enrollments: { none: { status: "ACTIVE" } } },
        { faceEmbeddings: { none: sample } },
      ],
    },
  ];
}

/** The facts for one student, from the columns a list row already selects. */
export function factsFromRow(
  row: {
    status: string;
    user: { status: string } | null;
    enrollmentCount: number;
    samples: ReadonlyArray<{ modelName: string; modelVersion: string; createdAt: Date }>;
  },
  model: FaceModelFilter,
  twinReview: VerificationFacts["twinReview"],
): VerificationFacts {
  const usable = model
    ? row.samples.filter((sample) => sample.modelName === model.modelName && sample.modelVersion === model.modelVersion)
    : row.samples;
  return {
    onRoll: row.status === "ACTIVE",
    login: row.user ? (row.user.status === "ACTIVE" ? "active" : "disabled") : "none",
    placed: row.enrollmentCount > 0,
    usableFaceSamples: usable.length,
    activeFaceSamples: row.samples.length,
    twinReview,
    faceEnrolledSince: usable.reduce<Date | null>(
      (earliest, sample) => (earliest === null || sample.createdAt < earliest ? sample.createdAt : earliest),
      null,
    ),
  };
}
