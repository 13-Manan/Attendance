import { inflateRawSync } from "node:zlib";
import type { ParsedDelimited } from "./csv";

/**
 * Reading `.xlsx`.
 *
 * ## Why this exists
 *
 * Administrators export from Excel, and Excel's default is `.xlsx`. Telling a
 * school office "save as CSV first" is a step that gets forgotten, gets done
 * wrong (Excel's CSV export mangles non-ASCII names without a BOM), and makes
 * the platform feel like it was built for someone else. The brief asks for
 * both formats and both are here.
 *
 * ## Why no library
 *
 * `attendance-reporting/export.ts` already *writes* xlsx in ~120 lines with
 * nothing but `node:zlib`, on the stated principle that a few megabytes of
 * spreadsheet library is not worth a supply-chain dependency for a small,
 * well-specified file format. Reading back is the mirror of that, and the
 * tests for it round-trip through that writer — the reader's correctness is
 * checked against a file this repo produced, not against a hand-written
 * fixture that might be wrong in the same direction.
 *
 * ## What is deliberately not supported
 *
 * Formulas are read as their **cached value**, not evaluated — evaluating
 * spreadsheet formulas is an interpreter, and an interpreter over an
 * uploaded file is an attack surface. Styles, dates-as-numbers, merged cells,
 * and multiple sheets past the first are ignored: an import file is a table,
 * and anything relying on presentation is not one. A date that arrives as a
 * serial number is handled by `date_iso`-style transforms failing loudly on
 * it, which is better than silently importing `45678` as a date.
 *
 * Pure module. See xlsx.test.ts.
 */

// ---------------------------------------------------------------------------
// Minimal zip reader
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** A zip comment can be 64KB; the EOCD is at most that far from the end. */
const MAX_EOCD_SEARCH = 0xffff + 22;

function findEocd(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - MAX_EOCD_SEARCH);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return -1;
}

/**
 * Reads every entry in a zip archive.
 *
 * Only the two compression methods that matter are supported: 0 (stored) and
 * 8 (deflate). Every xlsx writer in existence uses one of them; anything else
 * is rejected by name rather than mis-decoded into garbage that then fails as
 * an XML parse error twenty lines later.
 */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buffer);
  if (eocd === -1) throw new Error("Not a valid .xlsx file (no zip end-of-directory record).");

  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error("Not a valid .xlsx file (corrupt central directory).");
    }
    const compressionMethod = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    // The local header repeats the name and extra fields, and its extra
    // field length frequently differs from the central one — reading the
    // central directory's value here is the classic off-by-a-few bug.
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) entries.set(name, Buffer.from(raw));
    else if (compressionMethod === 8) entries.set(name, inflateRawSync(raw));
    else throw new Error(`Unsupported compression in .xlsx entry \`${name}\`.`);

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Minimal XML helpers
// ---------------------------------------------------------------------------

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    // `&amp;` last, so `&amp;lt;` decodes to the literal text `&lt;` rather
    // than to `<`. Decoding it first is the standard double-decoding bug.
    .replace(/&amp;/g, "&");
}

/** Concatenates every `<t>` in a fragment — a rich-text run is many of them. */
function textOf(fragment: string): string {
  let out = "";
  const pattern = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fragment)) !== null) {
    out += decodeXmlEntities(match[1] ?? "");
  }
  return out;
}

function parseSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const strings: string[] = [];
  const pattern = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) {
    strings.push(textOf(match[1] ?? ""));
  }
  return strings;
}

/** `"BC7"` → 54. Inverse of `columnName` in attendance-reporting/export.ts. */
export function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference.toUpperCase());
  if (!letters) return 0;
  let index = 0;
  for (const char of letters[1]) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

function parseSheet(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowPattern.exec(xml)) !== null) {
    const cells: string[] = [];
    const cellPattern = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cellMatch: RegExpExecArray | null;
    let autoIndex = 0;

    while ((cellMatch = cellPattern.exec(rowMatch[1] ?? "")) !== null) {
      const attrs = cellMatch[1] ?? "";
      const body = cellMatch[2] ?? "";
      const reference = attribute(attrs, "r");
      // An empty cell is omitted from the XML entirely, so position must come
      // from the `r` reference. Falling back to a running counter keeps a
      // (non-standard) writer that omits `r` from shifting every column.
      const index = reference ? columnIndex(reference) : autoIndex;
      autoIndex = index + 1;

      const type = attribute(attrs, "t");
      let value: string;
      if (type === "s") {
        const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "";
        value = shared[Number(raw)] ?? "";
      } else if (type === "inlineStr") {
        value = textOf(body);
      } else if (type === "b") {
        value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] === "1" ? "TRUE" : "FALSE";
      } else {
        // Covers numbers, dates-as-serials, and `t="str"` formula results.
        // For a formula cell this is the *cached* value Excel last computed,
        // which is what we want — see the note about not evaluating formulas.
        value = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? "");
      }

      while (cells.length < index) cells.push("");
      cells[index] = value;
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Reads the first worksheet of an `.xlsx` into the same shape `parseDelimited`
 * produces, so the import pipeline downstream cannot tell which format it was
 * handed — one preview, one validator, one error report for both.
 */
export function parseXlsx(buffer: Buffer): ParsedDelimited {
  const entries = readZip(buffer);
  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8"));

  // The first sheet by path, because resolving the workbook's sheet order
  // means parsing workbook.xml *and* its rels, and every file this importer
  // will realistically see has exactly one sheet. Sorted so `sheet10` cannot
  // sort before `sheet2` and win.
  const sheetName = [...entries.keys()]
    .filter((name) => name.startsWith("xl/worksheets/") && name.endsWith(".xml"))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))[0];
  if (!sheetName) throw new Error("The .xlsx file contains no worksheet.");

  const grid = parseSheet(entries.get(sheetName)!.toString("utf8"), shared);
  if (grid.length === 0) return { headers: [], rows: [], rowLines: [], delimiter: "xlsx" };

  const headers = grid[0].map((header) => header.trim());
  const rows: Array<Record<string, string>> = [];
  const rowLines: number[] = [];

  for (let i = 1; i < grid.length; i += 1) {
    const cells = grid[i];
    // A spreadsheet that has had rows deleted keeps thousands of empty rows
    // below the data. Importing them would produce thousands of error-report
    // lines about a missing student code.
    if (cells.every((cell) => cell.trim() === "")) continue;
    const record: Record<string, string> = {};
    for (let c = 0; c < headers.length; c += 1) {
      if (headers[c] === "") continue;
      record[headers[c]] = (cells[c] ?? "").trim();
    }
    rows.push(record);
    // 1-based, matching the row number the administrator sees in Excel.
    rowLines.push(i + 1);
  }

  return { headers, rows, rowLines, delimiter: "xlsx" };
}

/** `PK\x03\x04` — every zip, and therefore every xlsx, starts with it. */
export function looksLikeXlsx(buffer: Buffer): boolean {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}
