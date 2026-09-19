import type { PermissionKey } from "@/modules/authorization/permissions";

export type InstitutionKind = "SCHOOL" | "COLLEGE" | null;

/** The headings the sidebar groups links under, in the order they appear. */
export const NAV_GROUPS = [
  "Today",
  "People",
  "Academic",
  "Attendance",
  "Connect",
  "Administration",
] as const;

export type NavGroup = (typeof NAV_GROUPS)[number];

export interface NavItem {
  href: string;
  label: string;
  group: NavGroup;
  // Omit to show for any authenticated user; set to require a permission.
  permission?: PermissionKey;
  /** Used instead of `label` at a college, where the concept has another name. */
  collegeLabel?: string;
  /** Hide entirely at the other kind of institution. */
  only?: "SCHOOL" | "COLLEGE";
}

/**
 * Declarative, permission-filtered navigation.
 *
 * A UX convenience layered on top of — never a substitute for — the
 * server-side check each page performs itself. A hidden link is not what makes
 * a page safe; `requireUser()` / `requirePermissionOrRedirect()` inside the
 * page is what does. Every entry below points at a route that gates itself.
 *
 * ## Why it is grouped
 *
 * Fifteen flat links is a wall. Grouped, the sidebar answers "where would that
 * live?" before it answers "what is it called" — a teacher opening a register
 * and an administrator issuing an API key are looking in different places and
 * should not have to read past each other's sections.
 *
 * ## Why some labels depend on the institution
 *
 * A school has grades and sections; a college has departments, semesters and
 * courses. One route (`/dashboard/academic/units`) serves both, because it is
 * one tree in one table — see the abstraction note in `schema.prisma`. Calling
 * it "Sections" at a college would be wrong in the product's own terms, so the
 * label follows the institution. Subjects go further and disappear at a
 * school: `createSubjectForRequest` refuses `subjects_are_college_only`, and a
 * link to a screen that can only refuse is worse than no link.
 */
export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Overview", group: "Today" },

  { href: "/dashboard/students", label: "Students", group: "People", permission: "student.read" },
  { href: "/dashboard/faculty", label: "Faculty", group: "People", permission: "institution.read" },

  {
    href: "/dashboard/academic/cohorts",
    label: "Classes",
    group: "Academic",
    permission: "academicStructure.manage",
  },
  {
    href: "/dashboard/academic/units",
    label: "Sections",
    collegeLabel: "Programs & semesters",
    group: "Academic",
    permission: "academicStructure.manage",
  },
  {
    href: "/dashboard/academic/subjects",
    label: "Subjects",
    group: "Academic",
    permission: "academicStructure.manage",
    only: "COLLEGE",
  },
  {
    href: "/dashboard/academic/sessions",
    label: "Academic sessions",
    group: "Academic",
    permission: "academicStructure.manage",
  },

  {
    href: "/dashboard/attendance",
    label: "Attendance",
    group: "Attendance",
    permission: "attendanceSession.create",
  },
  {
    href: "/dashboard/offline",
    label: "Offline attendance",
    group: "Attendance",
    permission: "attendanceSession.capture",
  },
  { href: "/dashboard/reports", label: "Reports", group: "Attendance", permission: "institution.read" },
  {
    href: "/dashboard/face-enrollment",
    label: "Face enrollment",
    group: "Attendance",
    permission: "faceEmbedding.manage",
  },

  {
    href: "/dashboard/integrations",
    label: "Integrations",
    group: "Connect",
    permission: "institution.read",
  },
  { href: "/dashboard/api-keys", label: "API keys", group: "Connect", permission: "institution.read" },
  { href: "/dashboard/webhooks", label: "Webhooks", group: "Connect", permission: "institution.read" },

  {
    href: "/dashboard/institutions/settings",
    label: "Settings",
    group: "Administration",
    permission: "institution.read",
  },
  {
    href: "/dashboard/campuses",
    label: "Campuses",
    group: "Administration",
    // Read-gated, not `campus.manage`: the list is useful to anyone who can
    // see the institution, and the page renders the controls only for those
    // who may use them.
    permission: "institution.read",
  },
  {
    href: "/dashboard/audit-logs",
    label: "Audit logs",
    group: "Administration",
    permission: "auditLog.read",
  },
];

export interface NavSection {
  group: NavGroup;
  items: Array<{ href: string; label: string }>;
}

/**
 * The sections a given viewer should see, already filtered and labelled.
 *
 * Pure — it takes a predicate rather than a session, so the permission check
 * stays wherever the caller keeps it and this stays testable without one. A
 * group with no visible items is dropped rather than rendered empty: a heading
 * over nothing reads as a section that failed to load.
 */
export function buildNavSections(
  can: (permission: PermissionKey) => boolean,
  kind: InstitutionKind,
): NavSection[] {
  const sections: NavSection[] = [];
  for (const group of NAV_GROUPS) {
    const items = NAV_ITEMS.filter(
      (item) =>
        item.group === group &&
        (!item.permission || can(item.permission)) &&
        // An unknown institution kind (a platform-level account) sees
        // everything: it is not this function's job to decide what a
        // cross-institution operator may look at, and each page still gates
        // itself.
        (!item.only || kind === null || item.only === kind),
    ).map((item) => ({
      href: item.href,
      label: kind === "COLLEGE" && item.collegeLabel ? item.collegeLabel : item.label,
    }));
    if (items.length > 0) sections.push({ group, items });
  }
  return sections;
}
