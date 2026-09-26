// The dashboard's pages as a map of where each one sits.
//
// Pure, like `breadcrumb-items.ts` and `nav-items.ts`: it answers questions
// about paths without a session, a database or a browser, so the answers can
// be tested directly — and `route-map.test.ts` reads `src/app/dashboard` off
// disk to prove the map lists every page there is, and nothing else.
//
// Two things live here and nowhere else:
//
// - **Which pages draw their own breadcrumb.** A page whose URL holds a record
//   id (`/dashboard/students/cm…`) can name that record — it has just loaded
//   it, through the service that checks the viewer may see it — so it renders
//   its own trail ("Students / Aarav Sharma") with `PageTrail`, and the
//   layout's URL-derived trail ("Students / Details") stays out of the way.
//
// - **What is one level up.** Not always the URL's parent: `/sections` and
//   `/review` are path segments, not pages. When a page cannot be shown — its
//   record is gone, or belongs to another school — the nearest page above it
//   that has no record in its address is the one that is certain to exist.

export interface RouteEntry {
  /** An App Router path: `/dashboard/students/[studentId]`. */
  pattern: string;
  /**
   * What a page with no record in its address is called, for "Back to …"
   * when a page below it cannot be shown.
   */
  label?: string;
  /** The page one level up in the hierarchy, when it is not simply the URL's parent. */
  parent?: string;
  /** The page renders its own trail, with names, through `PageTrail`. */
  namedTrail?: true;
}

export const DASHBOARD_ROUTES: readonly RouteEntry[] = [
  { pattern: "/dashboard", label: "Dashboard" },

  { pattern: "/dashboard/students", label: "Students" },
  { pattern: "/dashboard/students/new" },
  { pattern: "/dashboard/students/[studentId]", namedTrail: true },
  { pattern: "/dashboard/students/[studentId]/edit", namedTrail: true },
  { pattern: "/dashboard/students/[studentId]/enroll-face", namedTrail: true },
  { pattern: "/dashboard/students/classes", label: "Classes" },
  { pattern: "/dashboard/students/classes/[classId]", namedTrail: true },
  // Redirects to the class; there for the URL's sake only.
  { pattern: "/dashboard/students/classes/[classId]/sections" },
  {
    pattern: "/dashboard/students/classes/[classId]/sections/[sectionId]",
    parent: "/dashboard/students/classes/[classId]",
    namedTrail: true,
  },

  { pattern: "/dashboard/faculty", label: "Faculty" },

  { pattern: "/dashboard/academic", label: "Academic" },
  { pattern: "/dashboard/academic/sessions", label: "Academic sessions" },
  { pattern: "/dashboard/academic/sessions/new" },
  { pattern: "/dashboard/academic/sessions/[sessionId]/edit", namedTrail: true },
  { pattern: "/dashboard/academic/classes", label: "Classes" },
  { pattern: "/dashboard/academic/classes/new" },
  { pattern: "/dashboard/academic/classes/[classId]", namedTrail: true },
  // Redirects to the class, like its twin under Students.
  { pattern: "/dashboard/academic/classes/[classId]/sections" },
  {
    pattern: "/dashboard/academic/classes/[classId]/sections/[sectionId]",
    parent: "/dashboard/academic/classes/[classId]",
    namedTrail: true,
  },
  { pattern: "/dashboard/academic/cohorts", label: "Classes" },
  { pattern: "/dashboard/academic/cohorts/new", namedTrail: true },
  { pattern: "/dashboard/academic/cohorts/[cohortId]", namedTrail: true },
  { pattern: "/dashboard/academic/cohorts/[cohortId]/edit", namedTrail: true },
  { pattern: "/dashboard/academic/units", label: "Programs & semesters" },
  { pattern: "/dashboard/academic/units/new", namedTrail: true },
  { pattern: "/dashboard/academic/units/[unitId]/edit", namedTrail: true },
  { pattern: "/dashboard/academic/subjects", label: "Subjects" },
  { pattern: "/dashboard/academic/subjects/new" },
  { pattern: "/dashboard/academic/subjects/[subjectId]/edit", namedTrail: true },
  { pattern: "/dashboard/academic/enrollments", label: "Enrollments" },

  { pattern: "/dashboard/attendance", label: "Attendance" },
  { pattern: "/dashboard/attendance/sessions", label: "Sessions" },
  { pattern: "/dashboard/attendance/[cohortId]", namedTrail: true },
  { pattern: "/dashboard/attendance/[cohortId]/capture", namedTrail: true },
  { pattern: "/dashboard/attendance/[cohortId]/history", namedTrail: true },
  {
    pattern: "/dashboard/attendance/[cohortId]/review/[sessionId]",
    parent: "/dashboard/attendance/[cohortId]",
    namedTrail: true,
  },
  { pattern: "/dashboard/offline", label: "Offline attendance" },
  { pattern: "/dashboard/reports", label: "Reports" },
  { pattern: "/dashboard/reports/print" },
  { pattern: "/dashboard/face-enrollment", label: "Face enrollment" },

  { pattern: "/dashboard/integrations", label: "Integrations" },
  { pattern: "/dashboard/integrations/import" },
  { pattern: "/dashboard/api-keys", label: "API keys" },
  { pattern: "/dashboard/webhooks", label: "Webhooks" },

  { pattern: "/dashboard/institutions/settings", label: "Settings" },
  { pattern: "/dashboard/campuses", label: "Campuses" },
  { pattern: "/dashboard/campuses/new" },
  { pattern: "/dashboard/campuses/[campusId]/edit", namedTrail: true },
  { pattern: "/dashboard/audit-logs", label: "Audit logs" },

  { pattern: "/dashboard/platform", label: "Platform" },
  { pattern: "/dashboard/platform/institutions", label: "Institutions" },
  { pattern: "/dashboard/platform/institutions/new" },
  { pattern: "/dashboard/platform/institutions/[institutionId]", namedTrail: true },
  { pattern: "/dashboard/platform/system", label: "System health" },
];

