import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDelimited, sniffDelimiter } from "./csv.ts";
import { csvFile } from "../attendance-reporting/export.ts";

// ---------------------------------------------------------------------------
// The basics
// ---------------------------------------------------------------------------

test("a plain file parses into headers and rows", () => {
  const parsed = parseDelimited("student_id,name\nADM-001,Ananya\nADM-002,Rohan\n");
  assert.deepEqual(parsed.headers, ["student_id", "name"]);
  assert.deepEqual(parsed.rows, [
    { student_id: "ADM-001", name: "Ananya" },
    { student_id: "ADM-002", name: "Rohan" },
  ]);
});

test("row line numbers point at the file line an administrator can open", () => {
  const parsed = parseDelimited("student_id\nADM-001\nADM-002\n");
  assert.deepEqual(parsed.rowLines, [2, 3]);
});

test("an empty file is not an error", () => {
  assert.deepEqual(parseDelimited("").rows, []);
  assert.deepEqual(parseDelimited("").headers, []);
});

test("a header-only file yields zero rows", () => {
  const parsed = parseDelimited("student_id,name\n");
  assert.deepEqual(parsed.headers, ["student_id", "name"]);
  assert.deepEqual(parsed.rows, []);
});

// ---------------------------------------------------------------------------
// Quoting — the reason this is not text.split(",")
// ---------------------------------------------------------------------------

test("a comma inside a quoted field does not shift every later column", () => {
  const parsed = parseDelimited('student_id,name,status\nADM-001,"Sharma, Ananya",ACTIVE\n');
  assert.deepEqual(parsed.rows[0], {
    student_id: "ADM-001",
    name: "Sharma, Ananya",
    status: "ACTIVE",
  });
});

test("a doubled quote is a literal quote", () => {
  const parsed = parseDelimited('name\n"She said ""hello"""\n');
  assert.equal(parsed.rows[0].name, 'She said "hello"');
});

test("a newline inside a quoted field stays inside the field", () => {
  const parsed = parseDelimited('id,address\n1,"12 Main St\nMumbai"\n2,"Pune"\n');
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].address, "12 Main St\nMumbai");
  assert.equal(parsed.rows[1].address, "Pune");
});

test("line numbers stay correct after a quoted newline", () => {
  const parsed = parseDelimited('id,address\n1,"a\nb"\n2,c\n');
  assert.deepEqual(parsed.rowLines, [2, 4]);
});

test("an empty quoted field is an empty value", () => {
  const parsed = parseDelimited('id,email\n1,""\n');
  assert.equal(parsed.rows[0].email, "");
});

// ---------------------------------------------------------------------------
// The damage real exports carry
// ---------------------------------------------------------------------------

test("an Excel BOM does not become part of the first header name", () => {
  // Left in place, `student_id` never matches a mapping and every import of an
  // Excel-authored file fails on its first column only.
  const parsed = parseDelimited("﻿student_id,name\nADM-001,Ananya\n");
  assert.deepEqual(parsed.headers, ["student_id", "name"]);
  assert.equal(parsed.rows[0].student_id, "ADM-001");
});

test("CRLF, LF and lone CR all terminate a row", () => {
  for (const eol of ["\r\n", "\n", "\r"]) {
    const parsed = parseDelimited(`id,name${eol}1,Ananya${eol}2,Rohan${eol}`);
    assert.equal(parsed.rows.length, 2, `${JSON.stringify(eol)} should split rows`);
    assert.equal(parsed.rows[1].name, "Rohan");
  }
});

test("blank lines are dropped rather than imported as empty records", () => {
  const parsed = parseDelimited("id,name\n1,Ananya\n\n\n2,Rohan\n\n");
  assert.equal(parsed.rows.length, 2);
});

test("a file with no trailing newline keeps its last row", () => {
  const parsed = parseDelimited("id,name\n1,Ananya");
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].name, "Ananya");
});

test("headers are trimmed and values are trimmed", () => {
  const parsed = parseDelimited("  id  , name \n 1 , Ananya \n");
  assert.deepEqual(parsed.headers, ["id", "name"]);
  assert.deepEqual(parsed.rows[0], { id: "1", name: "Ananya" });
});

