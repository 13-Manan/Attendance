import { csvFile, type ExportColumn } from "@/modules/attendance-reporting/export";
import type { ExportFile } from "@/modules/attendance-reporting/types";
import { parseDelimited, type ParsedDelimited } from "./csv";
import { looksLikeXlsx, parseXlsx } from "./xlsx";
import {
  DEFAULT_MAPPINGS,
  applyMapping,
  targetField,
  targetFieldsFor,
  validateMapping,
  type MappingProblem,
} from "./field-mapping";
import type { FieldMapping, IntegrationResource } from "./types";

/**
 * The import pipeline: preview → validate → commit, with an error report.
 *
 * ## Nothing here writes to the database
 *
 * Every function in this file is pure. It takes rows and a snapshot of what
 * already exists, and returns a *plan*: these rows would be created, these
 * updated, these are unchanged, these are errors and here is why. The plan is
 * what the administrator approves, and only then does the service execute it
 * through the existing students/enrollment services — which keep their own
 * authorization and audit behaviour, untouched.
 *
 * That separation is what makes the preview trustworthy. A preview computed
 * by a different code path than the commit is a preview that can lie, and the
 * lie only surfaces after 3,000 records have been written.
 *
 * ## Why an unchanged row is its own category
 *
 * A school re-uploading last term's roster with four new admissions should be
 * told "4 created, 1,196 unchanged", not "1,200 updated". The second number
 * is technically defensible and practically useless: it hides the four rows
 * that matter, and it produces 1,196 `student.updated` webhooks and 1,196
 * audit rows describing changes that did not happen.
 *
 * See import-pipeline.test.ts.
 */

/** Rows shown in the preview table before anything is committed. */
export const PREVIEW_ROW_COUNT = 10;

/**
 * Hard ceiling on a single import.
 *
 * Not a performance limit — it is a blast-radius limit. An import is one
 * administrator's single click, and a file with 200,000 rows in it is far
 * more likely to be the wrong file than a genuine intent to rewrite a
 * district. Large migrations go through the API, which is paginated,
 * resumable and audited per page.
 */
export const MAX_IMPORT_ROWS = 20_000;

// ---------------------------------------------------------------------------
// Reading a file
// ---------------------------------------------------------------------------

export type ImportFormat = "csv" | "xlsx";

/**
 * Sniffs the format from the bytes, not from the filename.
 *
 * A `.csv` that is actually an xlsx (because someone renamed it) and an
 * `.xlsx` that is actually CSV (because a tool wrote it with the wrong
 * extension) both happen regularly. The zip magic number is unambiguous, so
 * there is no reason to trust a filename that a user typed.
 */
export function readImportFile(buffer: Buffer, delimiter?: string): ParsedDelimited & { format: ImportFormat } {
  if (looksLikeXlsx(buffer)) {
    return { ...parseXlsx(buffer), format: "xlsx" };
  }
  return { ...parseDelimited(buffer.toString("utf8"), delimiter), format: "csv" };
}

// ---------------------------------------------------------------------------
// Suggesting a mapping
// ---------------------------------------------------------------------------

function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Additional header spellings worth recognising, beyond the brief's defaults.
 *
 * Every entry here is a column name that appears in real Indian school and
 * college exports. This is the *one* place in the codebase where a specific
 * external system's vocabulary is allowed to appear — and it is safe here for
 * a precise reason: it only produces a *suggestion*, shown to an
 * administrator in a preview they must approve. Nothing imports because of
 * this table. A guess that is wrong costs one dropdown change; hardcoding the
 * same knowledge into the importer would cost a silent mis-import.
 */
const HEADER_ALIASES: Record<string, string> = {
  admissionno: "student.externalId",
  admissionnumber: "student.externalId",
  admno: "student.externalId",
  admnno: "student.externalId",
  enrollmentno: "student.externalId",
  enrolmentno: "student.externalId",
  rollno: "student.externalId",
  rollnumber: "student.externalId",
  registrationno: "student.externalId",
  studentcode: "student.externalId",
  uid: "student.externalId",
  name: "student.name",
  studentname: "student.name",
  fullname: "student.name",
  firstname: "student.firstName",
  givenname: "student.firstName",
  lastname: "student.lastName",
  surname: "student.lastName",
  emailid: "student.email",
  email: "student.email",
  mobile: "student.phone",
  mobileno: "student.phone",
  phone: "student.phone",
  contactno: "student.phone",
  status: "student.status",
  class: "class.externalCode",
  classcode: "class.externalCode",
  standard: "class.externalCode",
  grade: "class.externalCode",
  section: "section.externalCode",
  sectioncode: "section.externalCode",
  division: "section.externalCode",
  subject: "subject.externalCode",
  subjectcode: "subject.externalCode",
  papercode: "subject.externalCode",
  date: "attendance.date",
  attendancedate: "attendance.date",
  attendancestatus: "attendance.status",
  present: "attendance.status",
};

