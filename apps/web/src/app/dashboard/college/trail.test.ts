import { test } from "node:test";
import assert from "node:assert/strict";
import { parentCrumb } from "@/components/nav/trail";
import { COURSES_PATH, courseTitle, courseTrail, departmentTrail } from "./trail.ts";

const D = "/dashboard/college/departments/cse";
const S = `${D}/semesters/s4`;
const C = `${S}/courses/phy`;
const X = `${C}/sections/phy-a`;

const parts = {
  department: { name: "Computer Science", href: D },
  semester: { name: "4th Semester", href: S },
  course: { name: "Physics", code: "PHY401", href: C },
};

/** Where "← Back to …" goes: the trail's own override, or the crumb one level up. */
function backOf(trail: ReturnType<typeof courseTrail>) {
  return trail.back ?? parentCrumb(trail.items);
}

test("a head of department's trail runs Courses → course → section → student", () => {
  const course = courseTrail({ viewer: "hod", ...parts });
  assert.deepEqual(course.items, [{ label: "Courses", href: COURSES_PATH }, { label: "Physics" }]);
  assert.deepEqual(backOf(course), { label: "Courses", href: COURSES_PATH });

  const section = courseTrail({ viewer: "hod", ...parts, section: { label: "Section A", href: X } });
  assert.deepEqual(section.items, [
    { label: "Courses", href: COURSES_PATH },
    { label: "Physics", href: C },
    { label: "Section A" },
  ]);
  assert.deepEqual(backOf(section), { label: "Physics", href: C });

  const student = courseTrail({ viewer: "hod", ...parts, section: { label: "Section A", href: X }, leaf: "Aman Kumar" });
  assert.deepEqual(student.items.map((item) => item.label), ["Courses", "Physics", "Section A", "Aman Kumar"]);
  assert.equal(student.items.at(-1)?.href, undefined, "the page itself is not a link");
  assert.deepEqual(backOf(student), { label: "Physics — Section A", href: X });
});

test("the Courses crumb keeps the session being viewed", () => {
  const trail = courseTrail({ viewer: "hod", coursesHref: `${COURSES_PATH}?session=old`, ...parts });
  assert.deepEqual(backOf(trail), { label: "Courses", href: `${COURSES_PATH}?session=old` });
});

test("an administrator's trail is the college's hierarchy, as it was", () => {
  const course = courseTrail({ viewer: "admin", ...parts });
  assert.deepEqual(course.items, [
    { label: "Departments", href: "/dashboard/college/departments" },
    { label: "Computer Science", href: D },
    { label: "4th Semester", href: S },
    { label: "PHY401 · Physics" },
  ]);
  assert.deepEqual(backOf(course), { label: "4th Semester", href: S });

  const section = courseTrail({ viewer: "admin", ...parts, section: { label: "Section A", href: X } });
  assert.deepEqual(backOf(section), { label: "PHY401 · Physics", href: C });

  const adding = courseTrail({ viewer: "admin", ...parts, section: { label: "Section A", href: X }, leaf: "Add students" });
  assert.deepEqual(backOf(adding), { label: "Physics — Section A", href: X }, "below a section, it is named in full");
});

test("a course is titled by its code and name, or its name alone", () => {
  assert.equal(courseTitle({ code: "PHY401", name: "Physics" }), "PHY401 · Physics");
  assert.equal(courseTitle({ code: null, name: "Physics" }), "Physics");
  assert.equal(courseTitle({ code: "PHY401", name: "PHY401 Physics" }), "PHY401 Physics");
});

test("a department's people pages: a head starts from Faculty or Students, an administrator from Departments", () => {
  const faculty = `${D}/faculty`;
  const students = `${D}/students`;
  const list = departmentTrail({ viewer: "hod", department: parts.department, list: { label: "Faculty", href: faculty } });
  assert.deepEqual(list.items, [{ label: "Faculty" }], "the list page is named, not linked");

  const person = departmentTrail({
    viewer: "hod",
    department: parts.department,
    list: { label: "Students", href: students },
    leaf: { label: "Aman Kumar", href: `${students}/aman` },
  });
  assert.deepEqual(person.items, [{ label: "Students", href: students }, { label: "Aman Kumar" }]);
  assert.deepEqual(backOf(person), { label: "Students", href: students });

  const face = departmentTrail({
    viewer: "hod",
    department: parts.department,
    list: { label: "Students", href: students },
    leaf: { label: "Aman Kumar", href: `${students}/aman` },
    subleaf: "Face enrollment",
  });
  assert.deepEqual(face.items.map((item) => item.label), ["Students", "Aman Kumar", "Face enrollment"]);
  assert.deepEqual(backOf(face), { label: "Aman Kumar", href: `${students}/aman` }, "back to the student, not the list");

  const adminFace = departmentTrail({
    viewer: "admin",
    department: parts.department,
    list: { label: "Students", href: students },
    leaf: { label: "Aman Kumar", href: `${students}/aman` },
    subleaf: "Face enrollment",
  });
  assert.deepEqual(adminFace.items, [
    { label: "Departments", href: "/dashboard/college/departments" },
    { label: "Computer Science", href: D },
    { label: "Students", href: students },
    { label: "Aman Kumar", href: `${students}/aman` },
    { label: "Face enrollment" },
  ]);
});
