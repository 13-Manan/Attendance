import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_IMPORT_ROWS,
  PREVIEW_ROW_COUNT,
  buildErrorReport,
  buildPreview,
  describeSummary,
  planStudentImport,
  readImportFile,
  suggestMappings,
  targetLabel,
  toStudentInput,
  type ExistingStudent,
  type ImportFormat,
} from "./import-pipeline.ts";
import { parseDelimited } from "./csv.ts";
import { csvFile, xlsxFile } from "../attendance-reporting/export.ts";
import type { FieldMapping } from "./types.ts";

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

function xlsxBuffer(headers: string[], rows: string[][]): Buffer {
  return xlsxFile(
    "import",
    "Sheet1",
    headers.map((header, index) => ({ header, value: (row: string[]) => row[index] ?? "" })),
    rows,
  ).body;
}

test("a CSV is read as CSV", () => {
  const parsed = readImportFile(Buffer.from("student_id,name\nADM-001,Ananya\n", "utf8"));
  assert.equal(parsed.format, "csv");
  assert.deepEqual(parsed.rows, [{ student_id: "ADM-001", name: "Ananya" }]);
});

test("format comes from the bytes, so a renamed file still imports", () => {
  // Both of these arrive every week: an xlsx saved as `.csv`, and a CSV that a
  // tool named `.xlsx`. Trusting the extension means one of them fails with a
  // parser error the administrator cannot act on.
  const asXlsx = readImportFile(xlsxBuffer(["student_id"], [["ADM-001"]]));
  assert.equal(asXlsx.format, "xlsx");
  assert.equal(asXlsx.rows[0].student_id, "ADM-001");

  const asCsv = readImportFile(Buffer.from("student_id\nADM-001\n", "utf8"));
  assert.equal(asCsv.format, "csv");
});

test("both formats produce the same shape downstream", () => {
  const csv = readImportFile(Buffer.from("a,b\n1,2\n", "utf8"));
  const xlsx = readImportFile(xlsxBuffer(["a", "b"], [["1", "2"]]));
  assert.deepEqual(csv.headers, xlsx.headers);
  assert.deepEqual(csv.rows, xlsx.rows);
  assert.deepEqual(csv.rowLines, xlsx.rowLines);
});

test("an explicit delimiter reaches the CSV parser", () => {
  const parsed = readImportFile(Buffer.from("a;b,c\n1;2,3\n", "utf8"), ";");
  assert.deepEqual(parsed.headers, ["a", "b,c"]);
});

// ---------------------------------------------------------------------------
// Suggesting a mapping
// ---------------------------------------------------------------------------

test("the brief's own column names map without configuration", () => {
  const suggested = suggestMappings(["student_id", "student_name"], "students");
  assert.deepEqual(suggested, [
    { source: "student_id", target: "student.externalId" },
    { source: "student_name", target: "student.name" },
  ]);
});

test("the spellings real Indian school exports use are recognised", () => {
  const suggested = suggestMappings(["Admn No.", "Full Name", "Mobile No", "E-Mail ID"], "students");
  assert.deepEqual(suggested, [
    { source: "Admn No.", target: "student.externalId" },
    { source: "Full Name", target: "student.name" },
    { source: "Mobile No", target: "student.phone" },
    { source: "E-Mail ID", target: "student.email" },
  ]);
});

test("a header nothing recognises produces no mapping rather than a guess", () => {
  // `father_name` shares letters with `student.firstName`. A fuzzy matcher
  // would map it, the mapping would look configured, and nobody would look
  // closely at a field the system filled in confidently.
  assert.deepEqual(suggestMappings(["father_name", "fee_balance", "internal_pk"], "students"), []);
});

test("the second column claiming a target is left unmapped for the admin to resolve", () => {
  const suggested = suggestMappings(["student_id", "admn_no"], "students");
  assert.deepEqual(suggested, [{ source: "student_id", target: "student.externalId" }]);
});

test("suggestions are confined to the resource being imported", () => {
  // `class` is a real alias, but `class.externalCode` belongs to the classes
  // import; offering it here would produce a mapping that fails validation.
  const suggested = suggestMappings(["student_id", "class", "section"], "students");
  assert.deepEqual(suggested.map((m) => m.target), ["student.externalId"]);
});

