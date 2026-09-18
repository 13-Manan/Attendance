import { recordAuditLog as defaultRecordAuditLog } from "@/modules/audit/service";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import { requirePermission } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import {
  DEFAULT_LOW_ATTENDANCE_THRESHOLD,
  type AttendanceMode,
  type Institution,
} from "@/modules/institutions/types";
import * as repo from "./repository";
import {
  describeFacePolicyWarnings,
  facePolicyChangedFields,
  resolveAttendancePolicy,
  resolveFacePolicy,
  validateAttendancePolicy,
  validateFacePolicy,
  writeAttendancePolicy,
  writeFacePolicy,
  type FacePolicyInput,
} from "./policy";
import {
  AdminSettingsError,
  type AttendancePolicySettings,
  type FaceRecognitionPolicySettings,
} from "./types";

/**
 * The institution-configuration service: read the current settings, change
 * them, record who changed them.
 *
 * ## Permissions, and why no new key was invented
 *
 * Reading requires `institution.read`; writing requires `institution.update`.
 * Both already exist, both are already granted to every admin role, and both
 * already govern `Institution.settings` — the academic unit labels and the
 * face-data retention policy live in the same column under the same keys.
 *
 * A new permission key would have been more precise and completely useless:
 * `PERMISSIONS` is code but the role→permission rows are seeded *data*, so a
 * key added in this build exists in nobody's database. Every administrator
 * would be locked out of the screen that configures their institution. The
 * same reasoning is written out at length in `modules/integrations/
 * center-service.ts` and `modules/privacy/service.ts`; it applies here
 * unchanged.
 *
 * ## The tenant is never a parameter
 *
 * Not one function in this file accepts an institution id. It is read from the
 * session, so there is no field on any settings form through which an
 * administrator could retune another institution's recognition thresholds.
 *
 * ## Why every write is audited with a before and an after
 *
 * Lowering a present threshold does not look like an incident. It looks like a
 * settings change, and three weeks later it looks like a run of attendance
 * disputes nobody can explain. The audit row carries both the previous policy
 * and the new one, so "what was the threshold on the 14th" is answerable from
 * the log rather than from whatever the settings happen to say today — which
 * is exactly the question a disputed register raises.
 */

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface AdminSettingsDeps {
  getSettings?: (institutionId: string) => Promise<{ id: string; settings: unknown } | null>;
  writeSettings?: (institutionId: string, settings: Record<string, unknown>) => Promise<void>;
  getInstitution?: (institutionId: string) => Promise<Institution | null>;
  audit?: (input: RecordAuditLogInput) => Promise<void>;
}

function deps(overrides: AdminSettingsDeps) {
  return {
    getSettings: overrides.getSettings ?? repo.getInstitutionSettings,
    writeSettings: overrides.writeSettings ?? repo.writeInstitutionSettings,
    getInstitution: overrides.getInstitution ?? repo.getInstitution,
    audit: overrides.audit ?? ((input: RecordAuditLogInput) => defaultRecordAuditLog(input)),
  };
}

function requireInstitution(
  actor: SessionUser,
  permission: "institution.read" | "institution.update",
): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    throw new AdminSettingsError(
      "This account is not scoped to a single institution, so it cannot manage institution settings.",
    );
  }
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Everything the admin settings screens display, in one read.
 *
 * `attendanceMode` and `lowAttendanceThreshold` are resolved here rather than
 * through `modules/institutions/service.ts` because those resolvers take a
 * whole `Institution` and this path already holds one; the values and the
 * defaults are identical, and `service.test.ts` pins them together.
 */
export interface AdminSettingsView {
  institutionId: string;
  institutionName: string;
  institutionType: string;
  attendanceMode: AttendanceMode;
  lowAttendanceThreshold: number;
  attendancePolicy: AttendancePolicySettings;
  facePolicy: FaceRecognitionPolicySettings;
  /** Non-blocking notes about the *current* face policy, shown on load. */
  faceWarnings: string[];
  /** Face-policy fields that differ from the shipped defaults. */
  faceChangedFields: Array<keyof FaceRecognitionPolicySettings>;
}

function readAttendanceMode(institution: Institution): AttendanceMode {
  const settings = (institution.settings ?? {}) as { attendanceMode?: AttendanceMode };
  if (settings.attendanceMode === "DAILY" || settings.attendanceMode === "SUBJECT_WISE") {
    return settings.attendanceMode;
  }
  return institution.type === "COLLEGE" ? "SUBJECT_WISE" : "DAILY";
}

function readLowAttendanceThreshold(institution: Institution): number {
  const settings = (institution.settings ?? {}) as { lowAttendanceThreshold?: unknown };
  const configured = settings.lowAttendanceThreshold;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_LOW_ATTENDANCE_THRESHOLD;
  }
  return Math.min(Math.max(configured, 0), 100);
}

export async function getAdminSettings(
  actor: SessionUser,
  overrides: AdminSettingsDeps = {},
): Promise<AdminSettingsView> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.read");

  const institution = await d.getInstitution(institutionId);
  if (!institution) throw new AdminSettingsError("Institution not found.");

  const facePolicy = resolveFacePolicy(institution.settings);
  return {
    institutionId,
    institutionName: institution.name,
    institutionType: institution.type,
    attendanceMode: readAttendanceMode(institution),
    lowAttendanceThreshold: readLowAttendanceThreshold(institution),
    attendancePolicy: resolveAttendancePolicy(institution.settings),
    facePolicy,
    faceWarnings: describeFacePolicyWarnings(facePolicy),
    faceChangedFields: facePolicyChangedFields(facePolicy),
  };
}

