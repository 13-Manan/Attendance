import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ApiError, invalidRequest, notFound } from "./api-route";

/**
 * External identifiers, and the rules for resolving them.
 *
 * ## The problem
 *
 * An ERP calls a student `STU-10092`. This platform calls them `cmu5dx…`.
 * Neither is wrong, and neither can be derived from the other. Until this
 * module the importer had nowhere to put the ERP's id except
 * `Student.studentCode` — the *institution's own* roll number, which is a
 * different fact, is editable by the institution, and is immediately
 * contradicted the moment a second system is integrated with its own id
 * scheme.
 *
 * ## The rule that matters most
 *
 * Two institutions using the same vendor will both have a student
 * `STU-10092`, and they are different people. Every function here takes an
 * `institutionId` resolved from the caller's credential, never from the
 * request body, and it is part of every lookup key and every unique
 * constraint. There is no function in this module that can be asked to
 * resolve an external id without saying whose it is.
 *
 * ## Why resolution re-reads the target
 *
 * `internalId` is polymorphic and therefore not a foreign key (see the model's
 * comment). A mapping row is only a claim that some id exists; the entity is
 * re-read through its own table, scoped to the same institution, before the
 * caller is told it resolved. A mapping pointing at a record from another
 * tenant — which should be impossible, and is the kind of impossible worth
 * checking — resolves to nothing rather than to that record.
 */

export const EXTERNAL_ENTITY_TYPES = ["STUDENT", "FACULTY", "COHORT", "SUBJECT"] as const;
export type ExternalEntityType = (typeof EXTERNAL_ENTITY_TYPES)[number];

export function isExternalEntityType(value: string): value is ExternalEntityType {
  return (EXTERNAL_ENTITY_TYPES as readonly string[]).includes(value);
}

/** Bounds, so one mapping row cannot become a place to store a document. */
const MAX_PROVIDER_LENGTH = 64;
const MAX_EXTERNAL_ID_LENGTH = 255;

export interface ExternalIdentityRecord {
  id: string;
  provider: string;
  entityType: ExternalEntityType;
  externalId: string;
  internalId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Normalizes and validates the parts of a mapping key.
 *
 * `provider` is lower-cased and trimmed because "ERP-X" and "erp-x" are the
 * same system typed twice, and treating them as different id spaces is a
 * silent way to lose a mapping. `externalId` is **not** case-folded: it is the
 * external system's own string and some of them are case-sensitive, so
 * changing it would be this platform deciding what another system's
 * identifier means.
 */
function normalizeKey(input: {
  provider: string;
  entityType: string;
  externalId: string;
}): { provider: string; entityType: ExternalEntityType; externalId: string } {
  const provider = input.provider.trim().toLowerCase();
  if (!provider) throw invalidRequest("provider is required.");
  if (provider.length > MAX_PROVIDER_LENGTH) {
    throw invalidRequest(`provider must be ${MAX_PROVIDER_LENGTH} characters or fewer.`);
  }

  if (!isExternalEntityType(input.entityType)) {
    throw invalidRequest(
      `entityType must be one of ${EXTERNAL_ENTITY_TYPES.join(", ")}.`,
    );
  }

  const externalId = input.externalId.trim();
  if (!externalId) throw invalidRequest("externalId is required.");
  if (externalId.length > MAX_EXTERNAL_ID_LENGTH) {
    throw invalidRequest(`externalId must be ${MAX_EXTERNAL_ID_LENGTH} characters or fewer.`);
  }

  return { provider, entityType: input.entityType, externalId };
}

/**
 * Confirms the internal record exists *in this institution*.
 *
 * The tenancy check that makes a mapping trustworthy. Without it a mapping row
 * would be an unchecked pointer, and creating one would be a way to name
 * another tenant's record — the exact thing institution scoping exists to
 * prevent, reintroduced through a side table.
 */
async function internalRecordExists(
  institutionId: string,
  entityType: ExternalEntityType,
  internalId: string,
): Promise<boolean> {
  switch (entityType) {
    case "STUDENT":
      return (await prisma.student.count({ where: { id: internalId, institutionId } })) > 0;
    case "FACULTY":
      return (await prisma.user.count({ where: { id: internalId, institutionId } })) > 0;
    case "COHORT":
      return (await prisma.cohort.count({ where: { id: internalId, institutionId } })) > 0;
    case "SUBJECT":
      return (await prisma.subject.count({ where: { id: internalId, institutionId } })) > 0;
  }
}

/**
 * Creates or re-points a mapping, idempotently.
 *
 * Re-sending an identical link is a no-op that returns the existing row, which
 * is what an ERP replaying a sync should get. Pointing an existing external id
 * at a *different* internal record is allowed and updates in place — students
 * are merged and re-keyed in real school offices, and forcing a delete first
 * would mean a window with no mapping at all.
 *
 * What is refused is the ambiguous case: giving one internal record a *second*
 * id from the same provider. That is the reverse unique key, and it is a
 * conflict rather than an update because there is no way to tell which of the
 * two ids the external system now considers authoritative.
 */
export async function linkExternalId(
  institutionId: string,
  input: { provider: string; entityType: string; externalId: string; internalId: string },
): Promise<ExternalIdentityRecord> {
  const key = normalizeKey(input);
  const internalId = input.internalId.trim();
  if (!internalId) throw invalidRequest("internalId is required.");

  if (!(await internalRecordExists(institutionId, key.entityType, internalId))) {
    // Deliberately the same answer as "no such record at all": a caller must
    // not be able to probe another institution's ids by watching which ones
    // produce a different error.
    throw notFound(`${key.entityType.toLowerCase()} ${internalId}`);
  }

  try {
    return (await prisma.externalIdentity.upsert({
      where: {
        institutionId_provider_entityType_externalId: {
          institutionId,
          provider: key.provider,
          entityType: key.entityType,
          externalId: key.externalId,
        },
      },
      create: { institutionId, ...key, internalId },
      update: { internalId },
      select: SELECT,
    })) as ExternalIdentityRecord;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ApiError(
        "conflict",
        `This ${key.entityType.toLowerCase()} already has a different ${key.provider} id. Remove the existing mapping first if it is being replaced.`,
      );
    }
    throw error;
  }
}

