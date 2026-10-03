import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/modules/audit/service";
import { SecretBoxError } from "@/lib/secret-box";
import { hashPassword } from "@/modules/auth-tenancy/password";
import {
  lockAccountForPasswordWrite,
  openRecoverablePassword,
  requireStudentPasswordKey,
  storeRecoverablePasswordWithin,
} from "@/modules/auth-tenancy/recoverable-student-password";
import {
  isPlaceholderLoginEmail,
  placeholderLoginEmail,
} from "@/modules/auth-tenancy/student-login-policy";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { requireAnyPermission, requirePermission } from "@/modules/authorization/service";
import type { IssuedPassword } from "@/modules/faculty/directory-types";
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
 *
 * ## Passwords
 *
 * A login starts with a temporary password generated here (a CSPRNG, never
 * derived from anything about the student), and a reset issues another. Each
 * is returned once, to the administrator or head of department who asked, for
 * them to hand over. Both leave the account with `mustChangePassword` set, so
 * the student has to choose their own before the portal opens (see
 * auth-tenancy/session.ts).
 *
 * Its scrypt hash is what sign-in checks. Alongside it, because the college
 * needs its authorised staff to be able to reveal a student's current
 * password, an AES-256-GCM copy is kept (auth-tenancy/
 * recoverable-student-password.ts) — sealed in the same transaction as the
 * hash, under the account's row lock, and replaced whenever the password is.
 * If it cannot be sealed, the login, reset or change does not happen. The
 * only way to read it is `revealStudentLoginPassword`, which checks who is
 * asking and writes an audit row first. The audit rows say what happened and
 * never carry a password, a hash or ciphertext.
 */

export interface StudentLoginAccount {
  userId: string;
  /** What the student signs in with, on their school's student sign-in link: their student code. */
  loginId: string;
  /** A real address they can also sign in with, or null when the account has none. */
  email: string | null;
  /** Whether the login is switched on. A disabled login cannot sign in. */
  status: "ACTIVE" | "INACTIVE";
  /** False while the student is archived: the login cannot be used until they are back on roll. */
  studentOnRoll: boolean;
  lastLoginAt: Date | null;
  /** The institution whose student sign-in link this login uses. */
  institutionId: string;
  /**
   * True while the password is a temporary one staff issued — at creation or
   * by a reset — and the student has not chosen their own yet.
   */
  mustChangePassword: boolean;
  /** When the password was last set and by whom, from the audit rows; null if none records it. */
  lastPasswordChange: PasswordChange | null;
  /**
   * Whether a recoverable copy of the current password exists, so authorised
   * staff can reveal it. False for a login from before that was kept, until it
   * is next reset or changed. Only the fact — never the password.
   */
  passwordRecoverable: boolean;
}

/** A password being set: issued by staff (a new login, a reset) or chosen by the student. */
export interface PasswordChange {
  at: Date;
  by: "staff" | "student";
}

export interface ProvisionedStudentLogin extends IssuedPassword {
  account: StudentLoginAccount;
}

const STUDENT_ROLE_KEY = "STUDENT";

/** Under a student's temporary password, wherever it is issued. */
export const STUDENT_TEMP_PASSWORD_NOTICE =
  "Copy this now and hand it over in person or by a channel you trust, not a shared inbox. It is temporary: " +
  "the student must choose their own password when they first sign in. Authorised staff can reveal their " +
  "current password later from their record, and every reveal is recorded.";

type Tx = Prisma.TransactionClient;

/**
 * Refuses, with nothing changed, when student passwords cannot be kept
 * recoverable right now — the student-password encryption key is missing or
 * malformed. Asked before every write that must seal a password.
 */
export function requireStudentPasswordStorage(operation: string): void {
  try {
    requireStudentPasswordKey();
  } catch (error) {
    if (!(error instanceof SecretBoxError)) throw error;
    console.error(JSON.stringify({ log: "student_password.key_unavailable", operation, reason: error.reason }));
    throw new StudentError(
      "Student passwords can't be stored on this server right now: its password encryption key is not configured. Nothing was changed.",
    );
  }
}

