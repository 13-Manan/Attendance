// Run via `npm run prisma:seed --workspace=web` or automatically after
// `prisma migrate dev` (wired via the "prisma.seed" key in package.json).
// Requires a reachable DATABASE_URL — cannot be executed in an environment
// without Postgres (see README's "cannot run here" verification notes).
//
// This creates the platform roles and their permission grants and nothing
// else: no institution, no user, no student, no face template. Demo tenants
// and rosters live in scripts/dev-fixture.ts, which refuses to run anywhere
// but localhost.
//
// The logic itself is in src/modules/authorization/bootstrap.ts so that this
// seed and the production bootstrap (scripts/bootstrap-production.ts) share
// one implementation and one permission catalog. This file is a thin
// development-facing wrapper: it is deliberately absent from the production
// migration image (see apps/web/Dockerfile.migrate), so production reaches the
// same code through the bootstrap script instead.
import { PrismaClient } from "@prisma/client";
import { runSystemBootstrap } from "../src/modules/authorization/bootstrap.ts";

const prisma = new PrismaClient();

async function main() {
  const result = await runSystemBootstrap(prisma);
  for (const role of result.roles) {
    console.log(`Seeded role ${role.key} with ${role.permissionCount} permissions`);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
