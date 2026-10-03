import type { PermissionKey } from "@/modules/authorization/permissions";

/**
 * What a school receptionist may be given, in the words a principal reads.
 *
 * Pure: no Prisma, no session. Each switch on the principal's screen is an
 * `AccessItem`, and each item grants a fixed set of permission keys. The keys
 * are the existing catalog's (modules/authorization/permissions.ts), including
 * the narrow receptionist slices described there — never a broader key that
 * would carry more than the switch says.
 *
 * Every item's keys include at least one no other item grants, so whether a
 * switch is on is read back from the role's keys exactly.
 */

/** A receptionist's own role: one per person, scoped to their school. */
export const RECEPTIONIST_ROLE_PREFIX = "RECEPTIONIST__";
export const RECEPTIONIST_ROLE_NAME = "Receptionist";

export function receptionistRoleKey(userId: string): string {
  return `${RECEPTIONIST_ROLE_PREFIX}${userId}`;
}

export function isReceptionistRoleKey(key: string): boolean {
  return key.startsWith(RECEPTIONIST_ROLE_PREFIX);
}

/** Whether a signed-in account is a receptionist. */
export function isReceptionist(user: { roles: ReadonlyArray<{ key: string }> }): boolean {
  return user.roles.some((role) => isReceptionistRoleKey(role.key));
}

export type AccessGroupId = "students" | "attendance" | "reports" | "academic" | "faculty" | "administration";

export interface AccessGroup {
  id: AccessGroupId;
  label: string;
  description: string;
}

export interface AccessItem {
  /** Stable; what the form submits and the audit row records. */
  id: string;
  group: AccessGroupId;
  label: string;
  description: string;
  grants: PermissionKey[];
  /** Other items this one cannot work without; switched on with it. */
  requires: string[];
  defaultOn: boolean;
  /** Turning it on asks first, with this sentence. */
  confirm?: string;
}

export const ACCESS_GROUPS: AccessGroup[] = [
  { id: "students", label: "Students", description: "Admissions, student records, logins and face enrollment." },
  { id: "attendance", label: "Attendance", description: "Taking and finishing any class's register." },
  { id: "reports", label: "Reports", description: "Attendance records and school reports." },
  { id: "academic", label: "Academic", description: "Classes, sections and class teachers." },
  { id: "faculty", label: "Faculty", description: "Teachers and staff." },
  {
    id: "administration",
    label: "Administration",
    description: "Settings, integrations and security. Off unless this person needs it.",
  },
];

