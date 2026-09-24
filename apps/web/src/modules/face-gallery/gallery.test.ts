import { test } from "node:test";
import assert from "node:assert/strict";
import type { GalleryRemoveRequest } from "@attendance/shared-types";
import {
  GALLERY_CANDIDATE_FLOOR,
  GALLERY_RECOGNITION_THRESHOLDS,
  galleryIdForCohort,
  identificationEnabled,
  isGalleryModel,
  planGalleryRemovals,
  type PlacementRow,
} from "./policy.ts";
import { releaseGalleryFaces } from "./service.ts";

/**
 * Gallery bookkeeping: which provider-side faces go when a sample retires,
 * and what happens when the provider cannot be reached. No network: every
 * provider answer is a fixture.
 */

function row(id: string, personId: string, active: boolean, galleryId = "att-co1"): PlacementRow {
  return { id, galleryId, personId, persistedFaceId: `face-${id}`, active };
}

test("one gallery per class, in the provider's id alphabet", () => {
  assert.equal(galleryIdForCohort("clx9abc"), "att-clx9abc");
  assert.equal(galleryIdForCohort("CLX9ABC"), "att-clx9abc");
  assert.throws(() => galleryIdForCohort("a/b"), /invalid_gallery_id/);
  assert.throws(() => galleryIdForCohort("x".repeat(80)), /invalid_gallery_id/);
});

test("the candidate floor sits under the review band, so a runner-up is still seen", () => {
  assert.ok(GALLERY_CANDIDATE_FLOOR < GALLERY_RECOGNITION_THRESHOLDS.reviewMin);
  assert.ok(GALLERY_RECOGNITION_THRESHOLDS.reviewMin < GALLERY_RECOGNITION_THRESHOLDS.presentMin);
});

test("template kind and identification status are read conservatively", () => {
  assert.equal(isGalleryModel({ templateKind: "gallery" }), true);
  assert.equal(isGalleryModel({ templateKind: "embedding" }), false);
  assert.equal(isGalleryModel({}), false);
  assert.equal(identificationEnabled(undefined), true);
  assert.equal(identificationEnabled("not_applicable"), true);
  assert.equal(identificationEnabled("enabled"), true);
  assert.equal(identificationEnabled("not_approved"), false);
  assert.equal(identificationEnabled("unavailable"), false);
});

test("a person keeping an active sample loses only the retired faces", () => {
  const all = [row("p1", "person-a", false), row("p2", "person-a", true)];
  const plan = planGalleryRemovals(all, new Set(["p1"]));
  assert.deepEqual(plan.removals, [
    { galleryId: "att-co1", personId: "person-a", persistedFaceId: "face-p1" },
  ]);
  assert.deepEqual(plan.placementIdsByRemoval, [["p1"]]);
});

test("a person left with no active sample is removed whole, with every row", () => {
  const all = [
    row("p1", "person-a", false),
    row("p2", "person-a", false), // stale, not asked for
    row("p3", "person-b", true, "att-co2"),
  ];
  const plan = planGalleryRemovals(all, new Set(["p1"]));
  assert.deepEqual(plan.removals, [
    { galleryId: "att-co1", personId: "person-a", persistedFaceId: null },
  ]);
  assert.deepEqual(plan.placementIdsByRemoval, [["p1", "p2"]]);
});

test("the same person id in two galleries is two people", () => {
  const all = [row("p1", "person-a", false, "att-co1"), row("p2", "person-a", true, "att-co2")];
  const plan = planGalleryRemovals(all, new Set(["p1"]));
  assert.equal(plan.removals.length, 1);
  assert.equal(plan.removals[0].persistedFaceId, null);
  assert.equal(plan.removals[0].galleryId, "att-co1");
});

test("nothing going plans nothing", () => {
  assert.deepEqual(planGalleryRemovals([row("p1", "person-a", true)], new Set()), {
    removals: [],
    placementIdsByRemoval: [],
  });
});

function releaseHarness(rows: Array<PlacementRow & { faceEmbeddingId: string }>, failOn = new Set<number>()) {
  const requests: GalleryRemoveRequest[] = [];
  const deleted: string[][] = [];
  let call = 0;
  return {
    requests,
    deleted,
    deps: {
      listPlacementsForStudents: async () => rows,
      deletePlacements: async (_institutionId: string, ids: readonly string[]) => {
        deleted.push([...ids]);
        return ids.length;
      },
      galleryRemove: async (request: GalleryRemoveRequest) => {
        requests.push(request);
        if (failOn.has(call++)) throw new Error("face_ai_request_failed:/v1/gallery/remove:503");
        return { removed: request.removals.length };
      },
    },
  };
}

test("release by default leaves active samples alone", async () => {
  const h = releaseHarness([
    { ...row("p1", "person-a", true), faceEmbeddingId: "fe1" },
    { ...row("p2", "person-b", false), faceEmbeddingId: "fe2" },
  ]);
  const result = await releaseGalleryFaces("inst-1", ["s1"], { includeActive: false }, h.deps);
  assert.deepEqual(result, { removed: 1, pending: 0 });
  assert.equal(h.requests[0].removals[0].personId, "person-b");
  assert.deepEqual(h.deleted, [["p2"]]);
});

test("release with nothing to remove never calls the provider", async () => {
  const h = releaseHarness([{ ...row("p1", "person-a", true), faceEmbeddingId: "fe1" }]);
  const result = await releaseGalleryFaces("inst-1", ["s1"], { includeActive: false }, h.deps);
  assert.deepEqual(result, { removed: 0, pending: 0 });
  assert.equal(h.requests.length, 0);
});

test("release sends at most 100 removals per request and keeps rows of a failed chunk", async () => {
  const rows = Array.from({ length: 250 }, (_, i) => ({
    ...row(`p${i}`, `person-${i}`, true),
    faceEmbeddingId: `fe${i}`,
  }));
  const h = releaseHarness(rows, new Set([1]));
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => warnings.push(line);
  try {
    const result = await releaseGalleryFaces("inst-1", ["s1"], { includeActive: true }, h.deps);
    assert.deepEqual(result, { removed: 150, pending: 100 });
  } finally {
    console.warn = original;
  }
  assert.deepEqual(h.requests.map((r) => r.removals.length), [100, 100, 50]);
  // The failed chunk's rows survive for the next attempt.
  assert.equal(h.deleted.flat().length, 150);
  assert.ok(!h.deleted.flat().includes("p100"));
  assert.equal(warnings.length, 1);
  // Counts and the error only — no provider ids reach the log.
  assert.doesNotMatch(warnings[0], /person-|face-p/);
  assert.match(warnings[0], /"removals":100/);
});