test("suggestion preserves the file's own spelling as the source", () => {
  // The source has to match the column verbatim so the saved mapping keeps
  // working on the next upload of the same report.
  const suggested = suggestMappings(["  Student_ID  "], "students");
  assert.equal(suggested[0].source, "  Student_ID  ");
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

function preview(text: string, mappings?: FieldMapping[]) {
  const parsed = parseDelimited(text);
  return buildPreview({ ...parsed, format: "csv" as ImportFormat }, "students", mappings);
}

test("the preview reports the whole file but shows only the first rows", () => {
  const lines = ["student_id,student_name"];
  for (let i = 0; i < 40; i += 1) lines.push(`ADM-${i},Student ${i}`);
  const result = preview(lines.join("\n"));

  assert.equal(result.totalRows, 40);
  assert.equal(result.sampleRows.length, PREVIEW_ROW_COUNT);
  assert.equal(result.sampleRows[0].student_id, "ADM-0");
});

test("the sample is the parser's output, not the mapped values", () => {
  // The point of the preview is to show what the parser saw. Showing mapped
  // values would hide exactly the mis-parse the preview exists to catch.
  const result = preview('student_id,student_name\nADM-001,"Sharma, Ananya"\n');
  assert.deepEqual(result.sampleRows[0], { student_id: "ADM-001", student_name: "Sharma, Ananya" });
});

test("columns nobody mapped are listed but are not an error", () => {
  const result = preview("student_id,student_name,fee_balance,house\nADM-001,Ananya,1200,Blue\n");
  assert.deepEqual(result.unmappedColumns, ["fee_balance", "house"]);
  assert.deepEqual(result.mappingProblems, []);
});

test("a mapping problem is surfaced before anything is committed", () => {
  const result = preview("student_name\nAnanya\n");
  assert.ok(result.mappingProblems.some((p) => /required/.test(p.message)));
});

test("an explicit mapping overrides the suggestion", () => {
  const result = preview("admn,name\nADM-001,Ananya\n", [
    { source: "admn", target: "student.externalId" },
    { source: "name", target: "student.name" },
  ]);
  assert.deepEqual(result.mappings.map((m) => m.source), ["admn", "name"]);
  assert.deepEqual(result.unmappedColumns, []);
});

test("a file over the ceiling is rejected with the number and the alternative", () => {
  const parsed = {
    format: "csv" as ImportFormat,
    delimiter: ",",
    headers: ["student_id"],
    rows: Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => ({ student_id: `ADM-${i}` })),
    rowLines: [],
  };
  const result = buildPreview(parsed, "students");
  assert.match(result.rejection ?? "", /20,001 rows/);
  assert.match(result.rejection ?? "", /API/);
});

test("a file exactly at the ceiling is accepted", () => {
  const parsed = {
    format: "csv" as ImportFormat,
    delimiter: ",",
    headers: ["student_id"],
    rows: Array.from({ length: MAX_IMPORT_ROWS }, () => ({ student_id: "x" })),
    rowLines: [],
  };
  assert.equal(buildPreview(parsed, "students").rejection, undefined);
});

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const MAPPINGS: FieldMapping[] = [
  { source: "student_id", target: "student.externalId" },
  { source: "student_name", target: "student.name" },
  { source: "email", target: "student.email" },
];

function roster(...students: Array<Partial<ExistingStudent> & { studentCode: string }>) {
  const map = new Map<string, ExistingStudent>();
  for (const student of students) {
    map.set(student.studentCode, {
      id: `id-${student.studentCode}`,
      firstName: "Ananya",
      lastName: "Sharma",
      email: null,
      phone: null,
      status: "ACTIVE",
      ...student,
    });
  }
  return map;
}

function plan(rows: Array<Record<string, string>>, existing = new Map<string, ExistingStudent>()) {
  return planStudentImport(
    rows,
    rows.map((_, i) => i + 2),
    MAPPINGS,
    existing,
  );
}

test("a code the roster does not have is a creation", () => {
  const result = plan([{ student_id: "ADM-001", student_name: "Ananya Sharma" }]);
  assert.equal(result.create.length, 1);
  assert.equal(result.create[0].key, "ADM-001");
  assert.equal(result.create[0].line, 2);
  assert.deepEqual(result.summary, {
    totalRows: 1,
    create: 1,
    update: 0,
    unchanged: 0,
    duplicate: 0,
    error: 0,
  });
});

test("a code that already exists is an update, not a unique-constraint failure", () => {
  // This is what makes a re-upload safe and a nightly sync idempotent.
  const result = plan(
    [{ student_id: "ADM-001", student_name: "Ananya Verma" }],
    roster({ studentCode: "ADM-001" }),
  );
  assert.equal(result.update.length, 1);
  assert.equal(result.errors.length, 0);
});

test("a row identical to what is stored is unchanged, not an update", () => {
  // A school re-uploading last term's roster must be told "1 unchanged", not
  // "1 updated" — the second produces a webhook and an audit row describing a
  // change that did not happen.
  const result = plan(
    [{ student_id: "ADM-001", student_name: "Ananya Sharma" }],
    roster({ studentCode: "ADM-001", firstName: "Ananya", lastName: "Sharma" }),
  );
  assert.equal(result.unchanged.length, 1);
  assert.equal(result.update.length, 0);
});

test("the four-new-admissions case reports the four rows that matter", () => {
  const existing = roster(
    ...Array.from({ length: 6 }, (_, i) => ({ studentCode: `OLD-${i}` })),
  );
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => ({
      student_id: `OLD-${i}`,
      student_name: "Ananya Sharma",
    })),
    ...Array.from({ length: 4 }, (_, i) => ({
      student_id: `NEW-${i}`,
      student_name: "Rohan Gupta",
    })),
  ];
  const result = plan(rows, existing);
  assert.equal(result.summary.create, 4);
  assert.equal(result.summary.unchanged, 6);
  assert.equal(result.summary.update, 0);
});