const SELECT = {
  id: true,
  provider: true,
  entityType: true,
  externalId: true,
  internalId: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * The internal id an external id names, or null.
 *
 * Null covers three cases on purpose — no mapping, a mapping whose target has
 * since gone, and a mapping belonging to another institution — because a
 * caller allowed to tell them apart could enumerate what exists elsewhere.
 */
export async function resolveExternalId(
  institutionId: string,
  input: { provider: string; entityType: string; externalId: string },
): Promise<string | null> {
  const key = normalizeKey(input);
  const row = await prisma.externalIdentity.findUnique({
    where: {
      institutionId_provider_entityType_externalId: { institutionId, ...key },
    },
    select: { internalId: true },
  });
  if (!row) return null;
  return (await internalRecordExists(institutionId, key.entityType, row.internalId))
    ? row.internalId
    : null;
}

/** Every external id this institution holds for one internal record. */
export async function listExternalIdsFor(
  institutionId: string,
  entityType: ExternalEntityType,
  internalId: string,
): Promise<ExternalIdentityRecord[]> {
  return (await prisma.externalIdentity.findMany({
    where: { institutionId, entityType, internalId },
    select: SELECT,
    orderBy: [{ provider: "asc" }],
  })) as ExternalIdentityRecord[];
}

/**
 * Bounded listing, for an administrator auditing what a provider knows.
 *
 * Cursor-paged on `id` like every other list in this module — see
 * `pagination.ts` for why offsets are not used: a mapping created during a
 * walk would shift an offset window and silently skip a row.
 */
export async function listExternalIdentities(
  institutionId: string,
  filters: { provider?: string; entityType?: string } = {},
  page: { limit: number; cursorId: string | null } = { limit: 50, cursorId: null },
): Promise<ExternalIdentityRecord[]> {
  const where: Prisma.ExternalIdentityWhereInput = { institutionId };
  if (filters.provider) where.provider = filters.provider.trim().toLowerCase();
  if (filters.entityType) {
    if (!isExternalEntityType(filters.entityType)) {
      throw invalidRequest(`entityType must be one of ${EXTERNAL_ENTITY_TYPES.join(", ")}.`);
    }
    where.entityType = filters.entityType;
  }

  return (await prisma.externalIdentity.findMany({
    where,
    select: SELECT,
    orderBy: { id: "asc" },
    // One more than asked for, so the pager can answer "is there another page"
    // without a second count.
    take: Math.min(Math.max(page.limit, 1), 200) + 1,
    ...(page.cursorId ? { cursor: { id: page.cursorId }, skip: 1 } : {}),
  })) as ExternalIdentityRecord[];
}

/**
 * Removes a mapping. Returns false when there was nothing to remove.
 *
 * Deletes only the mapping — never the student, the class or the subject it
 * pointed at. An integration being disconnected is not a reason to delete
 * somebody's record, and this module holds no authority to do so.
 */
export async function unlinkExternalId(
  institutionId: string,
  input: { provider: string; entityType: string; externalId: string },
): Promise<boolean> {
  const key = normalizeKey(input);
  const result = await prisma.externalIdentity.deleteMany({
    where: { institutionId, ...key },
  });
  return result.count > 0;
}
