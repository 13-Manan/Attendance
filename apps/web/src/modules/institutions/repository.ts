import type { InstitutionType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Institution } from "./types";

export function getInstitutionById(id: string): Promise<Institution | null> {
  return prisma.institution.findUnique({ where: { id } });
}

/**
 * Just the kind, for chrome that only needs to choose a word.
 *
 * The dashboard layout runs on every staff page and needs one enum value to
 * decide whether the sidebar says "Sections" or "Programs & semesters".
 * Reading the whole row — settings JSON and all — to answer that would put the
 * institution's entire configuration on the path of every single render.
 */
export async function getInstitutionType(id: string): Promise<InstitutionType | null> {
  const row = await prisma.institution.findUnique({ where: { id }, select: { type: true } });
  return row?.type ?? null;
}