test("a blank column leaves the stored value alone instead of erasing it", () => {
  // An export that omits the email column would otherwise wipe the email of
  // every student in the institution, while looking like a clean import.
  const result = plan(
    [{ student_id: "ADM-001", student_name: "Ananya Sharma", email: "" }],
    roster({ studentCode: "ADM-001", email: "ananya@example.edu" }),
  );
  assert.equal(result.unchanged.length, 1);
  assert.equal("student.email" in result.unchanged[0].values, false);
});

test("a changed email is an update", () => {
  const result = plan(
    [{ student_id: "ADM-001", student_name: "Ananya Sharma", email: "new@example.edu" }],
    roster({ studentCode: "ADM-001", email: "old@example.edu" }),
  );
  assert.equal(result.update.length, 1);
});

test("filling a field that was previously null counts as a change", () => {
  const result = plan(
    [{ student_id: "ADM-001", student_name: "Ananya Sharma", email: "ananya@example.edu" }],
    roster({ studentCode: "ADM-001", email: null }),
  );
  assert.equal(result.update.length, 1);
});

test("a repeated code keeps the first row and reports the rest with the line to look at", () => {
  const result = plan([
    { student_id: "ADM-001", student_name: "Ananya Sharma" },
    { student_id: "ADM-002", student_name: "Rohan Gupta" },
    { student_id: "ADM-001", student_name: "Someone Else" },
  ]);
  assert.equal(result.create.length, 2);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.duplicates[0].line, 4);
  assert.match(result.duplicates[0].messages[0], /already appeared on line 2/);
});

test("duplicate resolution does not depend on row order being read twice", () => {
  // Last-write-wins would make the import's outcome depend on row order in a
  // way no one could see; first-wins plus an explicit report is visible.
  const result = plan([
    { student_id: "ADM-001", student_name: "First Row" },
    { student_id: "ADM-001", student_name: "Second Row" },
  ]);
  assert.equal(result.create[0].values["student.firstName"], "First");
});

test("a row with no student code is an error, never a blind insert", () => {
  const result = plan([{ student_id: "", student_name: "Ananya Sharma" }]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].messages[0], /cannot be matched/);
  assert.equal(result.create.length, 0);
});

