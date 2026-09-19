import { prisma } from "@/lib/prisma";
import type { InstitutionType } from "@prisma/client";

/**
 * Reading and writing one institution's own row.
 *
 * `settings` comes back as the raw Json on purpose, for the reason recorded in
 * `modules/admin-settings/repository.ts`: the write path has to merge into
 * whatever is actually stored, including keys this module has never heard of,
 * and a parsed copy would silently drop them.
 *
 * There is no "find an institution by name" and no unscoped list here. This
 * module edits the institution the caller is already inside; a function that
 * could reach another one is not needed and so should not exist.
 */

export interface InstitutionProfileRow {
  id: string;
  name: string;
  type: InstitutionType;
  timezone: string;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine: string | null;
  settings: unknown;
}

export function getInstitutionProfile(
  institutionId: string,
): Promise<InstitutionProfileRow | null> {
  return prisma.institution.findUnique({
    where: { id: institutionId },
    select: {
      id: true,
      name: true,
      type: true,
      timezone: true,
      contactEmail: true,
      contactPhone: true,
      addressLine: true,
      settings: true,
    },
  });
}

export interface UpdateInstitutionProfileData {
  name: string;
  timezone: string;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine: string | null;
  /** The whole settings object, already merged by the service. */
  settings: Record<string, unknown>;
}

/**
 * One update, both the columns and the settings blob.
 *
 * Together rather than in two calls: a save that renamed the institution and
 * then failed to write its labels would leave a profile half of which the
 * administrator chose. `Institution.id` is the primary key and comes from the
 * session, so `update` is safe here where `updateMany` is needed elsewhere —
 * there is no second identifier for a tenant to be confused with.
 */
export async function updateInstitutionProfile(
  institutionId: string,
  data: UpdateInstitutionProfileData,
): Promise<void> {
  await prisma.institution.update({
    where: { id: institutionId },
    data: {
      name: data.name,
      timezone: data.timezone,
      contactEmail: data.contactEmail,
      contactPhone: data.contactPhone,
      addressLine: data.addressLine,
      settings: data.settings as never,
    },
  });
}
