import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DASHBOARD_ROUTES,
  isDashboardPage,
  matchRoute,
  nearestListPage,
  pageDrawsTrail,
} from "./route-map.ts";

/**
 * The navigation map is only worth having if it is the app's real shape, so
 * these tests read `src/app` off disk rather than trusting a list: every
 * dashboard page is in the map and nothing else is, and a page the map says
 * draws its own trail really renders one — otherwise that page would have no
 * breadcrumb at all, or two.
 */

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "app");

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.name === "page.tsx" ? [path] : [];
  });
}

/** `/dashboard/students/[studentId]` for `src/app/dashboard/students/[studentId]/page.tsx`. */
function patternOf(file: string): string {
  const parts = relative(APP_DIR, dirname(file)).split(sep).filter(Boolean);
  return `/${parts.join("/")}`;
}

const DASHBOARD_PAGES = pageFiles(join(APP_DIR, "dashboard")).map((file) => ({
  file,
  pattern: patternOf(file),
  source: readFileSync(file, "utf8"),
}));

const ID = "cmu5dxyup000gitgucbrqyopw";
const ID2 = "cmu5dxyuq000iitgu8zwyd8ln";

test("the map lists every dashboard page there is, and nothing else", () => {
  const onDisk = DASHBOARD_PAGES.map((page) => page.pattern).sort();
  const mapped = DASHBOARD_ROUTES.map((route) => route.pattern).sort();
  assert.deepEqual(mapped, onDisk);
  assert.equal(new Set(mapped).size, mapped.length, "a route is listed twice");
});

test("a page draws its own trail exactly when the map says so", () => {
  for (const page of DASHBOARD_PAGES) {
    const named = DASHBOARD_ROUTES.find((route) => route.pattern === page.pattern)?.namedTrail === true;
    const renders = page.source.includes("<PageTrail");
    assert.equal(renders, named, `${page.pattern}: renders PageTrail=${renders}, map says ${named}`);
  }
});

test("every page whose address holds a record draws its own named trail", () => {
  for (const page of DASHBOARD_PAGES) {
    const redirectsOnly = !page.source.includes("return (") && page.source.includes("redirect(");
    if (!page.pattern.includes("[") || redirectsOnly) continue;
    assert.ok(
      page.source.includes("<PageTrail"),
      `${page.pattern} has a record id in its address but no named trail`,
    );
  }
});

test("no page hand-writes its own back arrow", () => {
  // The arrow belongs to BackToParent. "← Previous" is a pager, not a way up.
  for (const file of pageFiles(APP_DIR)) {
    const offending = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => /←|&larr;/.test(line) && !/Previous/.test(line));
    assert.deepEqual(offending, [], `${relative(APP_DIR, file)} writes its own back arrow`);
  }
});

test("a static segment wins over a dynamic one, as the router decides", () => {
  assert.equal(matchRoute("/dashboard/students/classes")?.entry.pattern, "/dashboard/students/classes");
  assert.equal(matchRoute("/dashboard/students/new")?.entry.pattern, "/dashboard/students/new");
  assert.equal(matchRoute(`/dashboard/students/${ID}`)?.entry.pattern, "/dashboard/students/[studentId]");
  assert.deepEqual(matchRoute(`/dashboard/students/classes/${ID}/sections/${ID2}`)?.params, {
    classId: ID,
    sectionId: ID2,
  });
  assert.equal(matchRoute("/dashboard/attendance/sessions")?.entry.pattern, "/dashboard/attendance/sessions");
  assert.equal(matchRoute(`/dashboard/attendance/${ID}`)?.entry.pattern, "/dashboard/attendance/[cohortId]");
  assert.equal(matchRoute("/dashboard/no-such-page"), null);
  assert.equal(matchRoute(`/dashboard/students/${ID}/nope`), null);
});

test("the layout's trail steps aside only where the page names its records", () => {
  for (const path of [
    `/dashboard/students/${ID}`,
    `/dashboard/students/${ID}/edit`,
    `/dashboard/students/classes/${ID}`,
    `/dashboard/students/classes/${ID}/sections/${ID2}`,
    `/dashboard/academic/classes/${ID}/sections/${ID2}`,
    `/dashboard/attendance/${ID}/review/${ID2}`,
    `/dashboard/platform/institutions/${ID}`,
  ]) {
    assert.equal(pageDrawsTrail(path), true, path);
  }
  for (const path of [
    "/dashboard",
    "/dashboard/students",
    "/dashboard/students/classes",
    "/dashboard/students/new",
    "/dashboard/academic/classes/new",
    "/dashboard/reports/print",
    "/dashboard/no-such-page",
  ]) {
    assert.equal(pageDrawsTrail(path), false, path);
  }
});

test("a crumb that is not a page is not offered as a link", () => {
  // "Institution" above Settings: there is no /dashboard/institutions page.
  assert.equal(isDashboardPage("/dashboard/institutions"), false);
  assert.equal(isDashboardPage("/dashboard/institutions/settings"), true);
  // /dashboard/academic answers — by redirecting to the academic year.
  assert.equal(isDashboardPage("/dashboard/academic"), true);
});

test("a page that cannot be shown points at the nearest list that exists", () => {
  const cases: Array<[string, string, string]> = [
    [`/dashboard/students/classes/${ID}/sections/${ID2}`, "Classes", "/dashboard/students/classes"],
    [`/dashboard/students/classes/${ID}`, "Classes", "/dashboard/students/classes"],
    [`/dashboard/students/${ID}`, "Students", "/dashboard/students"],
    [`/dashboard/students/${ID}/enroll-face`, "Students", "/dashboard/students"],
    [`/dashboard/academic/classes/${ID}/sections/${ID2}`, "Classes", "/dashboard/academic/classes"],
    [`/dashboard/academic/cohorts/${ID}/edit`, "Classes", "/dashboard/academic/cohorts"],
    [`/dashboard/academic/sessions/${ID}/edit`, "Academic sessions", "/dashboard/academic/sessions"],
    [`/dashboard/attendance/${ID}/review/${ID2}`, "Attendance", "/dashboard/attendance"],
    [`/dashboard/campuses/${ID}/edit`, "Campuses", "/dashboard/campuses"],
    [`/dashboard/platform/institutions/${ID}`, "Institutions", "/dashboard/platform/institutions"],
  ];
  for (const [path, label, href] of cases) {
    assert.deepEqual(nearestListPage(path), { label, href }, path);
  }
  assert.equal(nearestListPage("/dashboard/no-such-page"), null);
});