test("a new student with no name is an error", () => {
  const result = plan([{ student_id: "ADM-001", student_name: "" }]);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].messages[0], /needs a name/);
});

test("an existing student needs no name in the file", () => {
  // A file that carries only codes and phone numbers is a legitimate partial
  // update of people who are already enrolled.
  const result = plan(
    [{ student_id: "ADM-001", email: "ananya@example.edu" }],
    roster({ studentCode: "ADM-001" }),
  );
  assert.equal(result.errors.length, 0);
  assert.equal(result.update.length, 1);
});

test("a mapping error on one field does not take out the file", () => {
  const result = planStudentImport(
    [
      { student_id: "ADM-001", status: "Graduated" },
      { student_id: "ADM-002", status: "ACTIVE" },
    ],
    [2, 3],
    [
      { source: "student_id", target: "student.externalId" },
      { source: "status", target: "student.status" },
    ],
    roster({ studentCode: "ADM-001" }, { studentCode: "ADM-002" }),
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].key, "ADM-001");
  assert.equal(result.unchanged.length + result.update.length, 1);
});

test("an errored row is never also counted as created", () => {
  const result = plan([{ student_id: "", student_name: "" }]);
  assert.equal(result.summary.create, 0);
  assert.equal(result.summary.error, 1);
  assert.equal(result.errors[0].messages.length, 2, "both problems are reported at once");
});

test("the summary adds up to the row count", () => {
  const result = plan(
    [
      { student_id: "ADM-001", student_name: "Ananya Sharma" },
      { student_id: "ADM-001", student_name: "Ananya Sharma" },
      { student_id: "ADM-002", student_name: "Rohan Gupta" },
      { student_id: "", student_name: "Nobody" },
      { student_id: "ADM-003", student_name: "Meera Iyer" },
    ],
    roster({ studentCode: "ADM-002", firstName: "Rohan", lastName: "Gupta" }),
  );
  const { create, update, unchanged, duplicate, error, totalRows } = result.summary;
  assert.equal(create + update + unchanged + duplicate + error, totalRows);
  assert.equal(totalRows, 5);
});

test("line numbers come from the file, not from the surviving-row index", () => {
  // `Row 41` has to mean row 41 in the spreadsheet the administrator has open.
  const result = planStudentImport(
    [{ student_id: "" }, { student_id: "" }],
    [7, 19],
    MAPPINGS,
    new Map(),
  );
  assert.deepEqual(result.errors.map((e) => e.line), [7, 19]);
});

test("a missing line number falls back to the row's position rather than undefined", () => {
  const result = planStudentImport([{ student_id: "" }], [], MAPPINGS, new Map());
  assert.equal(result.errors[0].line, 2);
});

test("planning an empty file is a no-op, not a crash", () => {
  const result = plan([]);
  assert.deepEqual(result.summary, {
    totalRows: 0,
    create: 0,
    update: 0,
    unchanged: 0,
    duplicate: 0,
    error: 0,
  });
});

test("planning never mutates the rows it was given", () => {
  const rows = [{ student_id: "ADM-001", student_name: "Ananya Sharma" }];
  const snapshot = structuredClone(rows);
  plan(rows);
  assert.deepEqual(rows, snapshot);
});

// ---------------------------------------------------------------------------
// The error report
// ---------------------------------------------------------------------------

test("the error report lists errors and duplicates together in file order", () => {
  const result = plan([
    { student_id: "ADM-001", student_name: "Ananya Sharma" },
    { student_id: "", student_name: "Nobody" },
    { student_id: "ADM-001", student_name: "Ananya Sharma" },
  ]);
  const report = buildErrorReport(result);
  const parsed = parseDelimited(report.body.toString("utf8"));

  assert.deepEqual(parsed.headers, ["Line", "Student code", "Problem"]);
  // The trailing row is the exporter's notice, which lands in the first column.
  assert.deepEqual(parsed.rows.slice(0, 2).map((r) => r.Line), ["3", "4"]);
});

test("the report says plainly that the listed rows were not imported", () => {
  const report = buildErrorReport(plan([{ student_id: "" }]));
  assert.match(report.body.toString("utf8"), /Nothing from this file was imported/);
});

