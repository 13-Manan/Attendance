import { randomBytes } from "node:crypto";
import { recordAuditLog as defaultRecordAuditLog } from "@/modules/audit/service";
import type { RecordAuditLogInput } from "@/modules/audit/types";
import { requirePermission } from "@/modules/authorization/service";
import type { PermissionKey } from "@/modules/authorization/permissions";
import type { SessionUser } from "@/modules/auth-tenancy/types";
import { hashPassword } from "@/modules/auth-tenancy/password";
import * as repo from "./directory-repository";
import {
  validateEmployeeCode,
  validateFacultyEmail,
  validateFacultyName,
  validateFacultyRole,
} from "./directory-policy";
import {
  FacultyError,
  TEMP_PASSWORD_NOTICE,
  type FacultyDirectory,
  type FacultyMember,
  type IssuedPassword,
} from "./directory-types";

/**
 * Faculty administration: who teaches here, what they teach, and who may sign
 * in.
 *
 * ## Permissions
 *
 * `institution.read` to see the directory; `user.invite` to add an account or
 * restore one; `user.update` to change a name or issue a new password;
 * `user.deactivate` to stop one; `cohort.manage` to change what somebody
 * teaches. All six already exist in the catalogue and are already granted to
 * the seeded administrator roles — no new permission key is introduced here,
 * because a key that exists in code and in nobody's database locks
 * administrators out of the screen it was meant to govern.
 *
 * Reactivation is gated on `user.invite` rather than `user.deactivate`: it
 * restores someone's ability to sign in, which is the same decision as
 * granting it in the first place, and a role that can only stop accounts
 * should not be able to start them again.
 *
 * The tenant comes from the session. No function here takes an institution id.
 *
 * ## Passwords
 *
 * This service is the only place in the product that sets a staff password.
 * It generates one, hashes it with the same scrypt function the login path
 * verifies against, hands the plaintext back to the caller once, and keeps no
 * copy. The audit row records *that* a password was issued and by whom, never
 * the value — a log that contains a working credential is a second copy of the
 * thing the hash exists to avoid.
 *
 * Every password change also ends that account's open sessions, in the same
 * transaction. A reset that leaves an existing cookie working has not stopped
 * whoever prompted it.
 */

export interface FacultyDeps {
  listStaff?: (institutionId: string) => Promise<
    Array<{
      id: string;
      name: string;
      email: string;
      employeeCode: string | null;
      status: string;
      lastLoginAt: Date | null;
      roleAssignments: Array<{ role: { key: string } }>;
    }>
  >;
  getStaff?: typeof repo.getStaffRow;
  idsWithPassword?: (institutionId: string) => Promise<string[]>;
  findByEmail?: (email: string) => Promise<{ id: string } | null>;
  findRole?: (institutionId: string, key: string) => Promise<{ id: string; key: string } | null>;
  createStaff?: typeof repo.createStaffRow;
  updateStaff?: typeof repo.updateStaffRow;
  setStatus?: typeof repo.setStaffStatusRow;
  setPassword?: (institutionId: string, id: string, hash: string) => Promise<boolean>;
  endSessions?: (id: string) => Promise<void>;
  listClassLinks?: typeof repo.listClassLinks;
  listSubjectLinks?: typeof repo.listSubjectLinks;
  listCohorts?: typeof repo.listCohortOptions;
  getClassLink?: typeof repo.getClassLink;
  deleteClassLink?: (linkId: string) => Promise<void>;
  getCohortSubject?: typeof repo.getCohortSubject;
  setSubjectFaculty?: (cohortSubjectId: string, facultyId: string | null) => Promise<void>;
  audit?: (input: RecordAuditLogInput) => Promise<void>;
  newPassword?: () => string;
  hashSecret?: (plain: string) => Promise<string>;
}

/**
 * A temporary password that a person has to type once, on a phone, having been
 * read it over a desk.
 *
 * Base64url over 12 random bytes: 96 bits, which is far beyond guessing, and
 * no character that is ambiguous in a different font or lost to a keyboard
 * layout. Deliberately not a memorable word list — a memorable password is one
 * that gets kept.
 */
