import assert from "node:assert/strict";
import { test } from "node:test";
import type { PermissionKey } from "@/modules/authorization/permissions";
import { NAV_ITEMS, buildNavSections } from "./nav-items.ts";

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

test("the units link is named for the institution it belongs to", () => {
  const can = allowing("academicStructure.manage");
  const labelAt = (kind: "SCHOOL" | "COLLEGE") =>
    buildNavSections(can, kind)
      .flatMap((section) => section.items)
      .find((item) => item.href === "/dashboard/academic/units")?.label;
  assert.equal(labelAt("SCHOOL"), "Sections");
  assert.equal(labelAt("COLLEGE"), "Programs & semesters");
});

test("sections come back in the declared group order", () => {
  // `() => true` is an actor holding every permission, so this includes the
  // platform tier. What a normal institution admin sees is the next test.
  const sections = buildNavSections(() => true, "COLLEGE");
  assert.deepEqual(
    sections.map((section) => section.group),
    ["Platform", "Today", "People", "Academic", "Attendance", "Connect", "Administration"],
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

test("every destination is listed exactly once", () => {
  const seen = new Set(NAV_ITEMS.map((item) => item.href));
  assert.equal(seen.size, NAV_ITEMS.length);
});

test("offline attendance survived the regrouping", () => {
  // It is the one link a teacher needs when the network is gone, and it has no
  // replacement elsewhere in the dashboard.
  assert.ok(hrefs(buildNavSections(() => true, "SCHOOL")).includes("/dashboard/offline"));
});
