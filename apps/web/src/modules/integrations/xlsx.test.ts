import { test } from "node:test";
import assert from "node:assert/strict";
import { columnIndex, looksLikeXlsx, parseXlsx, readZip } from "./xlsx.ts";
import { columnName, xlsxFile } from "../attendance-reporting/export.ts";

/**
 * Every fixture here is produced by this repo's own xlsx *writer*
 * (attendance-reporting/export.ts). That is deliberate: it proves the reader
 * against a file the platform actually emits, rather than against a
 * hand-written fixture that could be wrong in the same direction as the
 * reader. The two were written independently — the writer in an earlier phase,
 * for reports; the reader here, for imports.
 */
function write(
  headers: string[],
  rows: string[][],
  notice?: string,
): Buffer {
  const columns = headers.map((header, index) => ({
    header,
    value: (row: string[]) => row[index] ?? "",
  }));
  return xlsxFile("import", "Sheet1", columns, rows, notice).body;
}

// ---------------------------------------------------------------------------
// Column references
// ---------------------------------------------------------------------------

test("columnIndex is the inverse of the writer's columnName", () => {
  for (const index of [0, 1, 25, 26, 27, 51, 52, 54, 701, 702, 16_383]) {
    assert.equal(columnIndex(`${columnName(index)}7`), index, `index ${index}`);
  }
});

test("columnIndex reads the letters and ignores the row number", () => {
  assert.equal(columnIndex("A1"), 0);
  assert.equal(columnIndex("BC7"), 54);
  assert.equal(columnIndex("bc7"), 54, "lower case is tolerated");
});

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

test("an xlsx is recognised by its zip signature, not by a filename", () => {
  assert.equal(looksLikeXlsx(write(["a"], [["1"]])), true);
  assert.equal(looksLikeXlsx(Buffer.from("student_id,name\n1,Ananya\n", "utf8")), false);
  assert.equal(looksLikeXlsx(Buffer.alloc(0)), false);
});

// ---------------------------------------------------------------------------
// Zip reading
// ---------------------------------------------------------------------------

test("every part of the workbook is found", () => {
  const entries = readZip(write(["a"], [["1"]]));
  for (const name of [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/worksheets/sheet1.xml",
  ]) {
    assert.equal(entries.has(name), true, `${name} should be present`);
  }
});

test("a file that is not a zip fails with a sentence, not a decode error twenty lines later", () => {
  assert.throws(
    () => readZip(Buffer.from("student_id,name\n1,Ananya", "utf8")),
    /not a valid \.xlsx file/i,
  );
});

test("a truncated zip fails cleanly", () => {
  const full = write(["a"], [["1"]]);
  assert.throws(() => readZip(full.subarray(0, Math.floor(full.length / 2))));
});

// ---------------------------------------------------------------------------
// Sheet reading
// ---------------------------------------------------------------------------

test("a written workbook reads back as the table that was written", () => {
  const buffer = write(
    ["student_id", "student_name", "class_code"],
    [
      ["ADM-001", "Ananya Sharma", "10-A"],
      ["ADM-002", "Rohan Gupta", "10-B"],
    ],
  );
  const parsed = parseXlsx(buffer);

  assert.deepEqual(parsed.headers, ["student_id", "student_name", "class_code"]);
  assert.deepEqual(parsed.rows, [
    { student_id: "ADM-001", student_name: "Ananya Sharma", class_code: "10-A" },
    { student_id: "ADM-002", student_name: "Rohan Gupta", class_code: "10-B" },
  ]);
});

test("the parsed shape is interchangeable with the CSV parser's", () => {
  // Downstream — preview, validation, error report — must not be able to tell
  // which format it was handed.
  const parsed = parseXlsx(write(["id"], [["1"]]));
  assert.deepEqual(Object.keys(parsed).sort(), ["delimiter", "headers", "rowLines", "rows"]);
});

test("row numbers match what the administrator sees in Excel", () => {
  const parsed = parseXlsx(write(["id"], [["1"], ["2"], ["3"]]));
  assert.deepEqual(parsed.rowLines, [2, 3, 4]);
});

test("characters that must be XML-escaped survive the round trip", () => {
  const parsed = parseXlsx(
    write(["name", "note"], [["Sharma & Sons", '<tag> "quoted" & ampersand']]),
  );
  assert.equal(parsed.rows[0].name, "Sharma & Sons");
  assert.equal(parsed.rows[0].note, '<tag> "quoted" & ampersand');
});

test("an already-escaped entity is not double-decoded", () => {
  // `&amp;lt;` must come back as the literal text `&lt;`, not as `<`.
  const parsed = parseXlsx(write(["note"], [["&lt;not a tag&gt;"]]));
  assert.equal(parsed.rows[0].note, "&lt;not a tag&gt;");
});

test("unicode names survive", () => {
  const parsed = parseXlsx(write(["name"], [["अनन्या शर्मा"], ["李雷"]]));
  assert.equal(parsed.rows[0].name, "अनन्या शर्मा");
  assert.equal(parsed.rows[1].name, "李雷");
});

test("an empty cell does not shift the columns after it", () => {
  const parsed = parseXlsx(write(["a", "b", "c"], [["1", "", "3"]]));
  assert.deepEqual(parsed.rows[0], { a: "1", b: "", c: "3" });
});

test("a row that is entirely empty is dropped", () => {
  // A spreadsheet with deleted rows keeps thousands of them, and importing
  // them would produce thousands of unactionable error lines.
  const parsed = parseXlsx(write(["a", "b"], [["1", "2"], ["", ""], ["3", "4"]]));
  assert.equal(parsed.rows.length, 2);
  assert.deepEqual(parsed.rows[1], { a: "3", b: "4" });
});

test("a wide sheet past column Z is read at the right positions", () => {
  const headers = Array.from({ length: 60 }, (_, i) => `col_${i}`);
  const values = Array.from({ length: 60 }, (_, i) => `v${i}`);
  const parsed = parseXlsx(write(headers, [values]));
  assert.equal(parsed.headers.length, 60);
  assert.equal(parsed.rows[0].col_0, "v0");
  assert.equal(parsed.rows[0].col_26, "v26");
  assert.equal(parsed.rows[0].col_59, "v59");
});

test("a header-only workbook yields no rows", () => {
  const parsed = parseXlsx(write(["student_id", "name"], []));
  assert.deepEqual(parsed.headers, ["student_id", "name"]);
  assert.deepEqual(parsed.rows, []);
});

test("a leading-zero code is preserved as text, not turned into a number", () => {
  const parsed = parseXlsx(write(["student_id"], [["0012"]]));
  assert.equal(parsed.rows[0].student_id, "0012");
});

test("a notice row written by the exporter is readable rather than fatal", () => {
  const parsed = parseXlsx(write(["id"], [["1"]], "Generated 16 Sep 2026"));
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[1].id, "Generated 16 Sep 2026");
});

test("a large sheet reads", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => [`ADM-${i}`, `Student ${i}`]);
  const parsed = parseXlsx(write(["student_id", "name"], rows));
  assert.equal(parsed.rows.length, 2000);
  assert.equal(parsed.rows[1999].student_id, "ADM-1999");
});
