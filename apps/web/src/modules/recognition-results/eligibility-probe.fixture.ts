/**
 * Test fixture, run as its own process by
 * `modules/recognition-engine/recognition-eligibility.integration.test.ts`:
 * which students a class's candidate query returns, from a process that has
 * never seen the test's writes — the "fresh process / another replica" case.
 * Prints sorted student ids as JSON. Nothing else; never a vector.
 *
 *   node --import ./scripts/register-test-loader.mjs \
 *     src/modules/recognition-results/eligibility-probe.fixture.ts <cohortId> <modelName> <modelVersion>
 */
import { prisma } from "@/lib/prisma";
import { findCandidateEmbeddingsWithVectorsForCohort } from "./repository";

async function main(): Promise<void> {
  const [cohortId, modelName, modelVersion] = process.argv.slice(2);
  if (!cohortId || !modelName || !modelVersion) throw new Error("usage: <cohortId> <modelName> <modelVersion>");
  const rows = await findCandidateEmbeddingsWithVectorsForCohort(cohortId, { modelName, modelVersion });
  process.stdout.write(JSON.stringify([...new Set(rows.map((r) => r.studentId))].sort()));
}

main()
  .catch((error: unknown) => {
    process.stderr.write(String(error instanceof Error ? error.message : error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
