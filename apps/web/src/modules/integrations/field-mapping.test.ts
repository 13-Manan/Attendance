import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAPPINGS,
  TARGET_FIELDS,
  applyMapping,
  applyTransform,
  defaultMappingsFor,
  targetField,
  targetFieldsFor,
  validateMapping,
} from "./field-mapping.ts";
import type { FieldMapping } from "./types.ts";

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test("every target the brief's mapping table names exists", () => {
  for (const key of [
    "student.externalId",
    "student.name",
    "class.externalCode",
    "section.externalCode",
    "subject.externalCode",
  ]) {
    assert.notEqual(targetField(key), null, `${key} should be a target`);
  }
});

test("every target declares where it is actually stored", () => {
  // The UI shows this so an administrator is never guessing where their data
  // landed, and so nobody has to grep the schema to find out.
  for (const field of TARGET_FIELDS) {
    assert.ok(field.storedAs.includes("."), `${field.key} needs a storedAs`);
    assert.ok(field.label.length > 0);
  }
});

test("target keys are unique", () => {
  assert.equal(new Set(TARGET_FIELDS.map((f) => f.key)).size, TARGET_FIELDS.length);
});

test("student status accepts exactly the schema's EnrollmentStatus values", () => {
  assert.deepEqual(targetField("student.status")?.enumValues, [
    "ACTIVE",
    "INACTIVE",
    "TRANSFERRED",
    "COMPLETED",
  ]);
});

test("an unknown target resolves to null rather than a plausible-looking guess", () => {
  assert.equal(targetField("student.middleName"), null);
  assert.equal(targetField(""), null);
});

test("targets are grouped by resource", () => {
  assert.ok(targetFieldsFor("students").every((f) => f.resource === "students"));
  assert.ok(targetFieldsFor("students").length > 0);
});

test("the shipped defaults are the brief's own table and are all valid targets", () => {
  assert.equal(DEFAULT_MAPPINGS.student_id, "student.externalId");
  assert.equal(DEFAULT_MAPPINGS.class_code, "class.externalCode");
  for (const target of Object.values(DEFAULT_MAPPINGS)) {
    assert.notEqual(targetField(target), null, `${target} must exist`);
  }
});

test("default mappings are filtered to the resource being imported", () => {
  const defaults = defaultMappingsFor("students");
  assert.ok(defaults.some((m) => m.target === "student.externalId"));
  assert.equal(defaults.some((m) => m.target === "subject.externalCode"), false);
});

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

test("no transform passes the value through untouched", () => {
  assert.equal(applyTransform("  Ananya  ", undefined), "  Ananya  ");
});

test("the text transforms do what they say", () => {
  assert.equal(applyTransform("  abc  ", "trim"), "abc");
  assert.equal(applyTransform(" abc ", "uppercase"), "ABC");
  assert.equal(applyTransform(" ABC ", "lowercase"), "abc");
  assert.equal(applyTransform("+91 98765-43210", "digits_only"), "919876543210");
});

test("dd/mm/yyyy and mm/dd/yyyy are read as the administrator configured, not sniffed", () => {
  // 05/03 is a real date in both readings; guessing would file a term's
  // attendance against the wrong dates and nobody would notice until a report
  // was printed.
  assert.equal(applyTransform("05/03/2026", "date_dmy"), "2026-03-05");
  assert.equal(applyTransform("05/03/2026", "date_mdy"), "2026-05-03");
});

test("date transforms accept the separators real exports use", () => {
  assert.equal(applyTransform("05-03-2026", "date_dmy"), "2026-03-05");
  assert.equal(applyTransform("05.03.2026", "date_dmy"), "2026-03-05");
  assert.equal(applyTransform("5/3/26", "date_dmy"), "2026-03-05");
});

test("an impossible date is an error, never a silently rolled-over one", () => {
  // JavaScript's Date would turn 31 February into 3 March without complaint.
  assert.equal(applyTransform("31/02/2026", "date_dmy"), null);
  assert.equal(applyTransform("13/13/2026", "date_dmy"), null);
  assert.equal(applyTransform("00/01/2026", "date_dmy"), null);
  assert.equal(applyTransform("not a date", "date_dmy"), null);
  assert.equal(applyTransform("05/2026", "date_dmy"), null);
});

test("29 February is accepted in a leap year and rejected otherwise", () => {
  assert.equal(applyTransform("29/02/2024", "date_dmy"), "2024-02-29");
  assert.equal(applyTransform("29/02/2026", "date_dmy"), null);
});

