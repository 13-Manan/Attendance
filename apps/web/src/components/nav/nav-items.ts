import type { PermissionKey } from "@/modules/authorization/permissions";

export type InstitutionKind = "SCHOOL" | "COLLEGE" | null;

/** The headings the sidebar groups links under, in the order they appear. */
export const NAV_GROUPS = [
  // Above everything else, and visible only to the few who hold
  // `platform.institution.create`. It is the one section that crosses tenant
  // boundaries, so it reads as a different tier rather than another feature.
  "Platform",
  "Platform administration",
  "Today",
  "People",
  "Academic",
  "Attendance",
  "Connect",
  "Administration",
] as const;

/**
 * The groups that belong to the platform tier rather than to an institution.
 *
 * A platform account sees these and nothing else — see `buildNavSections`.
 */
const PLATFORM_GROUPS = new Set<NavGroup>(["Platform", "Platform administration"]);

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
  /**
   * This link's step in setting up a school — Academic year, Faculty, Classes,
   * Students — for someone who does that. See `SCHOOL_SETUP_GROUP`.
   */
  schoolSetupStep?: number;
}

/**
 * Where a school's setup links are shown, together and in the order the work
 * is done, to anyone who sets the school up (`academicStructure.manage`): the
 * academic year, the teachers, the classes — whose sections need those
 * teachers — and then the students placed in them. Split between People and
 * Academic, the principal read Students first and the year last.
 *
 * Only the heading and the position move. Each link keeps its own permission,
 * so nobody is offered a page they were not offered before; a teacher, who
 * sets nothing up, keeps Students under People; and a college's navigation is
 * unchanged.
 */
const SCHOOL_SETUP_GROUP: NavGroup = "Academic";

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
 * A school has classes and sections; a college has departments, semesters and
 * courses. A school is offered two links — Academic year and Classes — and
 * sets up a class, its sections and their teachers in one place
 * (`/dashboard/academic/classes`). A college keeps the structure, class and
 * subject screens, which show the same rows one table at a time. Subjects
 * would disappear at a school regardless: `createSubjectForRequest` refuses
 * `subjects_are_college_only`, and a link to a screen that can only refuse is
 * worse than no link.
 */
