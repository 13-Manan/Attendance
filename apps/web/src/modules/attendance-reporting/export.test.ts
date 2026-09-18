import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  buildExport,
  columnName,
  crc32,
  csvField,
  isExportFormat,
  safeFilename,
  safeSheetName,
  toCsv,
  xlsxFile,
} from "./export.ts";
import type { ExportColumn } from "./export.ts";

interface Row {
  name: string;
  rate: number | null;
}

const COLUMNS: Array<ExportColumn<Row>> = [
  { header: "Student", value: (r) => r.name },
  { header: "Attendance %", value: (r) => r.rate },
];

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test("csvField quotes only when RFC 4180 requires it", () => {
  assert.equal(csvField("Priya Sharma"), "Priya Sharma");
  assert.equal(csvField("Sharma, Priya"), '"Sharma, Priya"');
  assert.equal(csvField('She said "hi"'), '"She said ""hi"""');
  assert.equal(csvField("line\nbreak"), '"line\nbreak"');
  assert.equal(csvField(87.5), "87.5");
});

test("a null cell is blank, never zero", () => {
  // A student with no attendance recorded has not attended 0% of classes;
  // they have no percentage at all. Writing 0 would be a false statement.
  assert.equal(csvField(null), "");
  const csv = toCsv(COLUMNS, [{ name: "New Student", rate: null }]);
  assert.equal(csv.split("\r\n")[1], "New Student,");
});

test("toCsv writes a header row and CRLF line endings", () => {
  const csv = toCsv(COLUMNS, [
    { name: "Aisha Khan", rate: 92.3 },
    { name: "Rahul, Jr.", rate: 61 },
  ]);
  assert.deepEqual(csv.split("\r\n"), [
    "Student,Attendance %",
    "Aisha Khan,92.3",
    '"Rahul, Jr.",61',
  ]);
});

test("a truncation notice is written into the file, not only into a header", () => {
  const csv = toCsv(COLUMNS, [{ name: "A", rate: 1 }], "Truncated: showing the first 2 rows");
  assert.equal(csv.split("\r\n").at(-1), "Truncated: showing the first 2 rows");
});

test("a CSV export carries a BOM so Excel does not mangle non-ASCII names", () => {
  const file = buildExport("csv", "report", "Report", COLUMNS, [{ name: "Ananya Iyer", rate: 80 }]);
  assert.equal(file.filename, "report.csv");
  assert.equal(file.body.subarray(0, 3).toString("hex"), "efbbbf");
  assert.match(file.body.toString("utf8"), /Ananya Iyer/);
});

// ---------------------------------------------------------------------------
// Filenames and sheet names
// ---------------------------------------------------------------------------

test("safeFilename cannot split a Content-Disposition header or escape a directory", () => {
  // Dots survive — a filename needs its extension — but every separator and
  // every quote is replaced, so there is no path to traverse and no way to
  // terminate the header's quoted string early.
  assert.equal(safeFilename("../../etc/passwd"), "..-..-etc-passwd");
  assert.equal(safeFilename('report"; rm -rf /'), "report-rm--rf");
  assert.equal(safeFilename('a"\r\nX-Injected: 1'), "a-X-Injected-1");
  assert.equal(safeFilename("attendance-by-course-2026-06-18"), "attendance-by-course-2026-06-18");
  assert.equal(safeFilename("!!!"), "report");
  assert.equal(safeFilename("x".repeat(500)).length, 120);
});

test("safeSheetName obeys the limits Excel enforces", () => {
  // Excel refuses to open a workbook whose sheet name exceeds 31 characters
  // or contains []:*?/\ — so a report title must be sanitized, not trusted.
  assert.equal(safeSheetName("Attendance [2026]/Q1"), "Attendance  2026  Q1");
  assert.equal(safeSheetName("a".repeat(40)).length, 31);
  assert.equal(safeSheetName("///"), "Report");
});

test("isExportFormat accepts exactly the two supported formats", () => {
  assert.equal(isExportFormat("csv"), true);
  assert.equal(isExportFormat("xlsx"), true);
  assert.equal(isExportFormat("pdf"), false);
  assert.equal(isExportFormat(""), false);
});

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

test("columnName is bijective base-26", () => {
  assert.equal(columnName(0), "A");
  assert.equal(columnName(25), "Z");
  assert.equal(columnName(26), "AA");
  assert.equal(columnName(27), "AB");
  assert.equal(columnName(51), "AZ");
  assert.equal(columnName(52), "BA");
});

