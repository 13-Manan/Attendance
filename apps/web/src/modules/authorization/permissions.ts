// The permission catalog is code, not data: a permission key only exists
// once some Server Action/page/Route Handler ships a check for it — that's
// a deploy-time fact, not something an institution admin should be able to
// invent through a UI. What IS runtime-configurable is which permissions a
// role grants (Role/RolePermission tables) and what a role is called.

export const PERMISSIONS = [
  "platform.institution.create",
  "platform.institution.suspend",
  "institution.read",
  "institution.update",
  "campus.manage",
  "academicStructure.manage",
  "cohort.manage",
  "cohort.read",
  "user.invite",
  "user.update",
  "user.deactivate",
  "role.assign",
  "role.read",
  "student.create",
  "student.update",
  "student.read",
  "student.read.own",
  "enrollment.manage",
  "attendanceSession.create",
  "attendanceSession.capture",
  "attendanceSession.finalize",
  "attendanceRecord.correct",
  "attendanceRecord.read",
  "attendanceRecord.read.own",
  "faceEmbedding.manage",
  // Student self-enrollment (college workflow) — a caller with this
  // permission may only enroll their OWN linked student profile (enforced
  // in modules/face-enrollment/service.ts). NEVER grant to a role that
  // could target other students.
  "faceEmbedding.enroll.own",
  "auditLog.read",
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number];

export interface SystemRoleDefinition {
  key: string;
  name: string;
  permissions: PermissionKey[];
}

const ADMIN_PERMISSIONS: PermissionKey[] = [
  "institution.read",
  "institution.update",
  "campus.manage",
  "academicStructure.manage",
  "cohort.manage",
  "cohort.read",
  "user.invite",
  "user.update",
  "user.deactivate",
  "role.assign",
  "role.read",
  "student.create",
  "student.update",
  "student.read",
  "enrollment.manage",
  "attendanceSession.create",
  "attendanceSession.capture",
  "attendanceSession.finalize",
  "attendanceRecord.correct",
  "attendanceRecord.read",
  "faceEmbedding.manage",
  "auditLog.read",
];

const FACULTY_PERMISSIONS: PermissionKey[] = [
  "cohort.read",
  "student.read",
  "attendanceSession.create",
  "attendanceSession.capture",
  // The faculty member who taught the class is the one who confirms its
  // register (Phase 6: "Faculty confirms: [Confirm Attendance]"). Scope is
  // still enforced per session by requireCohortAccess — this grants the
  // ability to close a register they teach, not any register. It also gates
  // the post-finalization correction path, which is deliberate: whoever may
  // close a register may reopen a line in it.
  "attendanceSession.finalize",
  "attendanceRecord.correct",
  "attendanceRecord.read",
];

// The 8 roles the product requires "at minimum." Role NAMES are configurable
// per institution (Role.name can be edited); these keys and their default
// permission sets are the seeded starting point. See docs/adr/0006.
export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    key: "PLATFORM_SUPER_ADMIN",
    name: "Platform Super Admin",
    permissions: [...PERMISSIONS],
  },
  {
    key: "INSTITUTION_ADMIN",
    name: "Institution Admin",
    permissions: ADMIN_PERMISSIONS,
  },
  {
    key: "SCHOOL_ADMIN",
    name: "School Admin",
    permissions: ADMIN_PERMISSIONS,
  },
  {
    key: "COLLEGE_ADMIN",
    name: "College Admin",
    permissions: ADMIN_PERMISSIONS,
  },
  {
    key: "FACULTY",
    name: "Faculty / Teacher",
    permissions: FACULTY_PERMISSIONS,
  },
  {
    key: "CLASS_TEACHER",
    name: "Class Teacher",
    permissions: [...FACULTY_PERMISSIONS, "enrollment.manage", "student.update"],
  },
  {
    key: "STUDENT",
    name: "Student",
    permissions: [
      "student.read.own",
      "attendanceRecord.read.own",
      "cohort.read",
      // College self-enrollment workflow (Phase 3). School students
      // typically don't have this — schools use staff-driven enrollment.
      "faceEmbedding.enroll.own",
    ],
  },
  {
    key: "ATTENDANCE_OPERATOR",
    name: "Attendance Operator / Staff",
    // Deliberately no attendanceRecord.correct or attendanceSession.finalize —
    // mirrors "AI is advisory, faculty is authoritative" (ARCHITECTURE.md):
    // staff can run capture, never correct or finalize a result.
    permissions: ["cohort.read", "attendanceSession.create", "attendanceSession.capture"],
  },
];