/** The same CSPRNG generator the faculty and administrator flows use. */
function newPassword(): string {
  return randomBytes(12).toString("base64url");
}

/**
 * A temporary password and the hash that is all that is stored of it. Hashed
 * before any transaction opens: scrypt is deliberately slow, and a
 * transaction held open for it would hold its locks as long.
 */
export async function issueTemporaryPassword(): Promise<{ password: string; passwordHash: string }> {
  const password = newPassword();
  return { password, passwordHash: await hashPassword(password) };
}

function requireInstitution(
  actor: SessionUser,
  narrower: "studentLogin.manage" | "studentLogin.reveal" = "studentLogin.manage",
): string {
  // `user.invite` is the permission that already means "may create an account
  // in this institution" — it is what the faculty directory checks. Reusing it
  // keeps one answer to that question rather than inventing a second. A
  // receptionist holds only the narrower slice for the one operation: student
  // logins (`studentLogin.manage`), or seeing one's password
  // (`studentLogin.reveal`) — never staff accounts.
  requireAnyPermission(actor, "user.invite", narrower);
  if (!actor.institutionId) {
    throw new StudentError(
      "This account is not scoped to a single institution, so it cannot provision student logins here.",
    );
  }
  return actor.institutionId;
}

/**
 * An optional sign-in address, normalised, or null when none was given. The
 * student ID is always a way in; an address is a second one, for a student
 * who has one.
 */
function optionalEmail(raw: string | undefined): string | null {
  const email = (raw ?? "").trim().toLowerCase();
  if (email === "") return null;
  return requireEmail(email);
}

/** A sign-in address, normalised and checked — the one this account signs in with. */
export function requireEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (email === "") throw new StudentError("Enter an email address for the student to sign in with.");
  if (isPlaceholderLoginEmail(email)) throw new StudentError("That does not look like an email address.");
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
  input: { email?: string },
): Promise<ProvisionedStudentLogin> {
  const institutionId = requireInstitution(actor);
  const realEmail = optionalEmail(input.email);

  const student = await prisma.student.findFirst({
    where: { id: studentId, institutionId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      userId: true,
      status: true,
      studentCode: true,
    },
  });
  if (!student) {
    throw new StudentError("That student is not in this institution.");
  }
  if (student.status !== "ACTIVE") {
    throw new StudentError(
      "This student is not on roll, so a login could not be used. Bring them back on roll first.",
    );
  }
  if (student.userId) {
    throw new StudentError(
      "This student already has a login. Issue a new password from here instead of creating a second account.",
    );
  }

  // Without an address of their own, the account gets a reserved stand-in
  // that is never shown and never accepted as a sign-in email; the student ID
  // is how they sign in. See auth-tenancy/student-login-policy.ts.
  const email = realEmail ?? placeholderLoginEmail(student.id);
  const roleId = await prepareLogin(email);
  requireStudentPasswordStorage("provision");
  const { password, passwordHash } = await issueTemporaryPassword();

  const userId = await prisma.$transaction((tx) =>
    createStudentLoginWithin(tx, actor, { institutionId, roleId, student, email, realEmail, password, passwordHash }),
  );

  return {
    account: {
      userId,
      loginId: student.studentCode,
      email: realEmail,
      status: "ACTIVE",
      studentOnRoll: true,
      lastLoginAt: null,
      institutionId,
      mustChangePassword: true,
      lastPasswordChange: { at: new Date(), by: "staff" },
      passwordRecoverable: true,
    },
    password,
    notice: STUDENT_TEMP_PASSWORD_NOTICE,
  };
}