export const ACCESS_ITEMS: AccessItem[] = [
  // --- Students ---------------------------------------------------------------
  {
    id: "students.directory",
    group: "students",
    label: "Student directory",
    description: "See students, their classes and verification status, and search and filter the list.",
    grants: ["student.read", "cohort.read"],
    requires: [],
    defaultOn: true,
  },
  {
    id: "students.add",
    group: "students",
    label: "Add students",
    description: "Admit new students. Putting them straight into a class also needs “Move students”.",
    grants: ["student.create"],
    requires: ["students.directory"],
    defaultOn: true,
  },
  {
    id: "students.edit",
    group: "students",
    label: "Edit and archive students",
    description: "Change a student's details, and take them off roll or back on. A student is never deleted.",
    grants: ["student.update"],
    requires: ["students.directory"],
    defaultOn: true,
  },
  {
    id: "students.placement",
    group: "students",
    label: "Move students between classes",
    description: "Place a student in a class, or move them to another one.",
    grants: ["enrollment.manage"],
    requires: ["students.directory"],
    defaultOn: true,
  },
  {
    id: "students.logins",
    group: "students",
    label: "Student portal logins",
    description: "Create a student's portal login, reset its password, and switch it on or off.",
    grants: ["studentLogin.manage"],
    requires: ["students.directory"],
    defaultOn: true,
  },
  {
    id: "students.passwords",
    group: "students",
    label: "See student portal passwords",
    description: "Show a student's current portal password — to read it out to a parent, say. Every view is recorded.",
    grants: ["studentLogin.reveal"],
    requires: ["students.directory"],
    defaultOn: true,
  },
  {
    id: "students.faces",
    group: "students",
    label: "Face enrollment",
    description:
      "Take or upload a student's face photos and redo them when they need re-enrolment. The usual quality and lookalike checks always apply.",
    grants: ["faceEmbedding.enroll"],
    requires: ["students.directory"],
    defaultOn: true,
  },
  {
    id: "students.twins",
    group: "students",
    label: "Twin and lookalike decisions",
    description:
      "Confirm that two students who look alike are different people, which unblocks their face enrollment. Face enrollment does not include this.",
    grants: ["twinConfirmation.decide"],
    requires: ["students.directory"],
    defaultOn: false,
    confirm:
      "Twin and lookalike decisions decide which face recognition may tell apart. Allow this person to make that call?",
  },

  // --- Attendance -------------------------------------------------------------
  {
    id: "attendance.take",
    group: "attendance",
    label: "Take attendance",
    description:
      "Take the class photo for any class and start its register. Comes with reviewing and finishing it — a register somebody starts must be one they can finish.",
    grants: ["attendanceSession.create", "attendanceSession.capture", "attendance.allClasses"],
    // The review screen's decisions need `attendanceRecord.correct`; without
    // it a register taken here would be one its taker could open and not
    // finish. So taking brings reviewing with it — reviewing alone is fine.
    requires: ["attendance.review", "reports.attendance"],
    defaultOn: true,
  },
  {
    id: "attendance.review",
    group: "attendance",
    label: "Review, finish and correct attendance",
    description:
      "Decide the students who need attention, finish a register, and correct one afterwards. Every change is recorded with its author.",
    grants: ["attendanceRecord.correct", "attendanceSession.finalize", "attendance.allClasses"],
    requires: ["reports.attendance"],
    defaultOn: true,
  },

  // --- Reports ----------------------------------------------------------------
  {
    id: "reports.attendance",
    group: "reports",
    label: "Attendance records and reports",
    description: "Every class's registers and history, school reports, printouts and exports.",
    grants: ["attendanceRecord.read", "attendance.allClasses"],
    requires: [],
    defaultOn: true,
  },

  // --- Academic ---------------------------------------------------------------
  {
    id: "academic.classes",
    group: "academic",
    label: "Manage classes and class teachers",
    description:
      "Create classes and sections, change the academic structure, and choose each class's teacher — which decides who can take its attendance.",
    grants: ["academicStructure.manage", "cohort.manage"],
    requires: ["students.directory"],
    defaultOn: false,
    confirm:
      "This lets them change the school's classes and choose class teachers, which decides who can take each class's attendance. Continue?",
  },

  // --- Faculty ----------------------------------------------------------------
  {
    id: "faculty.view",
    group: "faculty",
    label: "View staff",
    description: "The list of teachers and staff and what each one teaches. Never when anyone last signed in.",
    grants: ["staff.read"],
    requires: [],
    defaultOn: true,
  },
  {
    id: "faculty.manage",
    group: "faculty",
    label: "Add and manage teachers",
    description:
      "Add teacher accounts, edit them, reset their passwords and switch them on or off. Never the principal's account, an administrator's, or another receptionist's.",
    grants: ["staff.manage"],
    requires: ["faculty.view"],
    defaultOn: false,
    confirm:
      "This lets them create teacher sign-ins and reset teachers' passwords. Only turn it on if they run staff accounts for you. Continue?",
  },

  // --- Administration ---------------------------------------------------------
  {
    id: "admin.settings.view",
    group: "administration",
    label: "View school settings and integrations",
    description:
      "School profile and policies, integrations, API keys (never the key itself) and webhooks, and every staff member's email. Keep this off unless they need it.",
    grants: ["institution.read"],
    requires: [],
    defaultOn: false,
    confirm:
      "This shows school settings, integration details and webhook data. Keep it off unless they need it. Continue?",
  },
  {
    id: "admin.settings.manage",
    group: "administration",
    label: "Change school settings, API keys and integrations",
    description:
      "Edit school settings and policies, issue and revoke API keys, and connect integrations. Allows access to integration credentials — keep this off unless absolutely necessary.",
    grants: ["institution.update"],
    requires: ["admin.settings.view"],
    defaultOn: false,
    confirm:
      "API keys and integrations can read and change school data from outside this site. Give this person that power?",
  },
  {
    id: "admin.audit",
    group: "administration",
    label: "Audit log",
    description: "Who did what, including sign-ins and security events. Keep this off unless they review security.",
    grants: ["auditLog.read"],
    requires: [],
    defaultOn: false,
    confirm: "The audit log includes security events about every account, yours too. Continue?",
  },
];

