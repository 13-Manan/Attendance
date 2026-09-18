/**
 * Reading delimited text.
 *
 * ## Why not `text.split("\n").map(line => line.split(","))`
 *
 * Because a student's name can contain a comma, an address can contain a
 * newline, and a school's export will contain both within the first hundred
 * rows. The naive split does not fail loudly on those — it silently shifts
 * every column after the quote, so a phone number lands in the status field
 * and the import "succeeds". RFC 4180 quoting is the whole job here.
 *
 * ## Why no library
 *
 * Same standard this repo already applied to writing spreadsheets
 * (`attendance-reporting/export.ts`): the parser is ~70 lines of state
 * machine, has no dependencies, and is unit-tested against the exact damage
 * real exports carry — BOMs, CRLF, quoted newlines, ragged rows.
 *
 * Pure module. See csv.test.ts.
 */

export interface ParsedDelimited {
  /** Column headers, trimmed, in file order. */
  headers: string[];
  /** One object per data row, keyed by header. */
  rows: Array<Record<string, string>>;
  /** 1-based file line each row started on, for the error report. */
  rowLines: number[];
  delimiter: string;
}

/** Delimiters tried when the caller does not specify one, in order. */
const CANDIDATE_DELIMITERS = [",", ";", "\t", "|"] as const;

/**
 * Picks the delimiter by counting occurrences outside quotes on the header
 * line.
 *
 * Sniffing is worth the small risk here: European locales export
 * semicolon-separated CSV from Excel by default, and an administrator who
 * uploads one and is told "0 columns found" has no way to know why. Counting
 * outside quotes matters — a single header like `"Name, Surname"` would
 * otherwise vote for a comma.
 */
export function sniffDelimiter(firstLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const candidate of CANDIDATE_DELIMITERS) {
    let count = 0;
    let inQuotes = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      const char = firstLine[i];
      if (char === '"') inQuotes = !inQuotes;
      else if (char === candidate && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Tokenises the whole document into rows of raw cells.
 *
 * A single pass over the string rather than a line split, because a quoted
 * field may contain the line terminator and there is no way to split first
 * and be correct afterwards.
 */
function tokenize(text: string, delimiter: string): { cells: string[][]; lines: number[] } {
  const cells: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowStartLine = 1;
  let rowHasContent = false;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    // A trailing newline at end of file produces one empty row; so does a
    // blank line in the middle. Neither is a record, and importing them as
    // rows of empty strings would produce spurious "missing student code"
    // errors that an administrator cannot act on.
    if (rowHasContent) {
      cells.push(row);
      lines.push(rowStartLine);
    }
    row = [];
    rowHasContent = false;
    rowStartLine = line;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        // `""` inside a quoted field is a literal quote (RFC 4180 §2.7).
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === "\n") line += 1;
        field += char;
      }
      rowHasContent = true;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      rowHasContent = true;
    } else if (char === delimiter) {
      endField();
      rowHasContent = true;
    } else if (char === "\r") {
      // Consume CRLF as one terminator; a lone CR is treated as one too,
      // which is what an ancient Mac export produces.
      if (text[i + 1] === "\n") i += 1;
      line += 1;
      endRow();
      rowStartLine = line;
    } else if (char === "\n") {
      line += 1;
      endRow();
      rowStartLine = line;
    } else {
      field += char;
      if (char.trim() !== "") rowHasContent = true;
    }
  }
  endRow();

  return { cells, lines };
}

const BOM = "﻿";

export function parseDelimited(text: string, delimiter?: string): ParsedDelimited {
  // Excel writes a BOM (and so does this repo's own CSV export). Left in
  // place it becomes part of the first header name, so `student_id` never
  // matches a mapping and every import of an Excel-authored file fails on
  // its first column only — a confusing bug to be handed.
  const clean = text.startsWith(BOM) ? text.slice(BOM.length) : text;
  const firstLineEnd = clean.search(/\r?\n/);
  const firstLine = firstLineEnd === -1 ? clean : clean.slice(0, firstLineEnd);
  const resolved = delimiter && delimiter.length === 1 ? delimiter : sniffDelimiter(firstLine);

  const { cells, lines } = tokenize(clean, resolved);
  if (cells.length === 0) {
    return { headers: [], rows: [], rowLines: [], delimiter: resolved };
  }

  const headers = cells[0].map((header) => header.trim());
  return {
    headers,
    rows: cells.slice(1).map((cellRow) => toRecord(headers, cellRow)),
    rowLines: lines.slice(1),
    delimiter: resolved,
  };
}

/**
 * A ragged row is padded or truncated rather than rejected.
 *
 * A row with fewer cells than headers is overwhelmingly a trailing empty
 * column that some tool dropped; a row with more is a stray delimiter. Either
 * way, the row's *identifying* fields are almost always intact, so the
 * validator downstream gets to make the call on real content — and its error
 * message ("no student code in row 41") is one an administrator can act on,
 * where "row 41 has 7 cells, expected 8" is not.
 *
 * Duplicate headers: last one wins, which matches how a spreadsheet treats
 * them, and the duplicate is visible in the preview.
 */
function toRecord(headers: string[], cells: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (let i = 0; i < headers.length; i += 1) {
    if (headers[i] === "") continue;
    record[headers[i]] = (cells[i] ?? "").trim();
  }
  return record;
}