function defaultNewPassword(): string {
  return randomBytes(12).toString("base64url");
}

function deps(overrides: FacultyDeps) {
  return {
    listStaff: overrides.listStaff ?? repo.listStaffRows,
    getStaff: overrides.getStaff ?? repo.getStaffRow,
    idsWithPassword: overrides.idsWithPassword ?? repo.listUserIdsWithPassword,
    findByEmail: overrides.findByEmail ?? repo.findUserByEmailAnywhere,
    findRole: overrides.findRole ?? repo.findRoleForKey,
    createStaff: overrides.createStaff ?? repo.createStaffRow,
    updateStaff: overrides.updateStaff ?? repo.updateStaffRow,
    setStatus: overrides.setStatus ?? repo.setStaffStatusRow,
    setPassword: overrides.setPassword ?? repo.setStaffPasswordRow,
    endSessions: overrides.endSessions ?? repo.endSessionsForUser,
    listClassLinks: overrides.listClassLinks ?? repo.listClassLinks,
    listSubjectLinks: overrides.listSubjectLinks ?? repo.listSubjectLinks,
    listCohorts: overrides.listCohorts ?? repo.listCohortOptions,
    getClassLink: overrides.getClassLink ?? repo.getClassLink,
    deleteClassLink: overrides.deleteClassLink ?? repo.deleteClassLink,
    getCohortSubject: overrides.getCohortSubject ?? repo.getCohortSubject,
    setSubjectFaculty: overrides.setSubjectFaculty ?? repo.setCohortSubjectFacultyRow,
    audit: overrides.audit ?? ((input: RecordAuditLogInput) => defaultRecordAuditLog(input)),
    newPassword: overrides.newPassword ?? defaultNewPassword,
    hashSecret: overrides.hashSecret ?? hashPassword,
  };
}

function requireInstitution(actor: SessionUser, permission: PermissionKey): string {
  requirePermission(actor, permission);
  if (!actor.institutionId) {
    throw new FacultyError(
      "This account is not scoped to a single institution, so it cannot manage staff here.",
    );
  }
  return actor.institutionId;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getFacultyDirectory(
  actor: SessionUser,
  overrides: FacultyDeps = {},
): Promise<FacultyDirectory> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "institution.read");

  const [rows, withPassword, classLinks, subjectLinks, cohorts] = await Promise.all([
    d.listStaff(institutionId),
    d.idsWithPassword(institutionId),
    d.listClassLinks(institutionId),
    d.listSubjectLinks(institutionId),
    d.listCohorts(institutionId),
  ]);

  return {
    members: repo.assembleMembers(rows, withPassword, classLinks, subjectLinks),
    cohorts,
    cohortSubjects: subjectLinks,
  };
}

async function requireMember(
  d: ReturnType<typeof deps>,
  institutionId: string,
  id: string,
): Promise<{ id: string; name: string; email: string; employeeCode: string | null; status: string }> {
  const row = await d.getStaff(institutionId, id);
  if (!row) throw new FacultyError("That account does not belong to this institution.");
  return row;
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface InvitedFaculty extends IssuedPassword {
  member: FacultyMember;
}

export async function inviteFaculty(
  actor: SessionUser,
  input: { name: string; email: string; employeeCode?: string; roleKey: string },
  overrides: FacultyDeps = {},
): Promise<InvitedFaculty> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "user.invite");

  const name = validateFacultyName(input.name);
  const email = validateFacultyEmail(input.email);
  const employeeCode = validateEmployeeCode(input.employeeCode);
  const roleKey = validateFacultyRole(input.roleKey);

  const existing = await d.findByEmail(email);
  if (existing) {
    // Says an address is taken without saying by whom: the row may belong to
    // another institution, and confirming that is a small leak of who works
    // where. The administrator's next step is the same either way.
    throw new FacultyError(
      `An account already uses ${email}. If that is the same person, ask the platform ` +
        `administrator to move it — an address can only belong to one account.`,
    );
  }

  const role = await d.findRole(institutionId, roleKey);
  if (!role) {
    throw new FacultyError(
      `The "${roleKey}" role is not set up for this institution. Ask the platform administrator to seed it.`,
    );
  }

  const password = d.newPassword();
  const passwordHash = await d.hashSecret(password);

  const row = await d.createStaff({
    institutionId,
    // The new account inherits the inviting administrator's campus. An
    // institution-wide administrator (campusId null) creates an
    // institution-wide account, which is the existing convention for every
    // other row this product creates.
    campusId: actor.campusId ?? null,
    name,
    email,
    employeeCode,
    passwordHash,
    roleId: role.id,
  });

  await d.audit({
    action: "user.created",
    entityType: "User",
    entityId: row.id,
    institutionId,
    actorUserId: actor.userId,
    // Who, what access, and nothing that could be used to sign in as them.
    afterJson: { name, email, employeeCode, roleKey },
  });

  return {
    member: repo.assembleMembers([row], [row.id], [], [])[0],
    password,
    notice: TEMP_PASSWORD_NOTICE,
  };
}