/**
 * The checks a new login's address must pass before anything is written, and
 * the STUDENT role it will hold. The address may not be any account's already
 * — the unique index on `User.email` is the real guarantee, this is the
 * explanation.
 */
export async function prepareLogin(email: string): Promise<string> {
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
  return role.id;
}

/**
 * The login's rows, inside a transaction the caller holds: the account —
 * waiting for its first password change — its one STUDENT role, the link from
 * the student, the recoverable copy of its temporary password, and the audit
 * row. The one place a student login is written; `provisionStudentLogin` and
 * a new student admitted with a login both come here, after `user.invite`,
 * the address and the student-password key have been checked. If the password
 * cannot be sealed, the whole transaction rolls back.
 */
export async function createStudentLoginWithin(
  tx: Tx,
  actor: SessionUser,
  input: {
    institutionId: string;
    roleId: string;
    student: { id: string; firstName: string; lastName: string; studentCode: string };
    /** What the account's email column holds: the real address, or the reserved stand-in. */
    email: string;
    /** The real address, if there is one — the only one ever written to the audit row. */
    realEmail: string | null;
    /** The temporary password, sealed here; never written in the clear. */
    password: string;
    passwordHash: string;
  },
): Promise<string> {
  requireAnyPermission(actor, "user.invite", "studentLogin.manage");
  const { institutionId, student } = input;
  const name = `${student.firstName} ${student.lastName}`.trim();

  const user = await tx.user.create({
    data: {
      institutionId,
      campusId: null,
      name,
      email: input.email,
      passwordHash: input.passwordHash,
      status: "ACTIVE",
      // Issued by staff, so the student replaces it before anything else.
      mustChangePassword: true,
    },
    select: { id: true },
  });

  await tx.userRoleAssignment.create({
    data: { userId: user.id, roleId: input.roleId, institutionId, campusId: null },
  });

  // The bridge. `Student.userId` is unique, so this is also what stops a
  // second account ever pointing at the same student — the constraint, not
  // the check above, is the real guarantee.
  await tx.student.update({ where: { id: student.id }, data: { userId: user.id } });

  await storeRecoverablePasswordWithin(tx, user.id, input.password);

  await recordAuditLog(
    {
      action: "user.created",
      entityType: "User",
      entityId: user.id,
      institutionId,
      actorUserId: actor.userId,
      afterJson: {
        name,
        email: input.realEmail,
        loginId: student.studentCode,
        roleKey: STUDENT_ROLE_KEY,
        studentId: student.id,
        passwordChangeRequired: true,
      },
    },
    tx,
  );

  return user.id;
}

/**
 * The account a student's record links to, if it is a student account of
 * this institution — refused otherwise. `Student.userId` is only ever set to a
 * STUDENT account (above), so this refuses nothing that exists; it is here so
 * that a record linked to a staff account some other way could never make
 * that account's password resettable, or the account switchable, from a
 * student's screen.
 */
async function requireStudentAccount(db: Tx | typeof prisma, institutionId: string, userId: string): Promise<void> {
  if (!(await isStudentAccount(db, institutionId, userId))) {
    throw new StudentError("This sign-in is not a student account, so it cannot be managed from a student's record.");
  }
}

