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
  // A college Head of Department: the semesters, courses, sections, teachers
  // and students of the ONE department they head, and nothing outside it.
  // Institution-wide by name only — which department is resolved on every
  // request by modules/college-setup/scope.ts from the HOD designation, and
  // every read and write there is checked against it. Deliberately not
  // `.own`: it confers authority over other people, which is exactly what
  // role-management's `.own` exception says a permission must not do.
  "department.manage",
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

// The 8 roles the product requires "at minimum," plus a college's Head of
// Department. Role NAMES are configurable per institution (Role.name can be
// edited); these keys and their default permission sets are the seeded
// starting point. See docs/adr/0006. A database only gains a role added here
// when `ensureSystemRolesAndPermissions` runs against it — `npm run prisma:seed`
// locally, `bootstrap:system` anywhere else (docs/DATABASE_OPERATIONS.md §4.2).
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
    // A college department's head: teaches like a lecturer, and runs one
    // department through modules/college-setup. What it lacks is the point.
    // No `student.read` or `cohort.read` — both are institution-wide
    // directories, and a Computer Science head must not be able to list
    // Mechanical Engineering's students or classes. No `cohort.manage`, which
    // bypasses every teaching check, and no account, structure or face
    // permission. Granted only by the department screen, which also sets the
    // department it applies to.
    key: "HOD",
    name: "Head of Department",
    permissions: [
      "department.manage",
      "attendanceSession.create",
      "attendanceSession.capture",
      "attendanceSession.finalize",
      "attendanceRecord.correct",
      "attendanceRecord.read",
    ],
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
