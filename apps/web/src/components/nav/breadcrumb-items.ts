// Breadcrumbs, derived from the URL and nothing else.
//
// Pure — it takes a pathname and returns a trail — for the same reason
// `nav-items.ts` takes a predicate rather than a session: it stays testable
// without a database or a browser, and no session data has to cross into the
// client component that renders it.
//
// A breadcrumb here is a wayfinding aid, never a claim about access. Every
// href it produces points at a route that gates itself, so a trail rendered
// for a page the user reached does not imply the ancestors are open to them —
// following one they may not see still lands on /unauthorized.

export interface Crumb {
  label: string;
  href: string;
  /** True for the page currently being viewed: rendered as text, not a link. */
  current: boolean;
}

/**
 * Segment -> label. A segment missing from this map is title-cased, so a new
 * route gets a readable crumb the day it ships rather than a blank one; the
 * map is for the cases where title-casing would be wrong ("Api Keys") or
 * uninformative ("Units").
 */
const SEGMENT_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  portal: "My attendance",

  academic: "Academic",
  cohorts: "Classes",
  classes: "Classes",
  sections: "Sections",
  units: "Classes & units",
  subjects: "Subjects",
  sessions: "Academic sessions",
  enrollments: "Enrollments",

  students: "Students",
  faculty: "Faculty",

  attendance: "Attendance",
  capture: "Capture",
  review: "Review",
  history: "History",
  offline: "Offline attendance",
  "face-enrollment": "Face enrollment",
  "enroll-face": "Face enrollment",

  reports: "Reports",
  print: "Print view",

  integrations: "Integrations",
  import: "Import",
  "api-keys": "API keys",
  webhooks: "Webhooks",

  institutions: "Institution",
  settings: "Settings",
  "audit-logs": "Audit logs",

  new: "New",
};

/**
 * An opaque identifier standing in for a record — a cuid, a uuid, or anything
 * else long and unpronounceable.
 *
 * Labelled generically rather than guessed at: resolving "cmf3x…" to the
 * cohort's real name would mean a database read per crumb on every page, and
 * a name the viewer may not be entitled to see. "Details" is honest and free.
 *
 * Two shapes, not one "long-ish string" rule. A single unbroken token that
 * mixes letters and digits is an id; a canonical uuid is an id. Anything
 * hyphenated is a slug somebody wrote — `/dashboard/leave-requests` is a
 * route, not a record, and the earlier length-only rule called it "Details".
 */
const OPAQUE_TOKEN = /^(?=.*\d)[A-Za-z0-9_]{12,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function labelFor(segment: string): string {
  const known = SEGMENT_LABELS[segment];
  if (known) return known;
  if (OPAQUE_TOKEN.test(segment) || UUID.test(segment)) return "Details";
  return segment
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word))
    .join(" ");
}

/**
 * The trail for a path, root first.
 *
 * Returns an empty array for a section's own landing page (`/dashboard`,
 * `/portal`): a breadcrumb reading just "Dashboard" on the dashboard is
 * chrome that tells the reader something they can already see.
 */
export function buildBreadcrumbs(pathname: string): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return [];

  const crumbs: Crumb[] = [];
  let href = "";
  for (const [index, segment] of segments.entries()) {
    href += `/${segment}`;
    crumbs.push({
      label: labelFor(segment),
      href,
      current: index === segments.length - 1,
    });
  }
  return crumbs;
}
