import { test } from "node:test";
import assert from "node:assert/strict";
import { csvField, toCsv } from "./export.ts";
import { validateStudentName } from "../students/directory-policy.ts";

/**
 * Phase 14 — a name is not allowed to become a formula.
 *
 * `csvField` quoted per RFC 4180 and did nothing else, on the stated grounds
 * that "nothing in an attendance report is user-authored free text that
 * reaches a cell — names and codes come from the institution's own records."
 *
 * The premise conflates *stored by us* with *not attacker-chosen*. A student's
 * name is typed into a form by a person, and `validateStudentName` checks only
 * that it is non-empty and short enough. `Student`, `Class`, `Subject` and
 * `Faculty` are all columns in the records export, so a student named
 * `=HYPERLINK(...)` becomes a live formula in the recipient's spreadsheet —
 * CWE-1236, and the recipient is typically an administrator who had every
 * reason to trust the file.
 *
 * The XLSX path was never affected: it writes `t="inlineStr"`, which Excel
 * renders literally. Only the CSV encoder needed changing, so only it did.
 *
 * These payloads are inert strings here; nothing in this test executes them.
 */

/** The four prefixes Excel and LibreOffice treat as the start of a formula. */
const FORMULA_PAYLOADS = [
  '=HYPERLINK("http://example.invalid","click")',
  "+1+1",
  "-1+1",
  "@SUM(A1:A2)",
  // Leading whitespace is skipped by the parser before the prefix is read.
  "\t=1+1",
  "\r=1+1",
];

test("a formula-prefixed name is neutralised in a CSV cell", () => {
  for (const payload of FORMULA_PAYLOADS) {
    const encoded = csvField(payload);
    assert.ok(
      !/^"?[=+\-@\t\r]/.test(encoded),
      `${JSON.stringify(payload)} still opens with a formula prefix: ${JSON.stringify(encoded)}`,
    );
  }
});

test("the guarded cell still carries the original text", () => {
  // Neutralised, not censored. The reader must still be able to see the name
  // that was stored, or the export stops being a record of anything.
  const encoded = csvField("=1+1");
  assert.ok(encoded.includes("=1+1"), `lost the value: ${encoded}`);
});

test("ordinary names are left exactly as they were", () => {
  // The guard must not fire on real data, or every export changes shape.
  for (const name of ["Priya Sharma", "O'Neill", "Jean-Luc", "Smith, John", "10-A", "Grade 5"]) {
    const encoded = csvField(name);
    const expected = /[",\n\r]/.test(name) ? `"${name.replace(/"/g, '""')}"` : name;
    assert.equal(encoded, expected, `${name} should round-trip unchanged`);
  }
});

test("numbers are never treated as formulas", () => {
  // Negative numbers arrive as numbers, not strings, and must stay numeric —
  // prefixing them would turn an attendance count into text.
  assert.equal(csvField(-5), "-5");
  assert.equal(csvField(0), "0");
  assert.equal(csvField(98.5), "98.5");
});

test("quoting and escaping still follow RFC 4180", () => {
  assert.equal(csvField('He said "hi"'), '"He said ""hi"""');
  assert.equal(csvField("a,b"), '"a,b"');
  assert.equal(csvField("line\nbreak"), '"line\nbreak"');
  assert.equal(csvField(null), "");
});

test("a payload survives a whole-file render without opening a formula", () => {
  const csv = toCsv(
    [
      { header: "Student code", value: (r: { code: string; name: string }) => r.code },
      { header: "Student", value: (r: { code: string; name: string }) => r.name },
    ],
    [{ code: "S-1", name: '=HYPERLINK("http://example.invalid","click")' }],
  );

  const dataLine = csv.split("\r\n")[1];
  const cells = dataLine.split(",");
  assert.ok(
    !/^"?=/.test(cells[1]),
    `the name cell is still a formula: ${JSON.stringify(dataLine)}`,
  );
});

test("the name that makes this reachable is accepted by validation", () => {
  // Reachability, not encoding: if the directory refused these outright there
  // would be nothing to neutralise. It does not — length and non-emptiness
  // are the only rules.
  assert.equal(validateStudentName('=HYPERLINK("http://x","c")', "first name"), '=HYPERLINK("http://x","c")');
  assert.equal(validateStudentName("@SUM(A1:A2)", "last name"), "@SUM(A1:A2)");
});
