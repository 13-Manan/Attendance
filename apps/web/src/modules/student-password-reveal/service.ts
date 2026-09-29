import { recordAuditLog } from "@/modules/audit/service";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { hasPermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { revealDepartmentStudentPassword } from "@/modules/college-setup/service";
import { CollegeSetupError } from "@/modules/college-setup/types";
import { StudentError } from "@/modules/students/directory-types";
import {
  RevealRefusal,
  revealStudentLoginPassword,
  type RevealRefusalReason,
} from "@/modules/students/login-provisioning";

/**
 * Revealing a student's current portal password to the member of staff who
 * asks — the business requirement that authorised college staff can tell a
 * student their password. The one way in to it.
 *
 * ## What the request may say
 *
 * A student id, and nothing else. Who is asking, their roles, their college
 * and their department all come from the server session and the database.
 *
 * ## Who may
 *
 * - An account manager — `user.invite`, the permission that already creates
 *   and resets this institution's student logins — for a student of their
 *   own institution (`revealStudentLoginPassword`).
 * - A head of department — an active, designated head of the department that
 *   is their own — for a student in one of that department's sections in a
 *   session that has not been archived (`revealDepartmentStudentPassword`).
 *
 * Nobody else: not a teacher, department faculty, a student — even one asking
 * for their own — or a platform account with no institution. In either case
 * the student's login must be switched on and belong to a student on roll.
 *
 * ## What is kept
 *
 * A reveal writes `student.password_viewed` before the password is returned;
 * a refusal writes `student.password_view_denied` with its reason. Every
 * attempt writes one structured log line: who, whose, the outcome and why.
 * None of it carries the password, its hash, its ciphertext or the key.
 */

export type RevealOutcome =
  | { status: "revealed"; password: string }
  | { status: "unavailable" }
  | { status: "refused"; reason: RevealRefusalReason; message: string };

const MAX_ID_LENGTH = 64;

export async function revealStudentPassword(
  actor: SessionUser,
  rawStudentId: unknown,
  request: { ipAddress?: string | null; userAgent?: string | null } = {},
): Promise<RevealOutcome> {
  const studentId = typeof rawStudentId === "string" ? rawStudentId.trim() : "";
  const actorRoles = actor.roles.map((role) => role.key);
  const path = hasPermission(actor, "user.invite")
    ? "account_manager"
    : hasPermission(actor, "department.manage")
      ? "head_of_department"
      : null;
  const facts = {
    actorUserId: actor.userId,
    actorRoles,
    institutionId: actor.institutionId,
    studentId: studentId.slice(0, MAX_ID_LENGTH),
    path,
  };
  log("attempted", facts);

  try {
    if (studentId === "" || studentId.length > MAX_ID_LENGTH || /\s/.test(studentId)) {
      throw new RevealRefusal("out_of_scope", "That student could not be found.");
    }
    if (!path) throw new ForbiddenError("user.invite");
    const result =
      path === "account_manager"
        ? await revealStudentLoginPassword(actor, studentId, { actorRoles, ...request })
        : await revealDepartmentStudentPassword(actor, studentId, request);
    if (result.status === "revealed") {
      log("revealed", facts);
      return result;
    }
    log("unavailable", { ...facts, reason: result.reason });
    return { status: "unavailable" };
  } catch (error) {
    const refusal = refusalOf(error);
    if (!refusal) {
      log("failed", facts);
      throw error;
    }
    await recordAuditLog({
      action: "student.password_view_denied",
      entityType: "Student",
      entityId: facts.studentId || "(none)",
      institutionId: actor.institutionId,
      actorUserId: actor.userId,
      afterJson: { reason: refusal.reason, actorRoles, path },
      ipAddress: request.ipAddress ?? null,
      userAgent: request.userAgent ?? null,
    });
    log("denied", { ...facts, reason: refusal.reason });
    return { status: "refused", ...refusal };
  }
}

/** A refusal the person asking can be told about, or null for an error nobody should see the inside of. */
function refusalOf(error: unknown): { reason: RevealRefusalReason; message: string } | null {
  if (error instanceof RevealRefusal) return { reason: error.reason, message: error.message };
  if (error instanceof ForbiddenError) {
    return { reason: "not_permitted", message: "You do not have permission to see student passwords." };
  }
  // The department check: another department's student, another college's,
  // or one no longer in any of this department's current sections.
  if (error instanceof CollegeSetupError) return { reason: "out_of_scope", message: error.message };
  // A platform account, which belongs to no institution.
  if (error instanceof StudentError) {
    return { reason: "not_permitted", message: "You do not have permission to see student passwords." };
  }
  return null;
}

/** One structured line per step. Identifiers and outcomes only — never a password, hash, ciphertext or key. */
function log(outcome: string, facts: Record<string, unknown>): void {
  const line = JSON.stringify({ log: "student_password.reveal", outcome, ...facts });
  if (outcome === "denied" || outcome === "failed") console.warn(line);
  else console.info(line);
}
