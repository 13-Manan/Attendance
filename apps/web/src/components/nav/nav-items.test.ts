import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionKey } from "@/modules/authorization/permissions";
import { NAV_GROUPS, NAV_ITEMS, buildNavSections } from "./nav-items.ts";

/**
 * The navigation is not a security boundary — every page gates itself — but it
 * is a promise about what this account can do, and a wrong promise sends an
 * administrator to a redirect. These tests hold the promise honest.
 */

function allowing(...granted: PermissionKey[]) {
  const set = new Set<PermissionKey>(granted);
  return (permission: PermissionKey) => set.has(permission);
}

const hrefs = (sections: ReturnType<typeof buildNavSections>) =>
  sections.flatMap((section) => section.items.map((item) => item.href));

test("a viewer with no permissions still gets the overview, and nothing else", () => {
  const sections = buildNavSections(() => false, "SCHOOL");
  assert.deepEqual(hrefs(sections), ["/dashboard"]);
  // No heading over an empty list.
  assert.equal(sections.length, 1);
});

test("a link appears only when its permission is held", () => {
  const sections = buildNavSections(allowing("student.read"), "SCHOOL");
  assert.deepEqual(hrefs(sections), ["/dashboard", "/dashboard/students"]);
});

test("subjects are hidden at a school and shown at a college", () => {
  const can = allowing("academicStructure.manage");
  assert.ok(!hrefs(buildNavSections(can, "SCHOOL")).includes("/dashboard/academic/subjects"));
  assert.ok(hrefs(buildNavSections(can, "COLLEGE")).includes("/dashboard/academic/subjects"));
});

test("a platform-level account (no institution kind) is not narrowed by kind", () => {
  const can = allowing("academicStructure.manage");
  assert.ok(hrefs(buildNavSections(can, null)).includes("/dashboard/academic/subjects"));
});

test("a school is offered Academic year and Classes, and nothing more technical", () => {
  const can = allowing("academicStructure.manage");
  const academic = (kind: "SCHOOL" | "COLLEGE") =>
    buildNavSections(can, kind).find((section) => section.group === "Academic")?.items ?? [];

  assert.deepEqual(academic("SCHOOL"), [
    { href: "/dashboard/academic/sessions", label: "Academic year" },
    { href: "/dashboard/academic/classes", label: "Classes" },
  ]);
  // A college's screens are unchanged.
  assert.deepEqual(academic("COLLEGE"), [
    { href: "/dashboard/academic/cohorts", label: "Classes" },
    { href: "/dashboard/academic/units", label: "Programs & semesters" },
    { href: "/dashboard/academic/subjects", label: "Subjects" },
    { href: "/dashboard/academic/sessions", label: "Academic sessions" },
  ]);
});

test("sections come back in the declared group order", () => {
  // An institution actor holding every institution permission. The platform
  // groups are absent no matter what they hold — see the next two tests.
  const sections = buildNavSections(() => true, "COLLEGE");
  assert.deepEqual(
    sections.map((section) => section.group),
    ["Today", "People", "Academic", "Attendance", "Connect", "Administration"],
  );
});

test("a platform account gets the platform groups and nothing else", () => {
  // The regression this encodes: PLATFORM_SUPER_ADMIN is granted every
  // permission in the catalogue, so a permission-only filter offered them
  // Students, Faculty, Classes, Attendance, Reports and Settings — modules
  // that need an institution they do not have. Two of those pages threw
  // rather than merely looking empty.
  const sections = buildNavSections(() => true, null, true);

  assert.deepEqual(
    sections.map((section) => section.group),
    ["Platform", "Platform administration"],
  );
  assert.deepEqual(hrefs(sections), [
    "/dashboard/platform",
    "/dashboard/platform/institutions",
    "/dashboard/platform/system",
    "/dashboard/audit-logs",
  ]);
  // The landing page that used to break for them is not offered as a
  // destination at all; they are redirected off it to their own tier.
  assert.equal(hrefs(sections).includes("/dashboard"), false);
});

test("an institution actor never receives the platform groups", () => {
  // Even asked for explicitly with every permission granted — the flag is the
  // only thing that opens them, and only the session's role sets it.
  const sections = buildNavSections(() => true, "SCHOOL", false);
  assert.equal(
    sections.some((section) => section.group.startsWith("Platform")),
    false,
  );
  assert.equal(
    hrefs(sections).some((href) => href.startsWith("/dashboard/platform")),
    false,
  );
});

test("the platform tier is invisible without the platform permission", () => {
  // The section that crosses tenant boundaries. An institution admin holds
  // every other permission in the catalogue and must still not see it — and
  // the pages behind it refuse them anyway, which is what actually protects
  // them. This asserts they are not even offered.
  const institutionAdmin = (permission: string) => !permission.startsWith("platform.");
  const sections = buildNavSections(institutionAdmin, "COLLEGE");

  assert.equal(
    sections.some((section) => section.group === "Platform"),
    false,
  );
  assert.equal(
    hrefs(sections).some((href) => href.startsWith("/dashboard/platform")),
    false,
  );
});

test("no viewer is ever offered the same destination twice", () => {
  /**
   * Stated per viewer rather than per list, because one destination now
   * legitimately appears in two groups: `/dashboard/audit-logs` is listed
   * under "Platform administration" for a platform account and under
   * "Administration" for an institution admin. It is the same page, narrowed
   * by actor — a platform user sees every institution's events, an
   * institution admin only their own — and the two groups are mutually
   * exclusive, so no one is shown it twice.
   *
   * The per-viewer form is the stronger property anyway: a duplicate inside a
   * single tier is the mistake worth catching, and a global set could not tell
   * that apart from a deliberate cross-tier reuse.
   */
  const viewers: Array<[string, ReturnType<typeof buildNavSections>]> = [
    ["platform", buildNavSections(() => true, null, true)],
    ["school admin", buildNavSections(() => true, "SCHOOL", false)],
    ["college admin", buildNavSections(() => true, "COLLEGE", false)],
    ["faculty", buildNavSections(allowing("attendanceRecord.read"), "SCHOOL", false)],
    ["no permissions", buildNavSections(() => false, "SCHOOL", false)],
  ];

  for (const [who, sections] of viewers) {
    const seen = hrefs(sections);
    assert.equal(new Set(seen).size, seen.length, `${who} was offered a duplicate link`);
  }
});

test("each nav group is declared in NAV_GROUPS", () => {
  // Catches an item added under a heading that was never declared, which
  // would silently never render.
  for (const item of NAV_ITEMS) {
    assert.ok(NAV_GROUPS.includes(item.group), `${item.href} uses an undeclared group`);
  }
});

test("offline attendance survived the regrouping", () => {
  // It is the one link a teacher needs when the network is gone, and it has no
  // replacement elsewhere in the dashboard.
  assert.ok(hrefs(buildNavSections(() => true, "SCHOOL")).includes("/dashboard/offline"));
});
