import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBreadcrumbs } from "./breadcrumb-items.ts";

/**
 * Breadcrumbs are derived from the URL alone, so the tests are too.
 *
 * The one that matters beyond cosmetics is the opaque-id case: a crumb must
 * never leak a record's real name, because the trail is built on the client
 * from the pathname and nobody has checked whether this viewer is entitled to
 * that name.
 */

test("a section landing page gets no trail", () => {
  // "Dashboard" on the dashboard is chrome, not wayfinding.
  assert.deepEqual(buildBreadcrumbs("/dashboard"), []);
  assert.deepEqual(buildBreadcrumbs("/portal"), []);
  assert.deepEqual(buildBreadcrumbs("/"), []);
  assert.deepEqual(buildBreadcrumbs(""), []);
});

test("a nested page gets one crumb per segment, root first", () => {
  assert.deepEqual(buildBreadcrumbs("/dashboard/students"), [
    { label: "Dashboard", href: "/dashboard", current: false },
    { label: "Students", href: "/dashboard/students", current: true },
  ]);
});

test("hrefs accumulate so every crumb is a real route", () => {
  const crumbs = buildBreadcrumbs("/dashboard/academic/cohorts");
  assert.deepEqual(
    crumbs.map((crumb) => crumb.href),
    ["/dashboard", "/dashboard/academic", "/dashboard/academic/cohorts"],
  );
});

test("only the last crumb is current", () => {
  const crumbs = buildBreadcrumbs("/dashboard/integrations/api-keys");
  assert.deepEqual(
    crumbs.map((crumb) => crumb.current),
    [false, false, true],
  );
});

test("known segments use their written label", () => {
  assert.equal(buildBreadcrumbs("/dashboard/integrations/api-keys").at(-1)?.label, "API keys");
  assert.equal(buildBreadcrumbs("/dashboard/academic/units").at(-1)?.label, "Classes & units");
  assert.deepEqual(
    buildBreadcrumbs("/dashboard/academic/classes/cmu5dxyun000aitgu1x4tzn33/sections").map(
      (crumb) => crumb.label,
    ),
    ["Dashboard", "Academic", "Classes", "Details", "Sections"],
  );
  assert.equal(buildBreadcrumbs("/portal/attendance").at(0)?.label, "My attendance");
});

test("an unknown segment is title-cased rather than left blank", () => {
  // A route added tomorrow gets a readable crumb without editing this file.
  assert.equal(buildBreadcrumbs("/dashboard/timetable").at(-1)?.label, "Timetable");
  assert.equal(
    buildBreadcrumbs("/dashboard/leave-requests").at(-1)?.label,
    "Leave Requests",
  );
});

test("an opaque record id becomes 'Details', never the record's name", () => {
  // Resolving this to "Class 7B" would mean a database read per crumb, on the
  // client, for a name the viewer may not be entitled to.
  const cuid = "cmf3x9q2k0001abcdxyz";
  const crumbs = buildBreadcrumbs(`/dashboard/attendance/${cuid}/history`);
  assert.deepEqual(
    crumbs.map((crumb) => crumb.label),
    ["Dashboard", "Attendance", "Details", "History"],
  );
});

test("a uuid is recognised as an id despite its hyphens", () => {
  const uuid = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(buildBreadcrumbs(`/portal/attendance/${uuid}`).at(-1)?.label, "Details");
});

test("a hyphenated slug is a route name, not an id, however long", () => {
  // The regression this file caught: a length-only rule called
  // "/dashboard/leave-requests" a record and labelled it "Details".
  assert.equal(buildBreadcrumbs("/dashboard/leave-requests").at(-1)?.label, "Leave Requests");
  assert.equal(
    buildBreadcrumbs("/dashboard/parent-communication").at(-1)?.label,
    "Parent Communication",
  );
});

test("a long word with no digits is still a word", () => {
  assert.equal(buildBreadcrumbs("/dashboard/notifications").at(-1)?.label, "Notifications");
});

test("a short segment is not mistaken for an id", () => {
  // "new" and "review" are words, not identifiers; the length threshold is
  // what keeps them out of the opaque bucket.
  assert.equal(buildBreadcrumbs("/dashboard/students/new").at(-1)?.label, "New");
  assert.equal(buildBreadcrumbs("/dashboard/attendance/review").at(-1)?.label, "Review");
});

test("repeated and trailing slashes do not produce empty crumbs", () => {
  const crumbs = buildBreadcrumbs("/dashboard//students/");
  assert.deepEqual(
    crumbs.map((crumb) => crumb.href),
    ["/dashboard", "/dashboard/students"],
  );
});

test("a word that names two different pages is labelled by its whole path", () => {
  // "sessions" under Attendance is the list of registers, not academic sessions.
  assert.equal(buildBreadcrumbs("/dashboard/attendance/sessions").at(-1)?.label, "Sessions");
  assert.equal(buildBreadcrumbs("/dashboard/academic/sessions").at(-1)?.label, "Academic sessions");
  // "institutions" under Platform is the list; under Settings it is this one.
  assert.deepEqual(
    buildBreadcrumbs("/dashboard/platform/institutions/new").map((crumb) => crumb.label),
    ["Dashboard", "Platform", "Institutions", "New"],
  );
  assert.deepEqual(
    buildBreadcrumbs("/dashboard/institutions/settings").map((crumb) => crumb.label),
    ["Dashboard", "Institution", "Settings"],
  );
});