/** Whether the account is this institution's and holds the STUDENT role and nothing else. */
async function isStudentAccount(db: Tx | typeof prisma, institutionId: string, userId: string): Promise<boolean> {
  const account = await db.user.findFirst({
    where: { id: userId, institutionId },
    select: { roleAssignments: { select: { role: { select: { key: true } } } } },
  });
  const keys = account?.roleAssignments.map((assignment) => assignment.role.key) ?? [];
  return Boolean(account) && keys.length > 0 && keys.every((key) => key === STUDENT_ROLE_KEY);
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
  const userId = student.userId;
  await requireStudentAccount(prisma, institutionId, userId);
  requireStudentPasswordStorage("reset");

  const { password, passwordHash } = await issueTemporaryPassword();

  await prisma.$transaction(async (tx) => {
    // The account's row lock first, as every password write takes it: a
    // student changing their password at the same moment waits, or is waited
    // for, so the hash and the recoverable copy end up naming one password.
    await lockAccountForPasswordWrite(tx, userId);
    // The old password stops working here — its hash is overwritten and its
    // recoverable copy replaced — and so does every session it opened. The
    // new one is temporary too.
    await tx.user.update({ where: { id: userId }, data: { passwordHash, mustChangePassword: true } });
    await storeRecoverablePasswordWithin(tx, userId, password);
    await tx.session.deleteMany({ where: { userId } });
    await recordAuditLog(
      {
        action: "user.updated",
        entityType: "User",
        entityId: userId,
        institutionId,
        actorUserId: actor.userId,
        afterJson: { studentId, passwordReset: true, sessionsEnded: true, passwordChangeRequired: true },
      },
      tx,
    );
  });

  return { password, notice: STUDENT_TEMP_PASSWORD_NOTICE };
}

/**
 * When a login's password was last set, and whether staff issued it or the
 * student chose it — from the audit rows those three writes leave (a login
 * created, a reset, a change of one's own). Dates only: the rows hold no
 * password, and nothing here reads one.
 */
export async function lastPasswordChangeOf(userId: string): Promise<PasswordChange | null> {
  const row = await prisma.auditLog.findFirst({
    where: {
      entityType: "User",
      entityId: userId,
      OR: [
        { action: "user.created" },
        { action: "user.updated", afterJson: { path: ["passwordReset"], equals: true } },
        { action: "user.updated", afterJson: { path: ["passwordChanged"], equals: true } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, afterJson: true },
  });
  if (!row) return null;
  const after = row.afterJson as { passwordChanged?: unknown } | null;
  return { at: row.createdAt, by: after?.passwordChanged === true ? "student" : "staff" };
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
    select: {
      studentCode: true,
      status: true,
      institutionId: true,
      user: {
        select: {
          id: true,
          email: true,
          status: true,
          lastLoginAt: true,
          mustChangePassword: true,
          recoverablePassword: { select: { id: true } },
        },
      },
    },
  });
  if (!student?.user) return null;

  return {
    userId: student.user.id,
    loginId: student.studentCode,
    email: isPlaceholderLoginEmail(student.user.email) ? null : student.user.email,
    status: student.user.status === "ACTIVE" ? "ACTIVE" : "INACTIVE",
    studentOnRoll: student.status === "ACTIVE",
    lastLoginAt: student.user.lastLoginAt,
    institutionId: student.institutionId,
    mustChangePassword: student.user.mustChangePassword,
    lastPasswordChange: await lastPasswordChangeOf(student.user.id),
    passwordRecoverable: student.user.recoverablePassword !== null,
  };
}

/**
 * Switches a student's login off or back on.
 *
 * Off ends every session the login has open, on every device; on lets it sign
 * in again with the password it already has — nothing is reissued or shown.
 * The student, their record and their attendance are untouched either way.
 */
export async function setStudentLoginEnabled(
  actor: SessionUser,
  studentId: string,
  enabled: boolean,
): Promise<StudentLoginAccount> {
  const institutionId = requireInstitution(actor);

  const student = await prisma.student.findFirst({
    where: { id: studentId, institutionId },
    select: { userId: true },
  });
  if (!student) throw new StudentError("That student is not in this institution.");
  if (!student.userId) throw new StudentError("This student does not have a login yet.");
  const userId = student.userId;
  await requireStudentAccount(prisma, institutionId, userId);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: userId },
      data: { status: enabled ? "ACTIVE" : "INACTIVE" },
    });
    const ended = enabled
      ? { count: 0 }
      : await tx.session.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
    await recordAuditLog(
      {
        action: enabled ? "user.reactivated" : "user.deactivated",
        entityType: "User",
        entityId: userId,
        institutionId,
        actorUserId: actor.userId,
        afterJson: { studentId, studentLogin: enabled ? "enabled" : "disabled", sessionsEnded: ended.count },
      },
      tx,
    );
  });

  const account = await getStudentLogin(actor, studentId);
  if (!account) throw new StudentError("This student does not have a login yet.");
  return account;
}