const BY_PATTERN = new Map(DASHBOARD_ROUTES.map((entry) => [entry.pattern, entry]));

function segmentsOf(path: string): string[] {
  return path.split("/").filter(Boolean);
}

const isDynamic = (segment: string) => segment.startsWith("[") && segment.endsWith("]");

export interface RouteMatch {
  entry: RouteEntry;
  params: Record<string, string>;
}

/**
 * The route a path is served by, the way the App Router picks it: a static
 * segment wins over a dynamic one at the same depth, so `/dashboard/students/classes`
 * is the Classes page and not a student whose id is "classes".
 */
export function matchRoute(pathname: string): RouteMatch | null {
  const parts = segmentsOf(pathname);
  let best: { match: RouteMatch; score: string } | null = null;

  for (const entry of DASHBOARD_ROUTES) {
    const pattern = segmentsOf(entry.pattern);
    if (pattern.length !== parts.length) continue;

    const params: Record<string, string> = {};
    let score = "";
    let matches = true;
    for (const [index, segment] of pattern.entries()) {
      if (isDynamic(segment)) {
        params[segment.slice(1, -1)] = parts[index];
        score += "0";
      } else if (segment === parts[index]) {
        score += "1";
      } else {
        matches = false;
        break;
      }
    }
    // Scores compare left to right, so the first static segment decides.
    if (matches && (!best || score > best.score)) best = { match: { entry, params }, score };
  }
  return best?.match ?? null;
}

/** Whether the page at this path draws its own, named trail. */
export function pageDrawsTrail(pathname: string): boolean {
  return matchRoute(pathname)?.entry.namedTrail === true;
}

/** Whether a path is served by a dashboard page, so a crumb pointing at it leads somewhere. */
export function isDashboardPage(path: string): boolean {
  return matchRoute(path) !== null;
}

/** The pattern one level up: the declared parent, or the URL's. */
function parentPattern(pattern: string): string | null {
  const declared = BY_PATTERN.get(pattern)?.parent;
  if (declared) return declared;
  const parts = segmentsOf(pattern);
  if (parts.length <= 1) return null;
  return `/${parts.slice(0, -1).join("/")}`;
}

/**
 * The nearest page above this path whose address holds no record id — a list
 * that exists whatever happened to the record: "Classes" for a section that
 * is gone, "Students" for a student who cannot be shown.
 */
export function nearestListPage(pathname: string): { label: string; href: string } | null {
  const match = matchRoute(pathname);
  if (!match) return null;

  let pattern = parentPattern(match.entry.pattern);
  while (pattern) {
    const entry = BY_PATTERN.get(pattern);
    if (entry?.label && !segmentsOf(pattern).some(isDynamic)) {
      return { label: entry.label, href: pattern };
    }
    pattern = parentPattern(pattern);
  }
  return null;
}