/**
 * Never given to a receptionist, whatever a request asks for: authority over
 * roles and other people's accounts, the platform, and the keys whose narrow
 * slices above exist precisely so these need not be handed out.
 */
export const NEVER_GRANTABLE: ReadonlySet<PermissionKey> = new Set<PermissionKey>([
  "platform.institution.create",
  "platform.institution.suspend",
  "role.assign",
  "role.read",
  "user.invite",
  "user.update",
  "user.deactivate",
  "campus.manage",
  "department.manage",
  "faceEmbedding.manage",
  "faceEmbedding.enroll.own",
  "student.read.own",
  "attendanceRecord.read.own",
]);

/**
 * For each narrow receptionist key, the broader keys that already carry it: an
 * administrator holding those may grant it (see `mayGrant`).
 */
export const NARROWED_FROM: Partial<Record<PermissionKey, PermissionKey[]>> = {
  "attendance.allClasses": ["cohort.manage"],
  "studentLogin.manage": ["user.invite"],
  "studentLogin.reveal": ["user.invite"],
  "faceEmbedding.enroll": ["faceEmbedding.manage"],
  "twinConfirmation.decide": ["faceEmbedding.manage"],
  "staff.read": ["institution.read"],
  "staff.manage": ["user.invite", "user.update", "user.deactivate"],
};

const ITEMS_BY_ID = new Map(ACCESS_ITEMS.map((item) => [item.id, item]));

export function accessItem(id: string): AccessItem | undefined {
  return ITEMS_BY_ID.get(id);
}

/** What a new receptionist starts with: the everyday work, none of the administration. */
export function defaultAccess(): string[] {
  return ACCESS_ITEMS.filter((item) => item.defaultOn).map((item) => item.id);
}

/**
 * The switches that will actually be on: the known ones asked for, plus what
 * each needs. Unknown ids are dropped, never guessed at.
 */
export function resolveAccess(requested: readonly string[]): string[] {
  const on = new Set<string>();
  const visit = (id: string) => {
    const item = ITEMS_BY_ID.get(id);
    if (!item || on.has(id)) return;
    on.add(id);
    for (const dependency of item.requires) visit(dependency);
  };
  for (const id of requested) visit(id);
  return ACCESS_ITEMS.filter((item) => on.has(item.id)).map((item) => item.id);
}

/** The permission keys a set of switches grants, sorted and without repeats. */
export function permissionsFor(accessIds: readonly string[]): PermissionKey[] {
  const keys = new Set<PermissionKey>();
  for (const id of resolveAccess(accessIds)) {
    for (const key of ITEMS_BY_ID.get(id)!.grants) keys.add(key);
  }
  return [...keys].sort();
}

/** Which switches a role's keys amount to — on only when every key it grants is held. */
export function accessFromPermissions(keys: readonly string[]): string[] {
  const held = new Set(keys);
  return ACCESS_ITEMS.filter((item) => item.grants.every((key) => held.has(key))).map((item) => item.id);
}

/** "Students: 7 of 8 · Attendance: 2 of 2 · …" — the list's one-line summary. */
export function accessSummary(accessIds: readonly string[]): Array<{ group: AccessGroup; on: number; of: number }> {
  const on = new Set(accessIds);
  return ACCESS_GROUPS.map((group) => {
    const items = ACCESS_ITEMS.filter((item) => item.group === group.id);
    return { group, on: items.filter((item) => on.has(item.id)).length, of: items.length };
  });
}