test("crc32 matches the known check value", () => {
  // The standard CRC-32 of "123456789" is 0xCBF43926. If this drifts, every
  // workbook this module writes is silently corrupt.
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

/** Reads one entry back out of the zip this module wrote. */
function readZipEntry(zipped: Buffer, name: string): string {
  // Walk the local file headers rather than the central directory: it is the
  // shorter path to "does the entry inflate to what we wrote".
  let offset = 0;
  while (offset < zipped.length && zipped.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zipped.readUInt32LE(offset + 18);
    const nameLength = zipped.readUInt16LE(offset + 26);
    const extraLength = zipped.readUInt16LE(offset + 28);
    const entryName = zipped.subarray(offset + 30, offset + 30 + nameLength).toString("utf8");
    const dataStart = offset + 30 + nameLength + extraLength;
    if (entryName === name) {
      return inflateRawSync(zipped.subarray(dataStart, dataStart + compressedSize)).toString("utf8");
    }
    offset = dataStart + compressedSize;
  }
  throw new Error(`entry not found: ${name}`);
}

test("the workbook is a readable zip with the five parts a reader expects", () => {
  const file = xlsxFile("report", "Attendance", COLUMNS, [{ name: "Aisha Khan", rate: 92.3 }]);
  assert.equal(file.filename, "report.xlsx");
  assert.equal(
    file.contentType,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  // "PK\x03\x04" — the local file header signature every zip reader looks for.
  assert.equal(file.body.subarray(0, 4).toString("hex"), "504b0304");

  for (const part of [
    "[Content_Types].xml",
    "_rels/.rels",
    "xl/workbook.xml",
    "xl/_rels/workbook.xml.rels",
    "xl/worksheets/sheet1.xml",
  ]) {
    assert.ok(readZipEntry(file.body, part).length > 0, `${part} should inflate`);
  }
});

test("numbers are written as numbers and text as inline strings", () => {
  // A percentage stored as text does not sort or average in a spreadsheet,
  // which is most of what an administrator opens one to do.
  const file = xlsxFile("report", "Attendance", COLUMNS, [{ name: "Aisha Khan", rate: 92.3 }]);
  const sheet = readZipEntry(file.body, "xl/worksheets/sheet1.xml");
  assert.match(sheet, /<c r="B2"><v>92.3<\/v><\/c>/);
  assert.match(sheet, /<c r="A2" t="inlineStr"><is><t xml:space="preserve">Aisha Khan</);
});

test("a null cell is omitted from the sheet rather than written as zero", () => {
  const file = xlsxFile("report", "Attendance", COLUMNS, [{ name: "New Student", rate: null }]);
  const sheet = readZipEntry(file.body, "xl/worksheets/sheet1.xml");
  assert.equal(sheet.includes('r="B2"'), false);
});

test("XML metacharacters in a name cannot break the sheet", () => {
  const file = xlsxFile("report", "Attendance", COLUMNS, [{ name: 'A & B <c> "d"', rate: 50 }]);
  const sheet = readZipEntry(file.body, "xl/worksheets/sheet1.xml");
  assert.match(sheet, /A &amp; B &lt;c&gt; &quot;d&quot;/);
});

test("the same report exported twice is byte-identical", () => {
  // The zip carries a fixed timestamp for this reason: a diffable export is
  // one an administrator can compare between two months.
  const rows = [{ name: "Aisha Khan", rate: 92.3 }];
  const a = xlsxFile("report", "Attendance", COLUMNS, rows);
  const b = xlsxFile("report", "Attendance", COLUMNS, rows);
  assert.deepEqual(a.body, b.body);
});

/**
 * The end-to-end check the unit tests above cannot make: that a real
 * spreadsheet reader accepts the file. macOS ships Python 3 with `zipfile` in
 * its standard library, which validates the archive's central directory and
 * every entry's CRC — the two things a hand-written zip writer gets wrong.
 * Skipped rather than failed where Python is absent, so CI on a bare image
 * does not go red for a missing interpreter.
 */
test("a real zip reader accepts the workbook and its CRCs", (t) => {
  const file = xlsxFile("report", "Attendance", COLUMNS, [
    { name: "Aisha Khan", rate: 92.3 },
    { name: "Rahul Verma", rate: null },
  ]);
  const path = join(mkdtempSync(join(tmpdir(), "xlsx-")), "report.xlsx");
  writeFileSync(path, file.body);

  let output: string;
  try {
    output = execFileSync(
      "python3",
      [
        "-c",
        [
          "import sys,zipfile",
          "z=zipfile.ZipFile(sys.argv[1])",
          "assert z.testzip() is None",
          "print(','.join(sorted(z.namelist())))",
        ].join("\n"),
        path,
      ],
      { encoding: "utf8" },
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return t.skip("python3 not available");
    throw error;
  }

  assert.equal(
    output.trim(),
    "[Content_Types].xml,_rels/.rels,xl/_rels/workbook.xml.rels,xl/workbook.xml,xl/worksheets/sheet1.xml",
  );
});