export async function updateFacultyDetails(
  actor: SessionUser,
  id: string,
  input: { name: string; employeeCode?: string },
  overrides: FacultyDeps = {},
): Promise<FacultyMember> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "user.update");

  const before = await requireMember(d, institutionId, id);
  const name = validateFacultyName(input.name);
  const employeeCode = validateEmployeeCode(input.employeeCode);

  const updated = await d.updateStaff(institutionId, id, { name, employeeCode });
  if (!updated) throw new FacultyError("That account does not belong to this institution.");

  await d.audit({
    action: "user.updated",
    entityType: "User",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { name: before.name, employeeCode: before.employeeCode },
    afterJson: { name: updated.name, employeeCode: updated.employeeCode },
  });

  return repo.assembleMembers([updated], [], [], [])[0];
}

/**
 * Stops an account.
 *
 * Deactivation rather than deletion, and not only for the audit trail: the
 * rows this person created — the registers they opened, the corrections they
 * made — reference their id, and "who confirmed this attendance?" must stay
 * answerable after they leave. `loginService` already refuses a non-ACTIVE
 * account, and the open sessions are ended here so the refusal takes effect
 * now rather than whenever the current cookie expires.
 *
 * An administrator cannot deactivate themselves. The failure mode is an
 * institution with nobody able to sign in and administer it, recoverable only
 * by someone with database access.
 */
export async function deactivateFaculty(
  actor: SessionUser,
  id: string,
  overrides: FacultyDeps = {},
): Promise<FacultyMember> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "user.deactivate");

  if (id === actor.userId) {
    throw new FacultyError(
      "You cannot deactivate your own account. Ask another administrator to do it.",
    );
  }

  const before = await requireMember(d, institutionId, id);
  if (before.status === "INACTIVE") throw new FacultyError("That account is already stopped.");

  const updated = await d.setStatus(institutionId, id, "INACTIVE");
  if (!updated) throw new FacultyError("That account does not belong to this institution.");
  await d.endSessions(id);

  await d.audit({
    action: "user.deactivated",
    entityType: "User",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { name: before.name, email: before.email, status: "ACTIVE" },
    afterJson: { name: updated.name, email: updated.email, status: "INACTIVE" },
  });

  return repo.assembleMembers([updated], [], [], [])[0];
}

export async function reactivateFaculty(
  actor: SessionUser,
  id: string,
  overrides: FacultyDeps = {},
): Promise<FacultyMember> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "user.invite");

  const before = await requireMember(d, institutionId, id);
  if (before.status === "ACTIVE") throw new FacultyError("That account is already active.");

  const updated = await d.setStatus(institutionId, id, "ACTIVE");
  if (!updated) throw new FacultyError("That account does not belong to this institution.");

  await d.audit({
    action: "user.reactivated",
    entityType: "User",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { name: before.name, email: before.email, status: "INACTIVE" },
    afterJson: { name: updated.name, email: updated.email, status: "ACTIVE" },
  });

  return repo.assembleMembers([updated], [], [], [])[0];
}