/** Why a password reveal was refused. Recorded; never says more than this. */
export type RevealRefusalReason =
  | "not_permitted"
  | "out_of_scope"
  | "no_account"
  | "not_on_roll"
  | "account_disabled"
  | "not_student_account"
  | "not_configured";

/** A reveal refused for a reason the caller records and shows. */
export class RevealRefusal extends Error {
  readonly reason: RevealRefusalReason;
  constructor(reason: RevealRefusalReason, message: string) {
    super(message);
    this.name = "RevealRefusal";
    this.reason = reason;
  }
}

export type RevealedStudentPassword =
  | { status: "revealed"; password: string }
  /** Nothing recoverable (an account from before this), or a stored copy that will not open. */
  | { status: "unavailable"; reason: "none" | "unreadable" };

/**
 * A student account's current password, for the member of staff who
 * explicitly asked to see it — the one place it is ever decrypted.
 *
 * `user.invite` is required: the permission that already means "may manage
 * this institution's accounts", the one creating and resetting a student's
 * login take — or a receptionist's narrower `studentLogin.reveal`. A head of department reaches this only through the college
 * setup service, which lends it for this one call after confirming the
 * student is in one of their department's current sections. The student is
 * looked up within the actor's institution; the account must be switched on,
 * belong to a student on roll, and be a STUDENT account and nothing else.
 *
 * The audit row — who asked, whose account, which department — is written
 * before the password is returned, and a failure to write it means the
 * password is not returned. It carries no password, hash or ciphertext.
 */
export async function revealStudentLoginPassword(
  actor: SessionUser,
  studentId: string,
  context: {
    /** The roles of the person asking, as their session holds them. */
    actorRoles: readonly string[];
    /** The department the request was authorised through, for a head of department. */
    departmentId?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  },
): Promise<RevealedStudentPassword> {
  const institutionId = requireInstitution(actor, "studentLogin.reveal");

  const student = await prisma.student.findFirst({
    where: { id: studentId, institutionId },
    select: { id: true, status: true, userId: true, user: { select: { status: true } } },
  });
  if (!student) throw new RevealRefusal("out_of_scope", "That student is not in this institution.");
  if (!student.userId || !student.user) {
    throw new RevealRefusal("no_account", "This student does not have a portal account.");
  }
  if (student.status !== "ACTIVE") {
    throw new RevealRefusal("not_on_roll", "This student is not on roll, so their password is not shown.");
  }
  if (student.user.status !== "ACTIVE") {
    throw new RevealRefusal("account_disabled", "This student's portal account is disabled, so its password is not shown.");
  }
  if (!(await isStudentAccount(prisma, institutionId, student.userId))) {
    throw new RevealRefusal("not_student_account", "This sign-in is not a student account.");
  }

  let recovered: Awaited<ReturnType<typeof openRecoverablePassword>>;
  try {
    recovered = await openRecoverablePassword(student.userId);
  } catch (error) {
    if (!(error instanceof SecretBoxError)) throw error;
    throw new RevealRefusal("not_configured", "Student passwords can't be shown on this server right now.");
  }
  if (recovered.status !== "available") return recovered;

  await recordAuditLog({
    action: "student.password_viewed",
    entityType: "User",
    entityId: student.userId,
    institutionId,
    actorUserId: actor.userId,
    afterJson: {
      studentId: student.id,
      departmentId: context.departmentId ?? null,
      actorRoles: [...context.actorRoles],
      result: "revealed",
    },
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
  });

  return { status: "revealed", password: recovered.password };
}
