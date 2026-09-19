import type { PermissionKey } from "@/modules/authorization/permissions";

/**
 * The handful of things somebody actually opens the dashboard to start.
 *
 * Same contract as `nav-items.ts`, for the same reasons: pure, takes a
 * predicate rather than a session, and filtered on the server so the browser
 * is handed only the actions this account may take. And — as everywhere — a
 * hidden action is a convenience, not a control. Every destination below
 * enforces its own permission on arrival; removing this file would change
 * what the page offers and nothing about what it allows.
 *
 * Kept short on purpose. A "quick actions" panel listing fourteen links is the
 * sidebar again, with worse labels.
 */
export interface QuickAction {
  href: string;
  label: string;
  /** One line on why you would press it — the panel is for people who do not
   *  yet know this product's vocabulary. */
  description: string;
  permission: PermissionKey;
  /** Hide at the other kind of institution, as in `nav-items.ts`. */
  only?: "SCHOOL" | "COLLEGE";
}

export const QUICK_ACTIONS: QuickAction[] = [
  {
    href: "/dashboard/attendance",
    label: "Take attendance",
    description: "Open a register for a class you teach.",
    permission: "attendanceSession.create",
  },
  {
    href: "/dashboard/students/new",
    label: "Add a student",
    description: "Create a student record and enrol them in a class.",
    permission: "student.create",
  },
  {
    href: "/dashboard/academic/cohorts/new",
    label: "Create a class",
    description: "Set up a new cohort for the current academic session.",
    permission: "academicStructure.manage",
  },
  {
    href: "/dashboard/face-enrollment",
    label: "Enrol faces",
    description: "Capture face templates so recognition has something to match.",
    permission: "faceEmbedding.manage",
  },
  {
    href: "/dashboard/reports",
    label: "Run a report",
    description: "Attendance across classes, for a date range you choose.",
    permission: "institution.read",
  },
  {
    href: "/dashboard/api-keys",
    label: "Issue an API key",
    description: "Let another system read attendance over the public API.",
    permission: "institution.read",
  },
];

export function buildQuickActions(
  can: (permission: PermissionKey) => boolean,
  kind: "SCHOOL" | "COLLEGE" | null,
): QuickAction[] {
  return QUICK_ACTIONS.filter(
    (action) =>
      can(action.permission) &&
      // An unknown kind is a platform-level account; as in the sidebar, it is
      // not this function's job to decide what a cross-institution operator
      // may look at.
      (!action.only || kind === null || action.only === kind),
  );
}
