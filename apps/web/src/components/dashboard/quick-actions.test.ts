import { test } from "node:test";
import assert from "node:assert/strict";
import { SYSTEM_ROLES } from "@/modules/authorization/permissions";
import type { PermissionKey } from "@/modules/authorization/permissions";
import { QUICK_ACTIONS, buildQuickActions } from "./quick-actions.ts";

/**
 * These tests describe what each role is *offered*, not what it is allowed —
 * every destination below re-checks its own permission when it loads. A bug
 * here shows the wrong link, not the wrong data; that is why the panel is
 * allowed to be a convenience.
 *
 * Roles are read from the real catalog rather than hand-written permission
 * lists, so narrowing a role in `permissions.ts` shows up here instead of
 * leaving a dead link on the dashboard.
 */

function canFor(roleKey: string) {
  const role = SYSTEM_ROLES.find((entry) => entry.key === roleKey);
  assert.ok(role, `unknown role ${roleKey}`);
  const granted = new Set<PermissionKey>(role.permissions);
  return (permission: PermissionKey) => granted.has(permission);
}

const labels = (actions: { label: string }[]) => actions.map((action) => action.label);

test("a role with no matching permission is offered nothing", () => {
  assert.deepEqual(buildQuickActions(() => false, "SCHOOL"), []);
});

test("a student is offered no staff actions", () => {
  // The portal is their surface; none of these six belong on it.
  assert.deepEqual(buildQuickActions(canFor("STUDENT"), "SCHOOL"), []);
});

test("faculty are offered taking attendance but not administration", () => {
  const offered = labels(buildQuickActions(canFor("FACULTY"), "SCHOOL"));
  assert.ok(offered.includes("Take attendance"), offered.join(", "));
  assert.ok(!offered.includes("Create a class"), offered.join(", "));
  assert.ok(!offered.includes("Issue an API key"), offered.join(", "));
});

test("an institution admin is offered the administrative actions", () => {
  const offered = labels(buildQuickActions(canFor("INSTITUTION_ADMIN"), "SCHOOL"));
  for (const expected of ["Add a student", "Create a class", "Run a report", "Issue an API key"]) {
    assert.ok(offered.includes(expected), `${expected} missing from ${offered.join(", ")}`);
  }
});

test("a school's Create a class goes to the class setup, a college's to its class screen", () => {
  const can = canFor("SCHOOL_ADMIN");
  const hrefFor = (kind: "SCHOOL" | "COLLEGE") =>
    buildQuickActions(can, kind).find((action) => action.label === "Create a class")?.href;
  assert.equal(hrefFor("SCHOOL"), "/dashboard/academic/classes/new");
  assert.equal(hrefFor("COLLEGE"), "/dashboard/academic/cohorts/new");
});

test("an attendance operator is offered the register and nothing that corrects it", () => {
  // This role deliberately cannot finalise or correct; the panel must not
  // suggest otherwise.
  const offered = labels(buildQuickActions(canFor("ATTENDANCE_OPERATOR"), "SCHOOL"));
  assert.ok(!offered.includes("Create a class"), offered.join(", "));
  assert.ok(!offered.includes("Issue an API key"), offered.join(", "));
});

test("a platform account with an unknown institution kind is not filtered by kind", () => {
  const everything = () => true;
  assert.equal(buildQuickActions(everything, null).length, QUICK_ACTIONS.length);
});

test("kind-restricted actions are hidden at the other kind of institution", () => {
  const everything = () => true;
  const school = buildQuickActions(everything, "SCHOOL");
  const college = buildQuickActions(everything, "COLLEGE");

  for (const action of QUICK_ACTIONS) {
    if (action.only === "COLLEGE") {
      assert.ok(!school.includes(action), `${action.label} should be hidden at a school`);
      assert.ok(college.includes(action), `${action.label} should show at a college`);
    } else if (action.only === "SCHOOL") {
      assert.ok(!college.includes(action), `${action.label} should be hidden at a college`);
      assert.ok(school.includes(action), `${action.label} should show at a school`);
    } else {
      assert.ok(school.includes(action) && college.includes(action), action.label);
    }
  }
});

test("the panel stays short enough to be a shortcut rather than a second sidebar", () => {
  assert.ok(QUICK_ACTIONS.length <= 8, `${QUICK_ACTIONS.length} quick actions is too many`);
});

test("every action points at a dashboard route and carries a description", () => {
  for (const action of QUICK_ACTIONS) {
    assert.ok(action.href.startsWith("/dashboard"), action.href);
    assert.ok(action.description.length > 0, action.label);
  }
});