test("a clean import still produces a readable report rather than a broken file", () => {
  const report = buildErrorReport(plan([{ student_id: "ADM-001", student_name: "Ananya Sharma" }]));
  const parsed = parseDelimited(report.body.toString("utf8"));
  assert.equal(parsed.rows.filter((row) => row.Line !== "").length, 1, "only the notice row");
  assert.match(report.filename, /import-errors/);
});

test("the report filename can be set to match the uploaded file", () => {
  const report = buildErrorReport(plan([]), "roster-term-2-errors");
  assert.match(report.filename, /roster-term-2-errors/);
});

test("a problem containing a comma does not shift the report's columns", () => {
  // The report is written with the platform's own CSV writer, so this is a
  // regression guard on the pairing rather than on the quoting itself.
  const result = plan([{ student_id: "", student_name: "" }]);
  const parsed = parseDelimited(buildErrorReport(result).body.toString("utf8"));
  assert.match(parsed.rows[0].Problem, /cannot be matched[\s\S]*needs a name/);
});

// ---------------------------------------------------------------------------
// Describing and handing off
// ---------------------------------------------------------------------------

test("a clean summary reads as three numbers, with no zero-noise", () => {
  assert.equal(
    describeSummary({ totalRows: 10, create: 4, update: 1, unchanged: 5, duplicate: 0, error: 0 }),
    "10 row(s): 4 created, 1 updated, 5 unchanged.",
  );
});

test("problems appear in the sentence only when there are problems", () => {
  const sentence = describeSummary({
    totalRows: 10,
    create: 4,
    update: 1,
    unchanged: 2,
    duplicate: 1,
    error: 2,
  });
  assert.match(sentence, /1 duplicate/);
  assert.match(sentence, /2 with errors/);
});

test("the planned row converts to the students service's input", () => {
  const result = plan([
    { student_id: "ADM-001", student_name: "Ananya Sharma", email: "ananya@example.edu" },
  ]);
  assert.deepEqual(toStudentInput(result.create[0]), {
    studentCode: "ADM-001",
    firstName: "Ananya",
    lastName: "Sharma",
    email: "ananya@example.edu",
    phone: undefined,
  });
});

test("a single-token name converts with an empty last name rather than undefined", () => {
  const result = plan([{ student_id: "ADM-001", student_name: "Ananya" }]);
  const input = toStudentInput(result.create[0]);
  assert.equal(input.firstName, "Ananya");
  assert.equal(input.lastName, "");
});

test("target labels are the ones the mapping UI shows", () => {
  assert.equal(targetLabel("student.externalId"), "Student code");
  assert.equal(targetLabel("student.nickname"), "student.nickname", "unknown keys show themselves");
});

// ---------------------------------------------------------------------------
// End to end, through a file this repo wrote
// ---------------------------------------------------------------------------

test("a CSV exported by this platform re-imports as entirely unchanged", () => {
  // The round trip that matters operationally: export the roster, edit two
  // rows in Excel, upload it back. Everything untouched must come back
  // `unchanged`, or the administrator gets 1,200 spurious updates.
  const students = [
    { code: "ADM-001", name: "Ananya Sharma", email: "ananya@example.edu" },
    { code: "ADM-002", name: "Rohan Gupta", email: "rohan@example.edu" },
  ];
  const file = csvFile(
    "students",
    [
      { header: "student_id", value: (s: (typeof students)[number]) => s.code },
      { header: "student_name", value: (s: (typeof students)[number]) => s.name },
      { header: "email", value: (s: (typeof students)[number]) => s.email },
    ],
    students,
  );

  const parsed = readImportFile(file.body);
  const suggested = suggestMappings(parsed.headers, "students");
  const result = planStudentImport(
    parsed.rows,
    parsed.rowLines,
    suggested,
    roster(
      { studentCode: "ADM-001", firstName: "Ananya", lastName: "Sharma", email: "ananya@example.edu" },
      { studentCode: "ADM-002", firstName: "Rohan", lastName: "Gupta", email: "rohan@example.edu" },
    ),
  );

  assert.equal(result.summary.unchanged, 2);
  assert.equal(result.summary.update, 0);
  assert.equal(result.summary.error, 0);
});
