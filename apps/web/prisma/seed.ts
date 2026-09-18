// Run via `npm run prisma:seed --workspace=web` or automatically after
// `prisma migrate dev` (wired via the "prisma.seed" key in package.json).
// Requires a reachable DATABASE_URL — cannot be executed in an environment
// without Postgres (see README's "cannot run here" verification notes).
import { PrismaClient } from "@prisma/client";
import { SYSTEM_ROLES } from "../src/modules/authorization/permissions.ts";

const prisma = new PrismaClient();

async function main() {
  for (const roleDef of SYSTEM_ROLES) {
    // Not `upsert` on the (institutionId, key) compound unique: SQL equality
    // never matches NULL (`institutionId = NULL` is never true), so an
    // upsert keyed on that compound value can never find an existing
    // platform-wide (institutionId: null) role — it would always try to
    // create, then violate the hand-patched partial unique index
    // (docs/DATA_MODEL.md) on the second run. find-then-write instead.
    const existing = await prisma.role.findFirst({
      where: { institutionId: null, key: roleDef.key },
    });

    const role = existing
      ? await prisma.role.update({ where: { id: existing.id }, data: { name: roleDef.name } })
      : await prisma.role.create({
          data: { institutionId: null, key: roleDef.key, name: roleDef.name, isSystem: true },
        });

    // Idempotent: always converge RolePermission rows to exactly match the
    // current code catalog, so re-running the seed after editing
    // permissions.ts never leaves stale grants behind.
    await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
    await prisma.rolePermission.createMany({
      data: roleDef.permissions.map((permission) => ({ roleId: role.id, permission })),
    });

    console.log(`Seeded role ${roleDef.key} with ${roleDef.permissions.length} permissions`);
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
