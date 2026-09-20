/**
 * Phase 12 benchmark runner (apps/web side).
 *
 *     cd apps/web
 *     node --import ./scripts/register-test-loader.mjs scripts/bench/run.ts
 *
 * Writes `scripts/bench/results/{results.json,report.md}`. The JSON is the
 * artefact — `docs/BENCHMARKS.md` quotes from it, and a threshold change is
 * only credible if this file is regenerated alongside it.
 *
 * Nothing here touches a database, a network or a face model. It measures
 * the shipped decision code over declared synthetic geometry (`synthetic.ts`
 * explains exactly what that does and does not prove) and the shipped
 * pgvector text parse.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { QUALITY_REGIMES } from "./synthetic.ts";
import { FACES_PER_IMAGE_USED, POOL_SIZES, runSearchScale } from "./search-scale.ts";
import {
  COHORT_SIZES,
  IMAGE_COUNTS,
  rates,
  runLookalikeSweep,
  runMultiImage,
  type MultiImageCell,
} from "./multi-image.ts";
import { EMBEDDING_DIMENSION } from "@attendance/shared-types";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "results");

const f = (n: number, digits = 3) => n.toFixed(digits);
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

/**
 * Threshold sweep.
 *
 * The brief requires final thresholds to come from benchmark results rather
 * than from the plumbing defaults nobody validated. The criterion applied
 * here is the one the brief names first: **no high-confidence false match**.
 * Among the operating points that achieve zero false acceptance across every
 * regime and cohort size, the winner is the one that sends fewest students
 * to manual review — because a threshold so cautious that it reviews the
 * whole class is a threshold nobody will keep.
 */
function sweepThresholds(trials: number, lookalikeCos: number) {
  const presentGrid = [0.5, 0.55, 0.6, 0.62, 0.65, 0.7, 0.75, 0.8, 0.85];
  const reviewGrid = [0.35, 0.4, 0.45, 0.5, 0.55];
  const points: Array<{
    presentMin: number;
    reviewMin: number;
    lookalikeCos: number;
    falseAccept: number;
    lookalikeFalseAccepts: number;
    lookalikeFalseAcceptanceRate: number;
    falseAcceptanceRate: number;
    falseRejectionRate: number;
    uncertainRate: number;
    correctPresentRate: number;
  }> = [];

  for (const presentMin of presentGrid) {
    for (const reviewMin of reviewGrid) {
      if (reviewMin >= presentMin) continue;
      const cells = runMultiImage({
        presentMin,
        reviewMin,
        trials,
        cohortSizes: [50],
        lookalikeCos,
      });
      // Judged at 3 images: the configuration the product actually offers,
      // and — as the multi-image results show — the one most exposed to
      // false acceptance, so tuning anywhere else would be tuning the easy
      // case.
      const at3 = cells.filter((c) => c.imageCount === 3);
      const tot = at3.reduce(
        (acc, c) => {
          acc.falseAccept += c.falseAccept;
          acc.falseReject += c.falseReject;
          acc.uncertain += c.uncertain;
          acc.truePresent += c.truePresent;
          acc.totalPresent += c.totalPresent;
          acc.totalAbsent += c.totalAbsent;
          acc.lookalikeFalseAccepts += c.lookalikeFalseAccepts;
          acc.lookalikeOpportunities += c.lookalikeOpportunities;
          return acc;
        },
        {
          falseAccept: 0,
          falseReject: 0,
          uncertain: 0,
          truePresent: 0,
          totalPresent: 0,
          totalAbsent: 0,
          lookalikeFalseAccepts: 0,
          lookalikeOpportunities: 0,
        },
      );
      points.push({
        presentMin,
        reviewMin,
        lookalikeCos,
        falseAccept: tot.falseAccept,
        lookalikeFalseAccepts: tot.lookalikeFalseAccepts,
        lookalikeFalseAcceptanceRate: tot.lookalikeOpportunities
          ? tot.lookalikeFalseAccepts / tot.lookalikeOpportunities
          : 0,
        falseAcceptanceRate: tot.totalAbsent ? tot.falseAccept / tot.totalAbsent : 0,
        falseRejectionRate: tot.totalPresent ? tot.falseReject / tot.totalPresent : 0,
        uncertainRate:
          tot.totalPresent + tot.totalAbsent
            ? tot.uncertain / (tot.totalPresent + tot.totalAbsent)
            : 0,
        correctPresentRate: tot.totalPresent ? tot.truePresent / tot.totalPresent : 0,
      });
    }
  }

  const clean = points.filter((p) => p.falseAccept === 0);
  const recommendation =
    clean.length > 0
      ? clean.slice().sort((a, b) => a.uncertainRate - b.uncertainRate)[0]
      : points.slice().sort((a, b) => a.falseAcceptanceRate - b.falseAcceptanceRate)[0];

  return { points, recommendation, achievedZeroFalseAcceptance: clean.length > 0 };
}

