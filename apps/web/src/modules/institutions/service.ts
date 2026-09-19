import { requirePermission, requireSameInstitution } from "@/modules/authorization/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { getInstitutionById as getInstitutionByIdRepo } from "./repository";
import { DEFAULT_ACADEMIC_UNIT_LABELS, DEFAULT_LOW_ATTENDANCE_THRESHOLD } from "./types";
import type { Institution } from "./types";
import type {
  AcademicUnitLabels,
  AttendanceMode,
  ConfidenceThresholds,
  InstitutionSettings,
} from "./types";

const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  presentMin: 0.62,
  reviewMin: 0.45,
};

function parseSettings(institution: Institution): InstitutionSettings {
  return (institution.settings as InstitutionSettings | null) ?? {};
}

/**
 * Institution-type-specific vocabulary (e.g. "Grade" vs "Semester") comes
 * from settings, not from separate school/college schemas or code paths.
 */
export function resolveAcademicUnitLabels(institution: Institution): AcademicUnitLabels {
  return {
    ...DEFAULT_ACADEMIC_UNIT_LABELS,
    ...parseSettings(institution).academicUnitLabels,
  };
}

export function resolveConfidenceThresholds(institution: Institution): ConfidenceThresholds {
  return {
    ...DEFAULT_CONFIDENCE_THRESHOLDS,
    ...parseSettings(institution).confidenceThresholds,
  };
}

/**
 * The unified attendance engine's configuration switch (ARCHITECTURE.md):
 * defaults from Institution.type (SCHOOL -> one daily session, COLLEGE ->
 * subject/lecture-specific), overridable per institution via settings for
 * the institutions that don't fit the default (e.g. a school running
 * subject-wise attendance for senior grades).
 */
export function resolveAttendanceMode(institution: Institution): AttendanceMode {
  const configured = parseSettings(institution).attendanceMode;
  if (configured) return configured;
  return institution.type === "COLLEGE" ? "SUBJECT_WISE" : "DAILY";
}

/** Re-exported so existing callers keep their import path. Defined in
 * `types.ts`, which components can import without pulling in Prisma. */
export { DEFAULT_ACADEMIC_UNIT_LABELS, DEFAULT_LOW_ATTENDANCE_THRESHOLD };

/**
 * Clamped to 0-100: a threshold outside that range cannot describe a
 * percentage, and a settings typo should degrade to a usable report rather
 * than produce an empty or universal "at risk" list.
 */
export function resolveLowAttendanceThreshold(institution: Institution): number {
  const configured = parseSettings(institution).lowAttendanceThreshold;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_LOW_ATTENDANCE_THRESHOLD;
  }
  return Math.min(Math.max(configured, 0), 100);
}

export interface GetInstitutionSettingsDeps {
  getInstitutionById?: (id: string) => Promise<Institution | null>;
}

/**
 * The authorization boundary for "admin accessing institution settings"
 * (own institution: allowed) and "cross-institution data access" (denied).
 * Both checks happen before the injected repository call, so both outcomes
 * are provable without a database (see service.test.ts).
 */
export async function getInstitutionSettingsForUser(
  actor: SessionUser,
  institutionId: string,
  deps: GetInstitutionSettingsDeps = {},
): Promise<Institution | null> {
  requirePermission(actor, "institution.read");
  requireSameInstitution(actor, institutionId);

  const getInstitution = deps.getInstitutionById ?? getInstitutionByIdRepo;
  return getInstitution(institutionId);
}
