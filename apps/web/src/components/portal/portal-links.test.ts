import { test } from "node:test";
import assert from "node:assert/strict";
import { portalLinks } from "./portal-links.ts";

test("the portal offers overview, attendance and the account — in that order", () => {
  assert.deepEqual(
    portalLinks({ faceEnrollment: false }).map((link) => link.label),
    ["Overview", "My attendance", "Account"],
  );
});

test("face enrollment appears only where the institution allows self-enrollment", () => {
  assert.deepEqual(
    portalLinks({ faceEnrollment: true }).map((link) => link.href),
    ["/portal", "/portal/attendance", "/portal/enroll-face", "/portal/account"],
  );
});

test("a student account is offered no staff destination", () => {
  for (const faceEnrollment of [true, false]) {
    for (const link of portalLinks({ faceEnrollment })) {
      assert.ok(link.href.startsWith("/portal"), link.href);
    }
  }
});
