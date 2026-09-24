import type {
  GalleryRemoval,
  IdentificationStatus,
  ModelInfoResponse,
} from "@attendance/shared-types";

/**
 * Rules for gallery-backed recognition (templateKind "gallery" — Azure AI
 * Face), kept free of I/O so every one of them is testable on its own.
 *
 * ## Why these are not the institution's thresholds
 *
 * An institution's `presentMin`/`reviewMin` are cosine similarities between
 * two vectors from one embedding model. Azure's `confidence` is a different
 * number on a different scale: 0.75 there and 0.75 cosine do not mean the same
 * thing. Reusing the configured pair would silently re-interpret every
 * school's settings. So a gallery run uses its own fixed, conservative pair,
 * recorded on the run like any other policy, and changed here in code — where
 * the change is reviewed — until it has been calibrated against real classes.
 */
export const GALLERY_RECOGNITION_THRESHOLDS = {
  /** At or above: a Present *suggestion*. Still needs the teacher's confirm. */
  presentMin: 0.75,
  /** At or above: Needs review. Below: no match. */
  reviewMin: 0.5,
  /** Two students within this of each other for one face: Needs review. */
  ambiguityMargin: 0.1,
} as const;

/** Enrollment-time identity checks, in the provider's confidence units. */
export const GALLERY_ENROLLMENT_THRESHOLDS = {
  /** Another person in a target gallery at or above this: refuse. */
  otherPersonMin: 0.7,
  /** The student's own person verifying below this: refuse. */
  ownPersonMin: 0.5,
} as const;

/** Candidates asked for per face. Enough for a runner-up from another
 * student; Azure's own cap is 100, face-ai's is 10. */
export const GALLERY_MAX_CANDIDATES = 5;

/** The provider drops candidates below this. Set under `reviewMin` so the
 * ambiguity rule can still see a runner-up just outside the review band. */
export const GALLERY_CANDIDATE_FLOOR = Math.max(
  0,
  GALLERY_RECOGNITION_THRESHOLDS.reviewMin - GALLERY_RECOGNITION_THRESHOLDS.ambiguityMargin,
);

/** face-ai's pattern for a gallery id, and Azure's for a large person group. */
const GALLERY_ID = /^[a-z0-9_-]{1,64}$/;

/**
 * One gallery per class.
 *
 * The class, not the institution, because a group photo must only ever be
 * searched against the students who belong in that room — the same rule the
 * vector path enforces with its cohort-scoped loader. Cohort ids are cuids,
 * which are already lowercase alphanumerics; lowercasing is belt and braces.
 */
export function galleryIdForCohort(cohortId: string): string {
  const id = `att-${cohortId.toLowerCase()}`;
  if (!GALLERY_ID.test(id)) throw new Error("invalid_gallery_id");
  return id;
}

export function isGalleryModel(info: Pick<ModelInfoResponse, "templateKind">): boolean {
  return info.templateKind === "gallery";
}

/** Whether identification is usable right now. An older service that does
 * not report the field is an embedding service, where the question does not
 * arise. */
export function identificationEnabled(status: IdentificationStatus | undefined): boolean {
  return status === undefined || status === "enabled" || status === "not_applicable";
}

export interface PlacementRow {
  id: string;
  galleryId: string;
  personId: string;
  persistedFaceId: string;
  /** Whether the sample this placement belongs to is still active. */
  active: boolean;
}

export interface RemovalPlan {
  removals: GalleryRemoval[];
  /** Placement rows to delete once the provider confirms, per removal. */
  placementIdsByRemoval: string[][];
}

/**
 * What to delete at the provider for a set of placements that should go.
 *
 * A person whose every placement is going loses the whole person, not just
 * its faces: a person with no faces left cannot be verified against, and
 * leaving an empty one behind would make the next enrollment of the same
 * student fail its own-person check. A person keeping at least one active
 * placement loses only the faces that are going.
 */
export function planGalleryRemovals(
  all: readonly PlacementRow[],
  going: ReadonlySet<string>,
): RemovalPlan {
  const byPerson = new Map<string, PlacementRow[]>();
  for (const row of all) {
    const key = `${row.galleryId}\u0000${row.personId}`;
    const list = byPerson.get(key) ?? [];
    list.push(row);
    byPerson.set(key, list);
  }

  const removals: GalleryRemoval[] = [];
  const placementIdsByRemoval: string[][] = [];
  for (const rows of byPerson.values()) {
    const leaving = rows.filter((r) => going.has(r.id));
    if (leaving.length === 0) continue;
    const staying = rows.filter((r) => !going.has(r.id) && r.active);
    if (staying.length === 0) {
      removals.push({
        galleryId: rows[0].galleryId,
        personId: rows[0].personId,
        persistedFaceId: null,
      });
      // Every row for the person goes with it, including stale ones that were
      // not asked for: the provider no longer has anything they point at.
      placementIdsByRemoval.push(rows.map((r) => r.id));
      continue;
    }
    for (const row of leaving) {
      removals.push({
        galleryId: row.galleryId,
        personId: row.personId,
        persistedFaceId: row.persistedFaceId,
      });
      placementIdsByRemoval.push([row.id]);
    }
  }
  return { removals, placementIdsByRemoval };
}
