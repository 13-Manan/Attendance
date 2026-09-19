import { recordAuditLog as defaultRecordAuditLog } from "@/modules/audit/service";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import { requirePermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import type { AcademicUnitLabels } from "@/modules/institutions/types";
import * as repo from "./repository";
import {
  resolveLabels,
  validateAcademicUnitLabels,
  validateAddressLine,
  validateContactEmail,
  validateContactPhone,
  validateInstitutionName,
  validateTimezone,
} from "./policy";
import { InstitutionProfileError, type InstitutionProfile } from "./types";

/**
 * The institution's own profile.
 *
 * ## Tenancy
 *
 * No function here takes an institution id. It comes from the session, once,
 * in `requireInstitution` below. There is therefore no form field, route
 * parameter or crafted body through which an administrator of one institution
 * could rename another one — which matters more here than almost anywhere
 * else, because this is the screen that decides what every other screen in the
 * product calls things.
 *
 * ## Permissions
 *
 * `institution.read` to see it, `institution.update` to change it. Both exist
 * already and both are already granted to every seeded administrator role. No
 * new key: `PERMISSIONS` is code but the role→permission rows are seeded
 * *data*, so a key added in this build exists in nobody's database and would
 * lock every administrator out of the screen that configures their own
 * institution. The same argument is written out at length in
 * `modules/admin-settings/service.ts`.
 *
 * ## What cannot be changed here
 *
 * The institution *type*. SCHOOL and COLLEGE select different attendance
 * shapes — a daily class register against a per-lecture subject register — and
 * flipping it on a populated institution would leave every existing session on
 * the wrong side of that branch. It is set once, at bootstrap. An institution
 * that genuinely needs the other behaviour changes `attendanceMode` in
 * attendance settings, which is exactly the override that exists for it.
 */

export interface InstitutionProfileDeps {
  get?: typeof repo.getInstitutionProfile;
  update?: typeof repo.updateInstitutionProfile;
  audit?: (input: RecordAuditLogInput) => Promise<void>;
}

function deps(overrides: InstitutionProfileDeps) {
  return {
    get: overrides.get ?? repo.getInstitutionProfile,
    update: overrides.update ?? repo.updateInstitutionProfile,
    audit: overrides.audit ?? ((input: RecordAuditLogInput) => defaultRecordAuditLog(input)),
  };
}

function requireInstitution(actor: SessionUser, permission: PermissionKey): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    throw new InstitutionProfileError(
      "This account is not scoped to a single institution, so there is no profile to manage here.",
    );
  }
  return actor.institutionId;
}

function toProfile(row: repo.InstitutionProfileRow): InstitutionProfile {
  const settings =
    row.settings && typeof row.settings === "object" && !Array.isArray(row.settings)
      ? (row.settings as Record<string, unknown>)
      : {};

  return {
    id: row.id,
    name: row.name,
    type: row.type,
    timezone: row.timezone,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    addressLine: row.addressLine,
    academicUnitLabels: resolveLabels(settings.academicUnitLabels),
  };
}

export async function getInstitutionProfileForRequest(
  actor: SessionUser,
  overrides: InstitutionProfileDeps = {},
): Promise<InstitutionProfile> {
  const institutionId = requireInstitution(actor, "institution.read");
  const row = await deps(overrides).get(institutionId);
  if (!row) throw new InstitutionProfileError("This institution could not be found.");
  return toProfile(row);
}

export interface InstitutionProfileInput {
  name: unknown;
  timezone: unknown;
  contactEmail: unknown;
  contactPhone: unknown;
  addressLine: unknown;
  academicUnitLabels: unknown;
}

/**
 * Saves the profile.
 *
 * Validation runs before the read, so a refused submission never touches the
 * database — the ordering `modules/admin-settings/service.ts` uses, and for
 * the same reason: a half-applied profile is a profile nobody chose.
 *
 * The settings blob is merged, never replaced. This screen owns exactly one
 * key inside it; the recognition thresholds, retention policy and attendance
 * rules live in the same column and must survive a change of phone number.
 */
export async function updateInstitutionProfileForRequest(
  actor: SessionUser,
  input: InstitutionProfileInput,
  overrides: InstitutionProfileDeps = {},
): Promise<InstitutionProfile> {
  const institutionId = requireInstitution(actor, "institution.update");
  const d = deps(overrides);

  const name = validateInstitutionName(input.name);
  const timezone = validateTimezone(input.timezone);
  const contactEmail = validateContactEmail(input.contactEmail);
  const contactPhone = validateContactPhone(input.contactPhone);
  const addressLine = validateAddressLine(input.addressLine);
  const labelOverrides = validateAcademicUnitLabels(input.academicUnitLabels);

  const row = await d.get(institutionId);
  if (!row) throw new InstitutionProfileError("This institution could not be found.");

  const existing =
    row.settings && typeof row.settings === "object" && !Array.isArray(row.settings)
      ? (row.settings as Record<string, unknown>)
      : {};

  const settings: Record<string, unknown> = { ...existing };
  if (Object.keys(labelOverrides).length === 0) {
    // Every label is the shipped default, so the key is removed rather than
    // stored empty: "{}" and "absent" resolve identically, and one of them is
    // a value somebody has to wonder about later.
    delete settings.academicUnitLabels;
  } else {
    settings.academicUnitLabels = labelOverrides;
  }

  await d.update(institutionId, {
    name,
    timezone,
    contactEmail,
    contactPhone,
    addressLine,
    settings,
  });

  const before = toProfile(row);
  const after: InstitutionProfile = {
    ...before,
    name,
    timezone,
    contactEmail,
    contactPhone,
    addressLine,
    academicUnitLabels: resolveLabels(labelOverrides),
  };

  await d.audit({
    action: "institution.profile_updated",
    entityType: "Institution",
    entityId: institutionId,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: auditShape(before),
    afterJson: auditShape(after),
  });

  return after;
}

/**
 * What the audit row carries.
 *
 * The id and the type are omitted: one is the entity id the row already has,
 * and the other cannot change here, so including them would pad every diff
 * with two fields that are always equal.
 */
function auditShape(profile: InstitutionProfile): {
  name: string;
  timezone: string;
  contactEmail: string | null;
  contactPhone: string | null;
  addressLine: string | null;
  academicUnitLabels: AcademicUnitLabels;
} {
  return {
    name: profile.name,
    timezone: profile.timezone,
    contactEmail: profile.contactEmail,
    contactPhone: profile.contactPhone,
    addressLine: profile.addressLine,
    academicUnitLabels: profile.academicUnitLabels,
  };
}
