import { deflateRawSync } from "node:zlib";
import type { ExportFile, ExportFormat } from "./types";

/**
 * Report export: CSV, Excel, and a print/PDF path.
 *
 * ## Why there is no library here
 *
 * Writing `.xlsx` is writing a small zip of five XML parts. A spreadsheet
 * library would add a few megabytes and a supply-chain dependency to the
 * server bundle to do exactly that, and this codebase already treats new
 * runtime dependencies as something to justify rather than assume (see the
 * Phase 5 licensing audit). The writer below is ~120 lines, has no
 * dependencies beyond Node's own `zlib`, and is unit-tested by reading its
 * own output back.
 *
 * ## PDF
 *
 * There is deliberately no PDF renderer. Producing one server-side means
 * shipping a headless browser or a layout engine, and the thing an
 * administrator actually wants — "a copy of this, on paper or as a file I can
 * email" — is what the browser's own print-to-PDF already does, with the
 * institution's fonts and the reader's page size. The architecture that keeps
 * that available is the print route: a server-rendered, filter-identical view
 * carrying print styles and no interactive chrome. If a scheduled,
 * server-generated PDF is ever needed (emailing monthly reports, say), it
 * renders that same route — the report does not need rebuilding for it.
 */

export interface ExportColumn<T> {
  header: string;
  /** Returned strings are written as text; numbers as numbers; null as blank. */
  value: (row: T) => string | number | null;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * RFC 4180 quoting. A field is quoted when it contains a comma, a quote, or a
 * newline; embedded quotes are doubled.
 *
 * Note what is *not* done: no formula-prefix stripping, because nothing in an
 * attendance report is user-authored free text that reaches a cell — names and
 * codes come from the institution's own records. If a free-text column (a
 * correction reason, say) is ever exported, it needs a leading `'` guard
 * against `=`, `+`, `-` and `@` before it goes in a cell.
 */
export function csvField(value: string | number | null): string {
  if (value === null) return "";
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv<T>(columns: Array<ExportColumn<T>>, rows: T[], notice?: string): string {
  const lines = [columns.map((c) => csvField(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(c.value(row))).join(","));
  }
  if (notice) lines.push(csvField(notice));
  // CRLF per RFC 4180; Excel on Windows is the dominant consumer.
  return lines.join("\r\n");
}

/**
 * A BOM, because Excel decodes a BOM-less CSV using the machine's legacy
 * codepage and turns every non-ASCII name into mojibake. It costs three
 * bytes and every other consumer tolerates it.
 */
const UTF8_BOM = "﻿";

export function csvFile<T>(
  filename: string,
  columns: Array<ExportColumn<T>>,
  rows: T[],
  notice?: string,
): ExportFile {
  return {
    filename: `${filename}.csv`,
    contentType: "text/csv; charset=utf-8",
    body: Buffer.from(UTF8_BOM + toCsv(columns, rows, notice), "utf8"),
  };
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 0 -> A, 25 -> Z, 26 -> AA. Spreadsheet column names are bijective base-26. */
export function columnName(index: number): string {
  let name = "";
  let n = index;
  for (;;) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
    if (n < 0) break;
  }
  return name;
}

function cell(ref: string, value: string | number | null): string {
  if (value === null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }
  // Inline strings rather than a shared-strings part: one less file to keep
  // consistent, and a report has few repeated values to dedupe anyway.
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value))}</t></is></c>`;
}

function sheetXml<T>(columns: Array<ExportColumn<T>>, rows: T[], notice?: string): string {
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    "<sheetData>",
    `<row r="1">${columns.map((c, i) => cell(`${columnName(i)}1`, c.header)).join("")}</row>`,
  ];
  rows.forEach((row, r) => {
    const ref = r + 2;
    parts.push(
      `<row r="${ref}">${columns.map((c, i) => cell(`${columnName(i)}${ref}`, c.value(row))).join("")}</row>`,
    );
  });
  if (notice) {
    const ref = rows.length + 2;
    parts.push(`<row r="${ref}">${cell(`A${ref}`, notice)}</row>`);
  }
  parts.push("</sheetData></worksheet>");
  return parts.join("");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;

function workbookXml(sheetName: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;
}

/**
 * Sheet names are limited by the format: 31 characters, and none of
 * `[ ] : * ? / \`. Excel refuses to open a workbook that breaks either rule,
 * so a report title containing a slash must be sanitized rather than trusted.
 */
export function safeSheetName(name: string): string {
  const cleaned = name.replace(/[[\]:*?/\\]/g, " ").trim();
  return (cleaned || "Report").slice(0, 31);
}

// --- zip ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * A minimal zip writer: deflate every entry, then a central directory.
 *
 * No zip64, and no need for it — `MAX_EXPORT_ROWS` caps a workbook far below
 * the 4 GiB / 65,535-entry point where zip64 becomes required.
 */
export function zip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // deflate
    // A fixed timestamp keeps the bytes reproducible: the same report
    // exported twice should be byte-identical, which makes the output
    // diffable and the unit tests deterministic.
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x0021, 12); // date: 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

export function xlsxFile<T>(
  filename: string,
  sheetName: string,
  columns: Array<ExportColumn<T>>,
  rows: T[],
  notice?: string,
): ExportFile {
  const body = zip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(ROOT_RELS, "utf8") },
    { name: "xl/workbook.xml", data: Buffer.from(workbookXml(safeSheetName(sheetName)), "utf8") },
    { name: "xl/_rels/workbook.xml.rels", data: Buffer.from(WORKBOOK_RELS, "utf8") },
    { name: "xl/worksheets/sheet1.xml", data: Buffer.from(sheetXml(columns, rows, notice), "utf8") },
  ]);
  return {
    filename: `${filename}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body,
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function isExportFormat(value: string): value is ExportFormat {
  return value === "csv" || value === "xlsx";
}

/**
 * Filenames end up in a Content-Disposition header and then on a filesystem.
 * Anything outside a conservative set is replaced rather than escaped, so the
 * header cannot be split and the file cannot escape its directory.
 */
export function safeFilename(name: string): string {
  return (name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "report").slice(0, 120);
}

/**
 * `notice` is written as a final single-cell row. It exists for one message —
 * that the export hit `MAX_EXPORT_ROWS` and is not the whole result — and it
 * goes *in the file* rather than only in a response header, because the file
 * is what gets emailed around and quoted in a meeting. A reader who never sees
 * the HTTP response still sees the caveat.
 */
export function buildExport<T>(
  format: ExportFormat,
  filename: string,
  sheetName: string,
  columns: Array<ExportColumn<T>>,
  rows: T[],
  notice?: string,
): ExportFile {
  const safe = safeFilename(filename);
  return format === "xlsx"
    ? xlsxFile(safe, sheetName, columns, rows, notice)
    : csvFile(safe, columns, rows, notice);
}
