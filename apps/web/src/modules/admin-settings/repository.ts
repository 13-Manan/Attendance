import { prisma } from "@/lib/prisma";
import type { Institution } from "@/modules/institutions/types";

/**
 * Data access for administrator-configurable settings.
 *
 * Thin by convention: every decision about whether a value may be written is
 * in `service.ts`, and every decision about what a value *means* is in
 * `policy.ts`. This file knows how to read one row and write one column.
 *
 * `getInstitutionSettings` returns the raw Json rather than a parsed shape on
 * purpose — the write path has to merge into whatever is actually stored,
 * including keys this module has never heard of, and a parsed copy would
 * silently drop them. `modules/privacy/repository.ts` and
 * `modules/integrations/repository.ts` each hold a near-identical pair for the
 * same reason; three small copies beat one shared helper that every module
 * with a settings bucket has to import from a neighbour it otherwise does not
 * depend on.
 */

export function getInstitutionSettings(
  institutionId: string,
): Promise<{ id: string; settings: unknown } | null> {
  return prisma.institution.findUnique({
    where: { id: institutionId },
    select: { id: true, settings: true },
  });
}

export async function writeInstitutionSettings(
  institutionId: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await prisma.institution.update({
    where: { id: institutionId },
    data: { settings: settings as never },
  });
}

export function getInstitution(institutionId: string): Promise<Institution | null> {
  return prisma.institution.findUnique({ where: { id: institutionId } });
}
