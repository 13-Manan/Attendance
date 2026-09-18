import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAcademicUnitTree } from "./service.ts";
import type { AcademicUnit } from "./types.ts";

// Pure branch of the service — no auth, just the tree shape.
test("buildAcademicUnitTree groups children under their parent", () => {
  const grade: AcademicUnit = {
    id: "g1",
    institutionId: "inst-A",
    campusId: null,
    parentId: null,
    kind: "GRADE",
    name: "Grade 10",
    code: null,
    sortOrder: 0,
    metadata: {},
    createdAt: new Date(),
  } as unknown as AcademicUnit;
  const sectionA: AcademicUnit = { ...grade, id: "s1", parentId: "g1", kind: "SECTION", name: "A" } as AcademicUnit;
  const sectionB: AcademicUnit = { ...grade, id: "s2", parentId: "g1", kind: "SECTION", name: "B" } as AcademicUnit;
  const orphan: AcademicUnit = { ...grade, id: "o1", parentId: "missing", kind: "SECTION", name: "Orphan" } as AcademicUnit;

  const tree = buildAcademicUnitTree([grade, sectionA, sectionB, orphan]);
  const gradeNode = tree.find((n) => n.id === "g1");
  assert.equal(gradeNode?.children.length, 2);
  assert.deepEqual(gradeNode?.children.map((c) => c.id).sort(), ["s1", "s2"]);
  // Orphan whose parent isn't in the input list becomes a root itself, never
  // silently dropped.
  assert.equal(tree.some((n) => n.id === "o1"), true);
});
