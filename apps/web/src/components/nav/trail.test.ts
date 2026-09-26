import { test } from "node:test";
import assert from "node:assert/strict";
import { parentCrumb } from "./trail.ts";

test("the way back is the crumb one level above the page", () => {
  assert.deepEqual(
    parentCrumb([
      { label: "Students", href: "/dashboard/students" },
      { label: "Classes", href: "/dashboard/students/classes?year=y1" },
      { label: "Class 1", href: "/dashboard/students/classes/c1?year=y1" },
      { label: "Section Orange" },
    ]),
    { label: "Class 1", href: "/dashboard/students/classes/c1?year=y1" },
  );
});

test("the parent's address is kept whole, query and all", () => {
  // The academic year rides along: Class → Classes must not change years.
  assert.equal(
    parentCrumb([
      { label: "Students", href: "/dashboard/students" },
      { label: "Classes", href: "/dashboard/students/classes?year=y1" },
      { label: "Class 1" },
    ])?.href,
    "/dashboard/students/classes?year=y1",
  );
});

test("no way back when there is nothing above, or it is not a page", () => {
  assert.equal(parentCrumb([]), null);
  assert.equal(parentCrumb([{ label: "Students" }]), null);
  assert.equal(parentCrumb([{ label: "Institution" }, { label: "Settings" }]), null);
  assert.equal(parentCrumb([{ label: "", href: "/dashboard" }, { label: "Page" }]), null);
});
