import type { GalleryRemoveRequest, GalleryRemoveResponse } from "@attendance/shared-types";
import * as repo from "./repository";
import { planGalleryRemovals } from "./policy";

/**
 * Keeping the provider's galleries in step with the samples this database
 * says are live.
 *
 * Every retirement path — replace, withdraw, retention, erasure — changes the
 * `FaceEmbedding` rows first and calls this afterwards. The rows are the
 * source of truth: recognition only ever resolves a person through an
 * *active* sample, so a face the provider still holds for a retired sample
 * cannot mark anybody even before it is gone. Removal is therefore allowed to
 * fail and be retried, and a placement row survives until the provider
 * confirms the delete — which is what the next call for the same student
 * retries.
 */

/** face-ai accepts at most this many removals per request. */
const REMOVALS_PER_REQUEST = 100;

export interface GalleryRemovalDeps {
  listPlacementsForStudents?: typeof repo.listPlacementsForStudents;
  deletePlacements?: typeof repo.deletePlacements;
  galleryRemove?: (request: GalleryRemoveRequest) => Promise<GalleryRemoveResponse>;
}

export interface GalleryReleaseResult {
  /** Removals the provider confirmed. */
  removed: number;
  /** Removals that failed and will be retried on the next call. */
  pending: number;
}

/**
 * Deletes, at the provider, every face these students hold for a sample that
 * is no longer active — or, with `includeActive`, every face they hold at all
 * (erasure).
 */
export async function releaseGalleryFaces(
  institutionId: string,
  studentIds: readonly string[],
  options: { includeActive: boolean },
  deps: GalleryRemovalDeps = {},
): Promise<GalleryReleaseResult> {
  const list = deps.listPlacementsForStudents ?? repo.listPlacementsForStudents;
  const deleteRows = deps.deletePlacements ?? repo.deletePlacements;
  const remove =
    deps.galleryRemove ??
    (async (request: GalleryRemoveRequest) => {
      const { galleryRemove } = await import("@/lib/face-ai-client");
      return galleryRemove(request);
    });

  const placements = await list(institutionId, [...new Set(studentIds)]);
  const going = new Set(
    placements.filter((p) => options.includeActive || !p.active).map((p) => p.id),
  );
  if (going.size === 0) return { removed: 0, pending: 0 };

  const plan = planGalleryRemovals(placements, going);
  let removed = 0;
  let pending = 0;
  for (let start = 0; start < plan.removals.length; start += REMOVALS_PER_REQUEST) {
    const removals = plan.removals.slice(start, start + REMOVALS_PER_REQUEST);
    const rowIds = plan.placementIdsByRemoval.slice(start, start + REMOVALS_PER_REQUEST).flat();
    try {
      await remove({ removals });
      await deleteRows(institutionId, rowIds);
      removed += removals.length;
    } catch (error) {
      pending += removals.length;
      // Counts and the error only: the ids are provider-side pointers to
      // biometric templates and have no business in a log aggregator. The
      // face-ai client's messages carry a path, a status and a bare code.
      console.warn(
        JSON.stringify({
          log: "face_gallery.release_failed",
          institutionId,
          removals: removals.length,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
    }
  }
  return { removed, pending };
}