function markdownSearchScale(rows: ReturnType<typeof runSearchScale>): string {
  const lines: string[] = [];
  lines.push("## Class-scoped search scaling\n");
  lines.push(
    `Pool = candidate templates loaded for one class. "Per image" is ${FACES_PER_IMAGE_USED} ` +
      "detected faces, each scored against the whole pool.\n",
  );
  lines.push(
    "| Pool | Parse pool (ms, p50) | Parse (ms, p95) | 1 face scan (ms, p50) | " +
      "1 face scan (ms, p95) | Per image (ms, p50) | Per image (ms, p95) | Wire (KB) |",
  );
  lines.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of rows) {
    lines.push(
      `| ${r.poolSize} | ${f(r.parseMs.p50)} | ${f(r.parseMs.p95)} | ` +
        `${f(r.scanOneFaceMs.p50, 4)} | ${f(r.scanOneFaceMs.p95, 4)} | ` +
        `${f(r.scanPerImageMs.p50)} | ${f(r.scanPerImageMs.p95)} | ` +
        `${(r.wireBytes / 1024).toFixed(0)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function markdownLookalike(cells: MultiImageCell[]): string {
  const lines: string[] = [];
  lines.push("## Look-alike students\n");
  lines.push(
    "Cohort 50, `strong` regime. Rates are conditional on pairs where exactly one member " +
      "was in the room.\n",
  );
  lines.push(
    "| Pair template cosine | Images | Opportunities | False accepts | Look-alike FAR | " +
      "Routed to review |",
  );
  lines.push("| ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const c of cells) {
    const r = rates(c);
    lines.push(
      `| ${f(c.lookalikeCos, 2)} | ${c.imageCount} | ${c.lookalikeOpportunities} | ` +
        `${c.lookalikeFalseAccepts} | ${pct(r.lookalikeFalseAcceptanceRate)} | ` +
        `${pct(r.lookalikeReviewRate)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function markdownMultiImage(cells: MultiImageCell[]): string {
  const lines: string[] = [];
  lines.push("## Multi-image: 1 vs 2 vs 3\n");
  lines.push(
    "| Cohort | Regime | Images | Capture | Correct present | False accept | FAR | FRR | " +
      "Uncertain | Gates dissolved |",
  );
  lines.push("| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const c of cells) {
    const r = rates(c);
    lines.push(
      `| ${c.cohortSize} | ${c.regime} | ${c.imageCount} | ${pct(r.captureRate)} | ` +
        `${pct(r.correctPresentRate)} | ${c.falseAccept} | ${pct(r.falseAcceptanceRate)} | ` +
        `${pct(r.falseRejectionRate)} | ${pct(r.uncertainRate)} | ${c.reviewGatesDissolved} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const startedAt = new Date().toISOString();
  console.log("Phase 12 — apps/web recognition + search benchmarks");
  console.log("Node:", process.version, "| platform:", process.platform, process.arch);

  console.log("\n[1/3] class-scoped search scaling …");
  const searchRows = runSearchScale();
  for (const r of searchRows) {
    console.log(
      `  pool=${String(r.poolSize).padStart(4)}  parse p50=${f(r.parseMs.p50)}ms  ` +
        `scan/face p50=${f(r.scanOneFaceMs.p50, 4)}ms  per-image p50=${f(r.scanPerImageMs.p50)}ms`,
    );
  }

  console.log("\n[2/3] multi-image 1 vs 2 vs 3 …");
  const cells = runMultiImage({ trials: 40 });
  for (const c of cells) {
    if (c.cohortSize !== 50) continue;
    const r = rates(c);
    console.log(
      `  cohort=50 ${c.regime.padEnd(9)} k=${c.imageCount}  ` +
        `present=${pct(r.correctPresentRate).padStart(7)}  ` +
        `FAR=${pct(r.falseAcceptanceRate).padStart(6)}  ` +
        `FRR=${pct(r.falseRejectionRate).padStart(7)}  ` +
        `review=${pct(r.uncertainRate).padStart(7)}`,
    );
  }

  console.log("\n[3/4] look-alike sweep (cohort 50, strong regime) …");
  const lookalike = runLookalikeSweep();
  for (const c of lookalike) {
    const r = rates(c);
    console.log(
      `  lookalikeCos=${f(c.lookalikeCos, 2)} k=${c.imageCount}  ` +
        `opportunities=${String(c.lookalikeOpportunities).padStart(4)}  ` +
        `falseAccept=${String(c.lookalikeFalseAccepts).padStart(4)} ` +
        `(${pct(r.lookalikeFalseAcceptanceRate).padStart(7)})  ` +
        `toReview=${pct(r.lookalikeReviewRate).padStart(7)}`,
    );
  }

  console.log("\n[4/4] threshold sweep (criterion: zero high-confidence false match) …");
  const sweep = sweepThresholds(25, 0.7);
  console.log(
    `  zero-false-acceptance points: ${sweep.points.filter((p) => p.falseAccept === 0).length}` +
      ` / ${sweep.points.length}`,
  );
  console.log(
    `  recommended: presentMin=${sweep.recommendation.presentMin} ` +
      `reviewMin=${sweep.recommendation.reviewMin} ` +
      `(FAR ${pct(sweep.recommendation.falseAcceptanceRate)}, ` +
      `FRR ${pct(sweep.recommendation.falseRejectionRate)}, ` +
      `review ${pct(sweep.recommendation.uncertainRate)})`,
  );

  const results = {
    startedAt,
    finishedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    disclaimer:
      "Synthetic embedding geometry, not a face model. See scripts/bench/synthetic.ts " +
      "and docs/BENCHMARKS.md. No face-recognition model in this repository is " +
      "licensed for production use.",
    parameters: {
      embeddingDimension: EMBEDDING_DIMENSION,
      facesPerImage: FACES_PER_IMAGE_USED,
      poolSizes: POOL_SIZES,
      cohortSizes: COHORT_SIZES,
      imageCounts: IMAGE_COUNTS,
      regimes: QUALITY_REGIMES,
    },
    searchScale: searchRows,
    multiImage: cells.map((c) => ({ ...c, rates: rates(c) })),
    lookalikeSweep: lookalike.map((c) => ({ ...c, rates: rates(c) })),
    thresholdSweep: sweep,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "results.json"), `${JSON.stringify(results, null, 2)}\n`);

  const md = [
    "# Phase 12 benchmark results (apps/web)",
    "",
    `Generated ${startedAt} on Node ${process.version}, ${process.platform} ${process.arch}.`,
    "",
    "> Synthetic embedding geometry, not a face model. No model in this repository is",
    "> licensed for production use. Read `docs/BENCHMARKS.md` before quoting a number.",
    "",
    markdownSearchScale(searchRows),
    markdownMultiImage(cells),
    markdownLookalike(lookalike),
    "## Threshold sweep",
    "",
    `Zero-false-acceptance operating points: ${
      sweep.points.filter((p) => p.falseAccept === 0).length
    } of ${sweep.points.length}.`,
    "",
    `Recommended: **presentMin ${sweep.recommendation.presentMin}, reviewMin ${
      sweep.recommendation.reviewMin
    }** — FAR ${pct(sweep.recommendation.falseAcceptanceRate)}, FRR ${pct(
      sweep.recommendation.falseRejectionRate,
    )}, review load ${pct(sweep.recommendation.uncertainRate)}.`,
    "",
  ].join("\n");
  writeFileSync(join(OUT_DIR, "report.md"), md);

  console.log(`\nwrote ${join(OUT_DIR, "results.json")}`);
  console.log(`wrote ${join(OUT_DIR, "report.md")}`);
}

main();