export const NAV_ITEMS: NavItem[] = [
  {
    href: "/dashboard/platform",
    label: "Platform overview",
    group: "Platform",
    permission: "platform.institution.create",
  },
  {
    href: "/dashboard/platform/institutions",
    label: "Institutions",
    group: "Platform",
    permission: "platform.institution.create",
  },
  {
    // Where release readiness and the recognition-service detail live. Both
    // used to sit on the platform landing page, where "2 release blockers
    // outstanding, this deployment is not cleared for production" was the
    // first thing an administrator read every morning — accurate, and the
    // wrong thing to lead with on an operations screen.
    href: "/dashboard/platform/system",
    label: "System health",
    group: "Platform administration",
    permission: "platform.institution.create",
  },
  {
    // The platform-wide audit trail. Listed here as well as under the
    // institution's own Administration group because the page narrows itself
    // by actor: a platform user sees every institution's events, an
    // institution admin only their own.
    href: "/dashboard/audit-logs",
    label: "Audit logs",
    group: "Platform administration",
    permission: "platform.institution.create",
  },

  { href: "/dashboard", label: "Overview", group: "Today" },

  {
    href: "/dashboard/students",
    label: "Students",
    group: "People",
    permission: "student.read",
    schoolSetupStep: 4,
  },
  {
    href: "/dashboard/faculty",
    label: "Faculty",
    group: "People",
    permission: "institution.read",
    schoolSetupStep: 2,
  },

  {
    href: "/dashboard/academic/cohorts",
    label: "Classes",
    group: "Academic",
    permission: "academicStructure.manage",
    only: "COLLEGE",
  },
  {
    href: "/dashboard/academic/units",
    label: "Programs & semesters",
    group: "Academic",
    permission: "academicStructure.manage",
    only: "COLLEGE",
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
    label: "Academic year",
    collegeLabel: "Academic sessions",
    group: "Academic",
    permission: "academicStructure.manage",
    schoolSetupStep: 1,
  },
  {
    // A school sets up its classes, sections and their teachers on one screen,
    // in its own words; the three college screens above are the same rows seen
    // one table at a time. Their routes still answer at a school — a bookmark
    // keeps working — they are just not where a principal is sent.
    href: "/dashboard/academic/classes",
    label: "Classes",
    group: "Academic",
    permission: "academicStructure.manage",
    only: "SCHOOL",
    schoolSetupStep: 3,
  },

  {
    href: "/dashboard/attendance",
    label: "Attendance",
    group: "Attendance",
    permission: "attendanceSession.create",
  },
  {
    // `attendanceRecord.read`, not `attendanceSession.create`: this is the
    // register history, and reading it is a different thing from being
    // allowed to take one. An attendance operator may capture but not read
    // back, so they get "Attendance" above and not this.
    href: "/dashboard/attendance/sessions",
    label: "Sessions",
    group: "Attendance",
    permission: "attendanceRecord.read",
  },
  {
    href: "/dashboard/offline",
    label: "Offline attendance",
    group: "Attendance",
    permission: "attendanceSession.capture",
  },
  {
    // `attendanceRecord.read`, matching the page: a class teacher reports on
    // their own classes, an administrator on the institution. One screen,
    // narrowed server-side — see `requireReportAccess`.
    href: "/dashboard/reports",
    label: "Reports",
    group: "Attendance",
    permission: "attendanceRecord.read",
  },
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
 * Pure — it takes predicates rather than a session, so the permission check
 * stays wherever the caller keeps it and this stays testable without one. A
 * group with no visible items is dropped rather than rendered empty: a heading
 * over nothing reads as a section that failed to load.
 *
 * ## Why a platform account is filtered by role and not by permission
 *
 * `isPlatform` is not a convenience flag; permissions cannot answer this
 * question at all. PLATFORM_SUPER_ADMIN is granted every key in the catalogue,
 * so `can(...)` returns true for all seventeen institution links and the
 * sidebar filled up with Students, Faculty, Classes, Attendance, Reports and
 * Settings — modules that need an institution the account does not have. Two
 * of those pages did not merely look wrong, they threw: the services behind
 * them refuse an actor with no institution (`institution_scope_required`), and
 * `/dashboard` — the landing page — answered with "Something went wrong".
 *
 * So the rule is about scope rather than power: a platform account administers
 * the platform, and reaches an institution by opening it from Institutions.
 *
 * ## This is still not a security boundary
 *
 * Hiding a link has never been what makes a page safe here, and that has not
 * changed. Every route continues to gate itself with `requireUser` /
 * `requirePermissionOrRedirect`, and the institution-scoped services continue
 * to refuse an institution-less actor outright. A platform user who types one
 * of these URLs is redirected to their own tier by the page, not by this list.
 */
export function buildNavSections(
  can: (permission: PermissionKey) => boolean,
  kind: InstitutionKind,
  isPlatform = false,
): NavSection[] {
  // Someone who sets a school up reads its setup as one run, in order; see
  // SCHOOL_SETUP_GROUP. Everyone else sees each link under its own group.
  const setsUpSchool = kind === "SCHOOL" && can("academicStructure.manage");
  const groupOf = (item: NavItem): NavGroup =>
    setsUpSchool && item.schoolSetupStep !== undefined ? SCHOOL_SETUP_GROUP : item.group;
  const setupStep = (item: NavItem) =>
    setsUpSchool ? (item.schoolSetupStep ?? Number.MAX_SAFE_INTEGER) : 0;

  const sections: NavSection[] = [];
  for (const group of NAV_GROUPS) {
    // A platform account gets the platform groups only; everyone else gets
    // everything except them (their permission check would fail anyway, but
    // being explicit keeps the two tiers from leaking into each other).
    if (isPlatform !== PLATFORM_GROUPS.has(group)) continue;

    const items = NAV_ITEMS.filter(
      (item) =>
        groupOf(item) === group &&
        (!item.permission || can(item.permission)) &&
        // An unknown institution kind only reaches here for a non-platform
        // account with no institution, which the routes themselves handle.
        (!item.only || kind === null || item.only === kind),
    )
      // A stable sort: setup steps in order, anything else where it was.
      .sort((a, b) => setupStep(a) - setupStep(b))
      .map((item) => ({
        href: item.href,
        label: kind === "COLLEGE" && item.collegeLabel ? item.collegeLabel : item.label,
      }));
    if (items.length > 0) sections.push({ group, items });
  }
  return sections;
}