test("a ragged row is padded so the validator can report on real content", () => {
  // "no student code in row 41" is actionable; "row 41 has 2 cells, expected 3"
  // is not.
  const parsed = parseDelimited("id,name,email\n1,Ananya\n");
  assert.deepEqual(parsed.rows[0], { id: "1", name: "Ananya", email: "" });
});

test("a row with extra cells keeps its mapped columns", () => {
  const parsed = parseDelimited("id,name\n1,Ananya,stray\n");
  assert.deepEqual(parsed.rows[0], { id: "1", name: "Ananya" });
});

test("an unnamed column is skipped rather than keyed by empty string", () => {
  const parsed = parseDelimited("id,,name\n1,x,Ananya\n");
  assert.deepEqual(parsed.rows[0], { id: "1", name: "Ananya" });
});

// ---------------------------------------------------------------------------
// Delimiters
// ---------------------------------------------------------------------------

test("a semicolon export from a European Excel is read correctly", () => {
  const parsed = parseDelimited("id;name\n1;Ananya\n");
  assert.equal(parsed.delimiter, ";");
  assert.deepEqual(parsed.rows[0], { id: "1", name: "Ananya" });
});

test("tab and pipe separated files are read too", () => {
  assert.equal(parseDelimited("id\tname\n1\tAnanya\n").rows[0].name, "Ananya");
  assert.equal(parseDelimited("id|name\n1|Ananya\n").rows[0].name, "Ananya");
});

test("sniffing counts delimiters outside quotes only", () => {
  // A single header of `"Name, Surname"` would otherwise vote for a comma.
  assert.equal(sniffDelimiter('"Name, Surname";id;class'), ";");
});

test("an explicit delimiter overrides the sniffer", () => {
  const parsed = parseDelimited("a;b,c\n1;2,3\n", ";");
  assert.deepEqual(parsed.headers, ["a", "b,c"]);
});

test("a single-column file defaults to comma and still parses", () => {
  const parsed = parseDelimited("student_id\nADM-001\n");
  assert.deepEqual(parsed.rows, [{ student_id: "ADM-001" }]);
});

// ---------------------------------------------------------------------------
// Round-trip through this repo's own CSV writer
// ---------------------------------------------------------------------------

test("a file written by the platform's own CSV export reads back unchanged", () => {
  // The reporting export writes a BOM, CRLF line endings and RFC 4180 quoting.
  // Reading back a file this repo produced is a stronger check than a
  // hand-written fixture, which could be wrong in the same direction.
  const rows = [
    { code: "ADM-001", name: "Sharma, Ananya", note: 'said "hi"' },
    { code: "ADM-002", name: "Rohan", note: "line1\nline2" },
  ];
  const file = csvFile(
    "students",
    [
      { header: "student_id", value: (r: (typeof rows)[number]) => r.code },
      { header: "student_name", value: (r: (typeof rows)[number]) => r.name },
      { header: "note", value: (r: (typeof rows)[number]) => r.note },
    ],
    rows,
  );

  const parsed = parseDelimited(file.body.toString("utf8"));
  assert.deepEqual(parsed.headers, ["student_id", "student_name", "note"]);
  assert.deepEqual(parsed.rows, [
    { student_id: "ADM-001", student_name: "Sharma, Ananya", note: 'said "hi"' },
    { student_id: "ADM-002", student_name: "Rohan", note: "line1\nline2" },
  ]);
});

// ---------------------------------------------------------------------------
// Hostile input
// ---------------------------------------------------------------------------

test("an unterminated quote does not hang or lose the file", () => {
  const parsed = parseDelimited('id,name\n1,"Ananya\n');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].name, "Ananya");
});

test("a large file parses in one pass", () => {
  const lines = ["student_id,name", ...Array.from({ length: 5000 }, (_, i) => `ADM-${i},Student ${i}`)];
  const parsed = parseDelimited(lines.join("\n"));
  assert.equal(parsed.rows.length, 5000);
  assert.equal(parsed.rows[4999].student_id, "ADM-4999");
});

test("unicode names survive", () => {
  const parsed = parseDelimited("id,name\n1,अनन्या शर्मा\n2,李雷\n");
  assert.equal(parsed.rows[0].name, "अनन्या शर्मा");
  assert.equal(parsed.rows[1].name, "李雷");
});