test("an ISO date is accepted and any timestamp suffix is dropped", () => {
  assert.equal(applyTransform("2026-03-05", "date_iso"), "2026-03-05");
  assert.equal(applyTransform("2026-03-05T10:30:00Z", "date_iso"), "2026-03-05");
  assert.equal(applyTransform("05/03/2026", "date_iso"), null);
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const VALID: FieldMapping[] = [
  { source: "student_id", target: "student.externalId" },
  { source: "student_name", target: "student.name" },
];

test("a complete, well-formed mapping has no problems", () => {
  assert.deepEqual(validateMapping(VALID, "students"), []);
});

test("a missing required target is reported by name", () => {
  const problems = validateMapping([{ source: "student_name", target: "student.name" }], "students");
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /student\.externalId.*required/);
});

test("an unknown target is reported rather than silently dropped", () => {
  const problems = validateMapping([...VALID, { source: "x", target: "student.nickname" }], "students");
  assert.ok(problems.some((p) => /Unknown field/.test(p.message)));
});

test("a target belonging to another resource is rejected", () => {
  const problems = validateMapping([...VALID, { source: "sub", target: "subject.externalCode" }], "students");
  assert.ok(problems.some((p) => /belongs to subjects/.test(p.message)));
});

test("two columns writing one field is a coin flip, so it is an error", () => {
  const problems = validateMapping(
    [...VALID, { source: "admn_no", target: "student.externalId" }],
    "students",
  );
  assert.ok(problems.some((p) => /mapped more than once/.test(p.message)));
});

test("one column mapped twice is an error too", () => {
  const problems = validateMapping(
    [...VALID, { source: "student_id", target: "student.email" }],
    "students",
  );
  assert.ok(problems.some((p) => /used more than once/.test(p.message)));
});

test("an empty external field name is reported", () => {
  const problems = validateMapping([...VALID, { source: "   ", target: "student.email" }], "students");
  assert.ok(problems.some((p) => /empty/.test(p.message)));
});

test("a mapping is checked against the file's real columns at save time", () => {
  const problems = validateMapping(VALID, "students", ["student_id", "studnet_name"]);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /no column named `student_name`/);
});

test("column matching tolerates the casing and stray spaces a re-saved file carries", () => {
  assert.deepEqual(validateMapping(VALID, "students", ["  Student_ID ", "STUDENT_NAME"]), []);
});

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

test("a row is translated into canonical keys", () => {
  const result = applyMapping({ student_id: "ADM-001", student_name: "Ananya Sharma" }, VALID);
  assert.deepEqual(result.values, {
    "student.externalId": "ADM-001",
    "student.firstName": "Ananya",
    "student.lastName": "Sharma",
  });
  assert.deepEqual(result.errors, []);
});

test("header lookup survives the casing and spacing a real export carries", () => {
  const result = applyMapping({ " Student_ID ": "ADM-001" }, [VALID[0]]);
  assert.equal(result.values["student.externalId"], "ADM-001");
});

test("a single-token name becomes a first name, not a rejected row", () => {
  // Refusing it would be this system telling a real student their name is
  // invalid.
  const result = applyMapping({ student_name: "Ananya" }, [VALID[1]]);
  assert.equal(result.values["student.firstName"], "Ananya");
  assert.equal(result.values["student.lastName"], "");
});

test("a multi-part surname stays whole", () => {
  const result = applyMapping({ student_name: "Maria da Silva Santos" }, [VALID[1]]);
  assert.equal(result.values["student.firstName"], "Maria");
  assert.equal(result.values["student.lastName"], "da Silva Santos");
});

test("a missing or blank column yields no value rather than an empty one", () => {
  const result = applyMapping({ student_id: "   " }, VALID);
  assert.equal("student.externalId" in result.values, false);
  assert.equal("student.firstName" in result.values, false);
});

test("a fallback fills a blank column", () => {
  const result = applyMapping({ student_id: "ADM-001", status: "" }, [
    VALID[0],
    { source: "status", target: "student.status", fallback: "ACTIVE" },
  ]);
  assert.equal(result.values["student.status"], "ACTIVE");
});

test("an enum value is normalised to upper case", () => {
  const result = applyMapping({ status: "active" }, [{ source: "status", target: "student.status" }]);
  assert.equal(result.values["student.status"], "ACTIVE");
});

test("a value outside the enum is an error naming the accepted values", () => {
  const result = applyMapping({ status: "Graduated" }, [{ source: "status", target: "student.status" }]);
  assert.equal("student.status" in result.values, false);
  assert.match(result.errors[0].message, /ACTIVE, INACTIVE, TRANSFERRED, COMPLETED/);
});

test("a transform failure is an error on that field, not a lost row", () => {
  const result = applyMapping({ student_id: "ADM-001", dob: "31/02/2026" }, [
    VALID[0],
    { source: "dob", target: "attendance.date", transform: "date_dmy" },
  ]);
  assert.equal(result.values["student.externalId"], "ADM-001", "the rest of the row survives");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].target, "attendance.date");
});

test("a transform is applied before the value is stored", () => {
  const result = applyMapping({ code: " adm-001 " }, [
    { source: "code", target: "student.externalId", transform: "uppercase" },
  ]);
  assert.equal(result.values["student.externalId"], "ADM-001");
});

test("columns the mapping does not name are ignored", () => {
  const result = applyMapping({ student_id: "ADM-001", internal_pk: "99", fee_balance: "1200" }, [VALID[0]]);
  assert.deepEqual(result.values, { "student.externalId": "ADM-001" });
});

test("applying a mapping never mutates the row", () => {
  const row = { student_id: "ADM-001", student_name: "Ananya Sharma" };
  const snapshot = structuredClone(row);
  applyMapping(row, VALID);
  assert.deepEqual(row, snapshot);
});
