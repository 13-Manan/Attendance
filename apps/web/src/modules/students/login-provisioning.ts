import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { hashPassword } from "@/modules/auth-tenancy/password";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { requirePermission } from "@/modules/authorization/service";
import { TEMP_PASSWORD_NOTICE, type IssuedPassword } from "@/modules/faculty/directory-types";
import { StudentError } from "./directory-types";

/**
 * Giving a student a way to sign in.
 *
 * `Student` and `User` are deliberately separate rows. A student is a person
 * on a register — they exist whether or not anyone ever gives them a login,
 * and most never need one. `Student.userId` is the optional bridge, unique so
 * one login can only ever reach one student's record.
 *
 * Nothing created this link before now: the student directory creates students
 * without accounts, and the faculty directory refuses STUDENT outright because
 * a login made there would be attached to nothing. So this is the missing half,
 * and it is deliberately narrow — one function, one role, no way to widen it.
 *
 * ## What a provisioned account can reach
 *
 * Exactly the STUDENT role: `student.read.own`, `attendanceRecord.read.own`,
 * `cohort.read`, `faceEmbedding.enroll.own`. Three of those four are
 * self-scoped by name, and the portal resolves *which* student from the
 * session rather than from the URL — `/api/realtime/student/[studentId]`
 * compares the id in the path against the one the session resolves to and
 * returns 403 on a mismatch. So a student account cannot read another
 * student's record even knowing their id.
 *
 * It reaches no staff screen: every one of those requires a permission the
 * STUDENT role does not hold.
 */

export interface StudentLoginAccount {
  userId: string;
  email: string;
  status: "ACTIVE" | "INACTIVE";
}

export interface ProvisionedStudentLogin extends IssuedPassword {
  account: StudentLoginAccount;
}

const STUDENT_ROLE_KEY = "STUDENT";

/** The same CSPRNG generator the faculty and administrator flows use. */
function newPassword(): string {
  return randomBytes(12).toString("base64url");
}

function requireInstitution(actor: SessionUser): string {
  // `user.invite` is the permission that already means "may create an account
  // in this institution" — it is what the faculty directory checks. Reusing it
  // keeps one answer to that question rather than inventing a second.
  requirePermission(actor, "user.invite");
  if (!actor.institutionId) {
    throw new StudentError(
      "This account is not scoped to a single institution, so it cannot provision student logins here.",
    );
  }
  return actor.institutionId;
}

function requireEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email === "") throw new StudentError("Enter an email address for the student to sign in with.");
  if (email.length > 255) throw new StudentError("The email must be 255 characters or fewer.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new StudentError("That does not look like an email address.");
  }
  return email;
}

/**
 * Creates a login for one student, or refuses and explains why.
 *
 * Tenant-scoped twice over: the student is looked up within the caller's
 * institution, and the account is created inside it. A student id from another
 * institution simply does not resolve, which is the same answer as one that
 * does not exist — no probing.
 */
export async function provisionStudentLogin(
  actor: SessionUser,
  studentId: string,
  input: { email: string },
): Promise<ProvisionedStudentLogin> {
  const institutionId = requireInstitution(actor);
  const email = requireEmail(input.email);

  const student = await prisma.student.findFirst({
    where: { id: studentId, institutionId },
    select: { id: true, firstName: true, lastName: true, userId: true, status: true },
  });
  if (!student) {
    throw new StudentError("That student is not in this institution.");
  }
  if (student.userId) {
    throw new StudentError(
      "This student already has a login. Issue a new password from here instead of creating a second account.",
    );
  }

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    // Same reticence as everywhere else: an address may belong to another
    // tenant, and saying so would leak who is enrolled where.
    throw new StudentError(
      `An account already uses ${email}. An address can only belong to one account.`,
    );
  }

  const role = await prisma.role.findFirst({
    where: { institutionId: null, key: STUDENT_ROLE_KEY },
    select: { id: true },
  });
  if (!role) {
    throw new StudentError(
      "The STUDENT role is not seeded on this deployment. Run the system bootstrap first.",
    );
  }

  const password = newPassword();
  const passwordHash = await hashPassword(password);
  const name = `${student.firstName} ${student.lastName}`.trim();

  const userId = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        institutionId,
        campusId: null,
        name,
        email,
        passwordHash,
        status: "ACTIVE",
      },
      select: { id: true },
    });

    await tx.userRoleAssignment.create({
      data: { userId: user.id, roleId: role.id, institutionId, campusId: null },
    });

    // The bridge. `Student.userId` is unique, so this is also what stops a
    // second account ever pointing at the same student — the constraint, not
    // the check above, is the real guarantee.
    await tx.student.update({ where: { id: student.id }, data: { userId: user.id } });

    return user.id;
  });

  await recordAuditLog({
    action: "user.created",
    entityType: "User",
    entityId: userId,
    institutionId,
    actorUserId: actor.userId,
    afterJson: { name, email, roleKey: STUDENT_ROLE_KEY, studentId: student.id },
  });

  return {
    account: { userId, email, status: "ACTIVE" },
    password,
    notice: TEMP_PASSWORD_NOTICE,
  };
}

/**
 * Issues a new temporary password for a student who already has a login, and
 * ends the sessions the old one opened.
 */
export async function resetStudentLoginPassword(
  actor: SessionUser,
  studentId: string,
): Promise<IssuedPassword> {
  const institutionId = requireInstitution(actor);

  const student = await prisma.student.findFirst({
    where: { id: studentId, institutionId },
    select: { userId: true },
  });
  if (!student) throw new StudentError("That student is not in this institution.");
  if (!student.userId) throw new StudentError("This student does not have a login yet.");

  const password = newPassword();
  const passwordHash = await hashPassword(password);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: student.userId! }, data: { passwordHash } });
    await tx.session.deleteMany({ where: { userId: student.userId! } });
  });

  await recordAuditLog({
    action: "user.updated",
    entityType: "User",
    entityId: student.userId,
    institutionId,
    actorUserId: actor.userId,
    afterJson: { studentId, passwordReset: true, sessionsEnded: true },
  });

  return { password, notice: TEMP_PASSWORD_NOTICE };
}

/** The login attached to a student, if there is one. Read-only. */
export async function getStudentLogin(
  actor: SessionUser,
  studentId: string,
): Promise<StudentLoginAccount | null> {
  requirePermission(actor, "student.read");
  if (!actor.institutionId) return null;

  const student = await prisma.student.findFirst({
    where: { id: studentId, institutionId: actor.institutionId },
    select: { user: { select: { id: true, email: true, status: true } } },
  });
  if (!student?.user) return null;

  return {
    userId: student.user.id,
    email: student.user.email,
    status: student.user.status === "ACTIVE" ? "ACTIVE" : "INACTIVE",
  };
}
