import type { SessionUser } from "@/modules/auth-tenancy/types";
import { requirePermission } from "@/modules/authorization/service";
import {
  countActiveStudents,
  countCohorts,
  countFacultyUsers,
} from "./repository";

/**
 * The admin dashboard's headline numbers and service status.
 *
 * Read-only, like `attendance-analytics`: there is nothing here that mutates,
 * so a widened permission on this module could never become a write.
 *
 * Every function takes the caller's session and derives the institution from
 * it. There is no `institutionId` parameter anywhere in this file — a count
 * cannot be pointed at another tenant because there is no argument with which
 * to point it. The permission check happens before the first repository call,
 * so an unauthorised caller cannot use response timing as an existence oracle.
 */

export interface InstitutionCounts {
  students: number;
  faculty: number;
  cohorts: number;
}

export interface InstitutionCountsDeps {
  countActiveStudents(institutionId: string): Promise<number>;
  countFacultyUsers(institutionId: string): Promise<number>;
  countCohorts(institutionId: string): Promise<number>;
}

const DEFAULT_COUNT_DEPS: InstitutionCountsDeps = {
  countActiveStudents,
  countFacultyUsers,
  countCohorts,
};

/**
 * Students, staff and classes in the caller's own institution.
 *
 * `null` for a platform-level account: those belong to no single institution,
 * and inventing a cross-tenant total for them would be exactly the unscoped
 * aggregate this module is shaped to prevent. The dashboard shows them the
 * scope-free view instead.
 */
export async function getInstitutionCounts(
  user: SessionUser,
  deps: InstitutionCountsDeps = DEFAULT_COUNT_DEPS,
): Promise<InstitutionCounts | null> {
  requirePermission(user, "institution.read");

  const institutionId = user.institutionId;
  if (!institutionId) return null;

  // Three independent counts; no reason to serialise them behind each other.
  const [students, faculty, cohorts] = await Promise.all([
    deps.countActiveStudents(institutionId),
    deps.countFacultyUsers(institutionId),
    deps.countCohorts(institutionId),
  ]);

  return { students, faculty, cohorts };
}

// ---------------------------------------------------------------------------
// System status
// ---------------------------------------------------------------------------

export type ServiceHealth = "operational" | "unavailable";

/**
 * What the recognition service is, and what it is cleared for.
 *
 * `productionEligible` is reported exactly as the service reports it and is
 * never inferred from the service merely answering. A backend that responds
 * happily with unlicensed or placeholder weights is reachable, not
 * production-ready, and the dashboard says so in those words — telling an
 * administrator that face recognition is "ready" when the loaded model is the
 * mock backend would be a claim this product must not make.
 */
export interface FaceServiceStatus {
  health: ServiceHealth;
  modelName: string | null;
  modelVersion: string | null;
  /** `null` when the service could not be reached to ask. */
  productionEligible: boolean | null;
}

export interface SystemStatus {
  /** Derived, not probed: these numbers came back, so the database answered. */
  database: ServiceHealth;
  faceService: FaceServiceStatus;
}

export interface FaceServiceStatusDeps {
  faceModelInfo(): Promise<{
    modelName: string;
    modelVersion: string;
    productionEligible: boolean;
  }>;
}

/**
 * Imported lazily, not at module scope, and for a specific reason:
 * `lib/face-ai-client` pulls in `lib/env`, which validates the whole
 * environment the moment it loads. That makes any module statically importing
 * it unloadable under `node --test`, where no `DATABASE_URL` exists — and the
 * authorization and tenant-scoping rules above are exactly the part that
 * needs testing. Deferring the import to the one call that uses it keeps this
 * file loadable, and costs a resolved module cache hit at runtime.
 */
const DEFAULT_FACE_DEPS: FaceServiceStatusDeps = {
  async faceModelInfo() {
    const { faceModelInfo } = await import("@/lib/face-ai-client");
    return faceModelInfo();
  },
};

/**
 * Never throws.
 *
 * A status widget that can take the dashboard down with it is worse than no
 * widget: the page whose job is to report an outage is the last page that
 * should fail during one. An unreachable service is a result here, not an
 * error.
 */
export async function getFaceServiceStatus(
  deps: FaceServiceStatusDeps = DEFAULT_FACE_DEPS,
): Promise<FaceServiceStatus> {
  try {
    const info = await deps.faceModelInfo();
    return {
      health: "operational",
      modelName: info.modelName,
      modelVersion: info.modelVersion,
      productionEligible: info.productionEligible,
    };
  } catch {
    return {
      health: "unavailable",
      modelName: null,
      modelVersion: null,
      productionEligible: null,
    };
  }
}
