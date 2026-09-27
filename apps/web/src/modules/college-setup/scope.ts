import { prisma } from "@/lib/prisma";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import type { PermissionKey } from "@/modules/authorization/permissions";
import { hasPermission, requirePermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { getInstitutionType } from "@/modules/institutions/repository";
import * as repo from "./repository";
import { CollegeSetupError, type CollegeScope } from "./types";

/**
 * Who may see and change which part of a college's structure.
 *
 * ## Two kinds of actor
 *
 * - An **administrator** (`academicStructure.manage`, which every college
 *   administrator role already holds) reaches every department.
 * - A **head of department** (`department.manage`, from the HOD role) reaches
 *   exactly one: the department that names them, which must also be their
 *   own department, while their account is active. All three facts are read
 *   from the database on every request — the session carries a role, never a
 *   department — and if any of them disagrees the answer is no. A head moved
 *   to another department on the Faculty page therefore loses the old one
 *   without gaining the new one until somebody makes them its head.
 *
 * Nobody else reaches these screens. The scope is resolved from the session,
 * never from anything a page was asked for; every read and write in
 * `service.ts` then checks the row it touches is inside it.
 */

export interface ScopeFacts {
  institutionId: string;
  isAdmin: boolean;
  /** Holds `department.manage`. */
  isDepartmentHead: boolean;
  /** The departments whose metadata names this user as head. */
  headedDepartmentIds: readonly string[];
  /** The user's own `departmentId`, read fresh. */
  userDepartmentId: string | null;
  userActive: boolean;
}

/** The decision, apart from the reads it needs — so it can be tested without a database. */
export function decideCollegeScope(facts: ScopeFacts): CollegeScope | null {
  if (facts.isAdmin) return { kind: "admin", institutionId: facts.institutionId };
  if (!facts.isDepartmentHead || !facts.userActive || !facts.userDepartmentId) return null;
  if (!facts.headedDepartmentIds.includes(facts.userDepartmentId)) return null;
  return { kind: "hod", institutionId: facts.institutionId, departmentId: facts.userDepartmentId };
}

async function requireCollege(actor: SessionUser): Promise<string> {
  if (!actor.institutionId) {
    throw new CollegeSetupError(
      "This account is not linked to a single college, so it cannot set up departments.",
    );
  }
  if ((await getInstitutionType(actor.institutionId)) !== "COLLEGE") {
    throw new CollegeSetupError("Departments, semesters and courses are set up this way for colleges only.");
  }
  return actor.institutionId;
}

/**
 * The actor's scope, or a refusal.
 *
 * `adminPermissions` are what an administrator additionally needs for the
 * operation — `cohort.manage` to change a section, say. A head of department
 * needs only their role and their designation; which of their department's
 * rows they may touch is checked by the caller against the scope returned.
 */
export async function resolveCollegeScope(
  actor: SessionUser,
  adminPermissions: readonly PermissionKey[] = [],
): Promise<CollegeScope> {
  const institutionId = await requireCollege(actor);

  if (hasPermission(actor, "academicStructure.manage")) {
    for (const permission of adminPermissions) requirePermission(actor, permission);
    return { kind: "admin", institutionId };
  }
  if (!hasPermission(actor, "department.manage")) throw new ForbiddenError("department.manage");

  const [user, headed] = await Promise.all([
    repo.getPerson(prisma, institutionId, actor.userId),
    repo.listDepartmentsHeadedBy(prisma, institutionId, actor.userId),
  ]);
  const scope = decideCollegeScope({
    institutionId,
    isAdmin: false,
    isDepartmentHead: true,
    headedDepartmentIds: headed.map((department) => department.id),
    userDepartmentId: user?.departmentId ?? null,
    userActive: user?.status === "ACTIVE",
  });
  if (!scope) throw new ForbiddenError("not_department_head");
  return scope;
}

/** Only an administrator: creating a department, naming its head, adding a staff account. */
export async function requireCollegeAdmin(
  actor: SessionUser,
  permissions: readonly PermissionKey[] = [],
): Promise<Extract<CollegeScope, { kind: "admin" }>> {
  const institutionId = await requireCollege(actor);
  requirePermission(actor, "academicStructure.manage");
  for (const permission of permissions) requirePermission(actor, permission);
  return { kind: "admin", institutionId };
}

/** Whether a department is inside the scope. The caller has already confirmed it is this college's. */
export function departmentInScope(scope: CollegeScope, departmentId: string): boolean {
  return scope.kind === "admin" || scope.departmentId === departmentId;
}

/**
 * The same actor, carrying `permissions` for one call the college scope has
 * already authorised.
 *
 * The student and enrolment services are the only writers of their tables and
 * keep the validation and audit rows that go with them; they check
 * institution-wide permissions, which a head of department deliberately does
 * not hold. So once `service.ts` has confirmed the section is inside the
 * head's department and its session is open, it calls them with exactly the
 * permissions that one call needs. The audit rows still name the head as the
 * actor. The copy never leaves the function that made it.
 */
export function delegate(actor: SessionUser, permissions: readonly PermissionKey[]): SessionUser {
  return {
    ...actor,
    roles: [
      ...actor.roles,
      {
        key: "COLLEGE_SETUP_DELEGATION",
        name: "College setup, this request only",
        institutionId: actor.institutionId,
        campusId: null,
        permissions: [...permissions],
      },
    ],
  };
}