/**
 * Proposes a mapping for a file's headers.
 *
 * Exact-ish matching only — normalised case and punctuation, then the alias
 * table. No edit distance, no "did you mean". A fuzzy matcher that maps
 * `father_name` to `student.firstName` because they share letters produces an
 * import that looks configured and is wrong, and the administrator has no
 * reason to look closely at a field the system filled in confidently.
 */
export function suggestMappings(
  headers: readonly string[],
  resource: IntegrationResource,
): FieldMapping[] {
  const allowed = new Set(targetFieldsFor(resource).map((field) => field.key));
  // `student.name` writes firstName/lastName, which are real targets for the
  // students resource even though `name` is a composite.
  const claimed = new Set<string>();
  const mappings: FieldMapping[] = [];

  for (const header of headers) {
    const normalized = normalizeHeader(header);
    const direct = DEFAULT_MAPPINGS[header.trim().toLowerCase()];
    const target = direct ?? HEADER_ALIASES[normalized];
    if (!target || !allowed.has(target) || claimed.has(target)) continue;
    claimed.add(target);
    mappings.push({ source: header, target });
  }
  return mappings;
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

export interface ImportPreview {
  format: ImportFormat;
  headers: string[];
  totalRows: number;
  /** First rows, verbatim, so the admin can see what the parser saw. */
  sampleRows: Array<Record<string, string>>;
  mappings: FieldMapping[];
  mappingProblems: MappingProblem[];
  /** Columns present in the file that no mapping uses. Not an error. */
  unmappedColumns: string[];
  /** Populated when the file is over MAX_IMPORT_ROWS. */
  rejection?: string;
}

export function buildPreview(
  parsed: ParsedDelimited & { format: ImportFormat },
  resource: IntegrationResource,
  mappings?: FieldMapping[],
): ImportPreview {
  const resolved = mappings ?? suggestMappings(parsed.headers, resource);
  const used = new Set(resolved.map((mapping) => mapping.source.trim().toLowerCase()));

  return {
    format: parsed.format,
    headers: parsed.headers,
    totalRows: parsed.rows.length,
    sampleRows: parsed.rows.slice(0, PREVIEW_ROW_COUNT),
    mappings: resolved,
    mappingProblems: validateMapping(resolved, resource, parsed.headers),
    unmappedColumns: parsed.headers.filter((header) => header !== "" && !used.has(header.trim().toLowerCase())),
    rejection:
      parsed.rows.length > MAX_IMPORT_ROWS
        ? `This file has ${parsed.rows.length.toLocaleString()} rows; the limit for one import is ${MAX_IMPORT_ROWS.toLocaleString()}. Split it, or use the API for a bulk migration.`
        : undefined,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface ImportRowError {
  /** Line number in the uploaded file, as the administrator sees it. */
  line: number;
  /** The row's identifier, when we could read one. */
  key: string;
  messages: string[];
}

export interface PlannedRow {
  line: number;
  key: string;
  values: Record<string, string>;
}

export interface ImportSummary {
  totalRows: number;
  create: number;
  update: number;
  unchanged: number;
  duplicate: number;
  error: number;
}

export interface ImportPlan {
  create: PlannedRow[];
  update: PlannedRow[];
  unchanged: PlannedRow[];
  /** Rows dropped because an earlier row in the same file claimed the key. */
  duplicates: ImportRowError[];
  errors: ImportRowError[];
  summary: ImportSummary;
}

/** The snapshot of existing students an import is compared against. */
export interface ExistingStudent {
  id: string;
  studentCode: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  status: string;
}

const STUDENT_COMPARE: Array<[target: string, field: keyof ExistingStudent]> = [
  ["student.firstName", "firstName"],
  ["student.lastName", "lastName"],
  ["student.email", "email"],
  ["student.phone", "phone"],
  ["student.status", "status"],
];

/**
 * Turns a parsed file plus a mapping plus the current roster into a plan.
 *
 * ## Duplicate detection runs in two directions
 *
 * *Within the file*: two rows with the same student code. The first wins and
 * the rest become duplicate entries — never a silent last-write-wins, which
 * would make the import's result depend on row order in a way nobody could
 * see.
 *
 * *Against the database*: a code that already exists is an **update**, not an
 * error. That is the distinction that makes a re-upload safe and is why
 * re-running a nightly sync twice is a no-op rather than a pile of unique
 * constraint violations.
 *
 * ## Empty values never overwrite
 *
 * A row whose `email` column is blank leaves the existing email alone. An
 * export that omits a column entirely would otherwise erase that field for
 * every student in the institution — the single most destructive thing a
 * well-meaning import can do, and it looks exactly like a successful import
 * while doing it. Clearing a field is a deliberate act and is not available
 * through file import.
 */
export function planStudentImport(
  rows: ReadonlyArray<Record<string, string>>,
  rowLines: readonly number[],
  mappings: readonly FieldMapping[],
  existing: ReadonlyMap<string, ExistingStudent>,
): ImportPlan {
  const create: PlannedRow[] = [];
  const update: PlannedRow[] = [];
  const unchanged: PlannedRow[] = [];
  const duplicates: ImportRowError[] = [];
  const errors: ImportRowError[] = [];
  const seen = new Map<string, number>();

  for (let i = 0; i < rows.length; i += 1) {
    const line = rowLines[i] ?? i + 2;
    const mapped = applyMapping(rows[i], mappings);
    const messages = mapped.errors.map((problem) => problem.message);

    const code = mapped.values["student.externalId"] ?? "";
    if (code === "") {
      messages.push("No student code — this row cannot be matched to a student.");
    }
    if (!mapped.values["student.firstName"] && !existing.has(code)) {
      messages.push("A new student needs a name.");
    }

    if (messages.length > 0) {
      errors.push({ line, key: code, messages });
      continue;
    }

    const firstSeenAt = seen.get(code);
    if (firstSeenAt !== undefined) {
      duplicates.push({
        line,
        key: code,
        messages: [`Student code \`${code}\` already appeared on line ${firstSeenAt}. This row was skipped.`],
      });
      continue;
    }
    seen.set(code, line);

    const planned: PlannedRow = { line, key: code, values: mapped.values };
    const current = existing.get(code);
    if (!current) {
      create.push(planned);
      continue;
    }

    const changed = STUDENT_COMPARE.some(([target, field]) => {
      const incoming = mapped.values[target];
      if (incoming === undefined || incoming === "") return false;
      return incoming !== (current[field] ?? "");
    });
    (changed ? update : unchanged).push(planned);
  }

  return {
    create,
    update,
    unchanged,
    duplicates,
    errors,
    summary: {
      totalRows: rows.length,
      create: create.length,
      update: update.length,
      unchanged: unchanged.length,
      duplicate: duplicates.length,
      error: errors.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Error report
// ---------------------------------------------------------------------------

const ERROR_COLUMNS: Array<ExportColumn<ImportRowError>> = [
  { header: "Line", value: (row) => row.line },
  { header: "Student code", value: (row) => row.key || null },
  { header: "Problem", value: (row) => row.messages.join(" ") },
];

/**
 * The error report, as a downloadable CSV.
 *
 * A file rather than a screen because the workflow it supports is "fix these
 * and re-upload": the administrator opens it beside the source export and
 * works down the line numbers. A list of 300 problems in a web table is
 * something you scroll, not something you act on.
 *
 * Line numbers are the file's own, which is why `rowLines` is threaded all
 * the way from the parser — `Row 41` has to mean row 41 in the spreadsheet
 * they are looking at, not the 41st row that survived parsing.
 */
export function buildErrorReport(plan: ImportPlan, filename = "import-errors"): ExportFile {
  const rows = [...plan.errors, ...plan.duplicates].sort((a, b) => a.line - b.line);
  return csvFile(
    filename,
    ERROR_COLUMNS,
    rows,
    `${plan.summary.error} error(s), ${plan.summary.duplicate} duplicate(s) out of ${plan.summary.totalRows} row(s). Nothing from this file was imported for the rows listed above.`,
  );
}

/** One sentence for the UI and the audit row. */
export function describeSummary(summary: ImportSummary): string {
  const parts = [
    `${summary.create} created`,
    `${summary.update} updated`,
    `${summary.unchanged} unchanged`,
  ];
  if (summary.duplicate > 0) parts.push(`${summary.duplicate} duplicate`);
  if (summary.error > 0) parts.push(`${summary.error} with errors`);
  return `${summary.totalRows} row(s): ${parts.join(", ")}.`;
}

/** Mapped values → the shape the students service takes. */
export function toStudentInput(row: PlannedRow): {
  studentCode: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
} {
  return {
    studentCode: row.values["student.externalId"],
    firstName: row.values["student.firstName"] ?? "",
    lastName: row.values["student.lastName"] ?? "",
    email: row.values["student.email"],
    phone: row.values["student.phone"],
  };
}

/** Exposed so the admin UI can label the mapping dropdown's options. */
export function targetLabel(key: string): string {
  return targetField(key)?.label ?? key;
}