/**
 * Issues a new temporary password for somebody who has lost theirs.
 *
 * The old one stops working the moment this returns, and so does every session
 * opened with it. There is no way to read the existing password — nothing
 * stores it — so "resend it" is not a thing this function could do even if it
 * were asked to.
 */
export async function resetFacultyPassword(
  actor: SessionUser,
  id: string,
  overrides: FacultyDeps = {},
): Promise<IssuedPassword> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "user.update");

  const member = await requireMember(d, institutionId, id);

  const password = d.newPassword();
  const passwordHash = await d.hashSecret(password);
  const ok = await d.setPassword(institutionId, id, passwordHash);
  if (!ok) throw new FacultyError("That account does not belong to this institution.");

  await d.audit({
    action: "user.updated",
    entityType: "User",
    entityId: id,
    institutionId,
    actorUserId: actor.userId,
    // States the fact, carries neither the old hash nor the new password.
    afterJson: { email: member.email, passwordReset: true, sessionsEnded: true },
  });

  return { password, notice: TEMP_PASSWORD_NOTICE };
}

// ---------------------------------------------------------------------------
// What somebody teaches
// ---------------------------------------------------------------------------

/**
 * Removes a class-teacher link.
 *
 * Assignment already exists in `modules/cohorts/service.ts` and is reused
 * rather than reimplemented here; only removal was missing. The link row is
 * deleted rather than flagged because, unlike an account, it is not referenced
 * by anything: the registers this teacher opened reference the *session* and
 * the *user*, not this join row, so removing it changes who may open a new
 * register and rewrites no history.
 */
export async function removeClassTeacher(
  actor: SessionUser,
  linkId: string,
  overrides: FacultyDeps = {},
): Promise<void> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "cohort.manage");

  const link = await d.getClassLink(linkId);
  if (!link || link.institutionId !== institutionId) {
    throw new FacultyError("That assignment does not belong to this institution.");
  }

  await d.deleteClassLink(linkId);

  await d.audit({
    action: "cohort_faculty.removed",
    entityType: "CohortFaculty",
    entityId: linkId,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { cohortId: link.cohortId, userId: link.userId, role: link.role },
  });
}

/**
 * Sets, changes or clears who teaches a subject in a class.
 *
 * Clearing is allowed and is not the same as deleting the offering: a subject
 * with no faculty is a subject nobody has been assigned yet, which is a real
 * state in the week before term starts. What it does mean is that nobody can
 * open a register for it, and the screen says so.
 */
export async function setSubjectFaculty(
  actor: SessionUser,
  cohortSubjectId: string,
  facultyId: string | null,
  overrides: FacultyDeps = {},
): Promise<void> {
  const d = deps(overrides);
  const institutionId = requireInstitution(actor, "cohort.manage");

  const offering = await d.getCohortSubject(cohortSubjectId);
  if (!offering || offering.institutionId !== institutionId) {
    throw new FacultyError("That subject does not belong to this institution.");
  }

  if (facultyId) {
    // The tenant check that matters: without it, an id pasted into the form
    // would attach another institution's teacher to this register, and with
    // it that teacher would be able to see these students.
    const member = await d.getStaff(institutionId, facultyId);
    if (!member) {
      throw new FacultyError("That person is not a member of staff at this institution.");
    }
    if (member.status !== "ACTIVE") {
      throw new FacultyError(
        "That account is stopped. Reactivate it before assigning a class to it.",
      );
    }
  }

  await d.setSubjectFaculty(cohortSubjectId, facultyId);

  await d.audit({
    action: "cohort_subject.faculty_assigned",
    entityType: "CohortSubject",
    entityId: cohortSubjectId,
    institutionId,
    actorUserId: actor.userId,
    beforeJson: { facultyId: offering.facultyId },
    afterJson: {
      facultyId,
      cohortName: offering.cohortName,
      subjectCode: offering.subjectCode,
    },
  });
}