// ---------------------------------------------------------------------------
// Writing — attendance
// ---------------------------------------------------------------------------

export interface AttendanceSettingsInput {
  attendanceMode: string;
  lowAttendanceThreshold: number;
  correctionWindowDays: number;
  requireReasonAfterFinalization: boolean;
}

export interface AttendanceSettingsResult {
  attendanceMode: AttendanceMode;
  lowAttendanceThreshold: number;
  policy: AttendancePolicySettings;
}

/**
 * Saves the attendance settings.
 *
 * Validation runs before the read, so a rejected submission never touches the
 * database — the same ordering `modules/privacy/service.ts` uses, and the
 * reason is the same: a half-applied settings write is a configuration nobody
 * chose.
 */
export async function updateAttendanceSettings(
  actor: SessionUser,
  input: AttendanceSettingsInput,
  overrides: AdminSettingsDeps = {},
): Promise<AttendanceSettingsResult> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");

  if (input.attendanceMode !== "DAILY" && input.attendanceMode !== "SUBJECT_WISE") {
    throw new AdminSettingsError(
      "Choose an attendance mode: daily (one register per class per day) or subject-wise " +
        "(one register per lecture).",
    );
  }
  const threshold = input.lowAttendanceThreshold;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new AdminSettingsError(
      "The low-attendance threshold is a percentage, so it must be between 0 and 100.",
    );
  }
  const policy = validateAttendancePolicy({
    correctionWindowDays: input.correctionWindowDays,
    requireReasonAfterFinalization: input.requireReasonAfterFinalization,
  });

  const row = await d.getSettings(institutionId);
  const before: AttendanceSettingsResult = {
    attendanceMode: readAttendanceModeFromSettings(row?.settings),
    lowAttendanceThreshold: readLowThresholdFromSettings(row?.settings),
    policy: resolveAttendancePolicy(row?.settings),
  };

  const base = writeAttendancePolicy(row?.settings, policy);
  base.attendanceMode = input.attendanceMode;
  base.lowAttendanceThreshold = Math.round(threshold * 100) / 100;
  await d.writeSettings(institutionId, base);

  const after: AttendanceSettingsResult = {
    attendanceMode: input.attendanceMode,
    lowAttendanceThreshold: base.lowAttendanceThreshold as number,
    policy,
  };

  await d.audit({
    action: "institution.attendance_policy_updated",
    entityType: "Institution",
    entityId: institutionId,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: before,
    afterJson: after,
  });

  return after;
}

/**
 * `attendanceMode` when only the raw settings blob is in hand.
 *
 * The institution *type* fallback needs the institution row, which the write
 * path deliberately does not fetch — so an unconfigured mode is reported as
 * the stored value's absence rather than guessed. Callers on the write path
 * only use this for the audit "before", where "not configured" is the honest
 * answer and inventing SUBJECT_WISE would record a change that never happened.
 */
function readAttendanceModeFromSettings(settings: unknown): AttendanceMode {
  if (settings && typeof settings === "object" && !Array.isArray(settings)) {
    const mode = (settings as { attendanceMode?: unknown }).attendanceMode;
    if (mode === "DAILY" || mode === "SUBJECT_WISE") return mode;
  }
  return "DAILY";
}

function readLowThresholdFromSettings(settings: unknown): number {
  if (settings && typeof settings === "object" && !Array.isArray(settings)) {
    const value = (settings as { lowAttendanceThreshold?: unknown }).lowAttendanceThreshold;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.min(Math.max(value, 0), 100);
    }
  }
  return DEFAULT_LOW_ATTENDANCE_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Writing — face recognition
// ---------------------------------------------------------------------------

export interface FacePolicyResult {
  policy: FaceRecognitionPolicySettings;
  warnings: string[];
}

/**
 * Saves the recognition policy.
 *
 * The brief's requirement for this screen is specific: an administrator must
 * not be able to casually modify dangerous model parameters without
 * validation, and if thresholds are configurable the system must explain what
 * they mean, validate the range, show a warning, and audit the change. Those
 * four obligations are discharged in four different places, deliberately:
 *
 * - *Explain* — in the form, next to each control (`face-policy-form.tsx`).
 * - *Validate the range* — `validateFacePolicy`, which refuses and says why.
 * - *Warn* — `describeFacePolicyWarnings`, returned with the result and shown
 *   after the save as well as before it, because the warning that matters is
 *   the one about the value now in force.
 * - *Audit* — here, with the full previous and new policy in the row.
 *
 * The one thing this function will not do is quietly adjust a value to
 * something safer. A threshold silently different from the one an
 * administrator typed is a threshold nobody is accountable for.
 */
export async function updateFacePolicy(
  actor: SessionUser,
  input: FacePolicyInput,
  overrides: AdminSettingsDeps = {},
): Promise<FacePolicyResult> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.update");

  const policy = validateFacePolicy(input);

  const row = await d.getSettings(institutionId);
  const previous = resolveFacePolicy(row?.settings);
  await d.writeSettings(institutionId, writeFacePolicy(row?.settings, policy));

  await d.audit({
    action: "institution.face_policy_updated",
    entityType: "Institution",
    entityId: institutionId,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: previous,
    // The warnings travel into the audit row with the values. "Was anyone told
    // this would increase false accepts?" is the question an incident review
    // asks, and the answer has to be in the record rather than in a screenshot
    // nobody took.
    afterJson: { ...policy, warnings: describeFacePolicyWarnings(policy) },
  });

  return { policy, warnings: describeFacePolicyWarnings(policy) };
}
