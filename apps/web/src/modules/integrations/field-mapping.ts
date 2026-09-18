import type { FieldMapping, FieldTransform, IntegrationResource } from "./types";

/**
 * Field mapping: the external system's vocabulary → ours.
 *
 * ## Why this layer exists at all
 *
 * No two student information systems agree on what a student's identifier is
 * called. One exports `student_id`, one `admn_no`, one `ENROLLMENT_NUMBER`,
 * and one puts the roll number in a column named `code` while using
 * `student_id` for its own primary key. Hardcoding any of those into the
 * importer is how a platform ends up with an `if (school === "…")` in its
 * core. The mapping is data, configured per connection, and the core only
 * ever sees canonical field keys.
 *
 * ## The canonical keys, and what they actually are in this schema
 *
 * The product brief names the targets `student.externalId`,
 * `class.externalCode`, `section.externalCode`, `subject.externalCode`. Those
 * are the keys used here, verbatim, because they are the integration-facing
 * names an administrator sees in the mapping UI.
 *
 * They are **not** new columns, and this phase adds none. Each maps onto a
 * natural key the schema already has and already constrains:
 *
 * | Canonical key           | Stored in                | Constraint                        |
 * |-------------------------|--------------------------|-----------------------------------|
 * | `student.externalId`    | `Student.studentCode`    | `@@unique([institutionId, code])` |
 * | `subject.externalCode`  | `Subject.code`           | `@@unique([institutionId, code])` |
 * | `section.externalCode`  | `AcademicUnit.code`      | (kind = SECTION)                  |
 * | `class.externalCode`    | see `CLASS_CODE_RESOLUTION` |                                |
 *
 * That is not a workaround for the frozen schema; it is the correct answer
 * even with an unfrozen one. `Student.studentCode` already *is* the
 * institution's own identifier for a student — adding a parallel `externalId`
 * beside it would create two columns that mean the same thing and disagree
 * within a month.
 *
 * ## The one genuinely awkward case
 *
 * `Cohort` — a class — has neither a `code` column nor a `metadata` column,
 * so there is nowhere to put a class code that the database can constrain.
 * `CLASS_CODE_RESOLUTION` below states exactly what is done instead, and it
 * is the single place to change if a `Cohort.code` column is ever added.
 *
 * Pure module: no Prisma, no I/O. See field-mapping.test.ts.
 */

// ---------------------------------------------------------------------------
// The canonical target catalog
// ---------------------------------------------------------------------------

export interface TargetField {
  /** What an admin picks in the mapping UI, and what adapters emit. */
  key: string;
  /** Right-hand column heading in the mapping table. */
  label: string;
  /** Which import this field belongs to. */
  resource: IntegrationResource;
  /**
   * The actual Prisma model + field. Shown in the UI as a subtitle so an
   * administrator is never guessing where their data landed, and so nobody
   * reading this file has to grep the schema to find out.
   */
  storedAs: string;
  /** A mapping for this resource is rejected without every required key. */
  required?: boolean;
  /** Accepted values, when the field is an enum. */
  enumValues?: readonly string[];
}

/**
 * How `class.externalCode` is resolved, since `Cohort` has no code column.
 *
 * Resolution order, first match wins:
 *   1. `AcademicUnit.code` of the cohort's academic unit, when that unit's
 *      kind is GRADE, COURSE or SEMESTER — i.e. the thing a school calls
 *      "Class 10" and a college calls "BCA Sem 3". This is the right column:
 *      it is what the code describes, and it is already populated by the
 *      academic-structure UI.
 *   2. `Cohort.name`, matched case-insensitively after trimming.
 *
 * Step 2 is a fallback and is not unique — two cohorts in different academic
 * sessions can share a name. The importer treats an ambiguous class code as
 * an *error row* rather than picking one, which is why this is safe to offer:
 * the failure mode is a line in the error report, not attendance filed
 * against the wrong class.
 */
export const CLASS_CODE_RESOLUTION = [
  "AcademicUnit.code (kind: GRADE | COURSE | SEMESTER)",
  "Cohort.name (case-insensitive, ambiguity is an error)",
] as const;

export const TARGET_FIELDS: readonly TargetField[] = [
  {
    key: "student.externalId",
    label: "Student code",
    resource: "students",
    storedAs: "Student.studentCode",
    required: true,
  },
  { key: "student.name", label: "Full name", resource: "students", storedAs: "Student.firstName + lastName" },
  { key: "student.firstName", label: "First name", resource: "students", storedAs: "Student.firstName" },
  { key: "student.lastName", label: "Last name", resource: "students", storedAs: "Student.lastName" },
  { key: "student.email", label: "Email", resource: "students", storedAs: "Student.email" },
  { key: "student.phone", label: "Phone", resource: "students", storedAs: "Student.phone" },
  {
    key: "student.status",
    label: "Status",
    resource: "students",
    storedAs: "Student.status",
    // Exactly `EnrollmentStatus` in schema.prisma. Kept in sync by hand
    // because importing the Prisma enum here would drag the client into a
    // module the admin UI renders from.
    enumValues: ["ACTIVE", "INACTIVE", "TRANSFERRED", "COMPLETED"],
  },
  {
    key: "class.externalCode",
    label: "Class code",
    resource: "classes",
    storedAs: "AcademicUnit.code → Cohort.name",
  },
  { key: "section.externalCode", label: "Section code", resource: "sections", storedAs: "AcademicUnit.code" },
  { key: "subject.externalCode", label: "Subject code", resource: "subjects", storedAs: "Subject.code" },
  { key: "subject.name", label: "Subject name", resource: "subjects", storedAs: "Subject.name" },
  { key: "faculty.email", label: "Faculty email", resource: "faculty", storedAs: "User.email" },
  {
    key: "enrollment.studentExternalId",
    label: "Student code",
    resource: "enrollments",
    storedAs: "Student.studentCode",
    required: true,
  },
  {
    key: "enrollment.classExternalCode",
    label: "Class code",
    resource: "enrollments",
    storedAs: "AcademicUnit.code → Cohort.name",
    required: true,
  },
  {
    key: "attendance.studentExternalId",
    label: "Student code",
    resource: "attendance",
    storedAs: "Student.studentCode",
    required: true,
  },
  { key: "attendance.date", label: "Date", resource: "attendance", storedAs: "AttendanceSession.sessionDate", required: true },
  {
    key: "attendance.status",
    label: "Status",
    resource: "attendance",
    storedAs: "AttendanceRecord.finalResult",
    required: true,
    enumValues: ["PRESENT", "ABSENT"],
  },
];

const TARGETS_BY_KEY = new Map(TARGET_FIELDS.map((field) => [field.key, field]));

export function targetField(key: string): TargetField | null {
  return TARGETS_BY_KEY.get(key) ?? null;
}

export function targetFieldsFor(resource: IntegrationResource): TargetField[] {
  return TARGET_FIELDS.filter((field) => field.resource === resource);
}

/**
 * The mapping an admin gets before they change anything.
 *
 * Seeded from the brief's own example table, which is not arbitrary — those
 * are the conventional snake_case column names in the majority of Indian SIS
 * and ERP exports. An institution whose export matches gets a working
 * integration without touching the mapping screen; one whose export does not
 * sees an obviously-wrong default rather than an empty table that gives no
 * hint of what the screen is for.
 */
export const DEFAULT_MAPPINGS: Readonly<Record<string, string>> = {
  student_id: "student.externalId",
  student_name: "student.name",
  student_email: "student.email",
  class_code: "class.externalCode",
  section_code: "section.externalCode",
  subject_code: "subject.externalCode",
};

export function defaultMappingsFor(resource: IntegrationResource): FieldMapping[] {
  return Object.entries(DEFAULT_MAPPINGS)
    .filter(([, target]) => targetField(target)?.resource === resource)
    .map(([source, target]) => ({ source, target }));
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

/**
 * `dd/mm/yyyy` and `mm/dd/yyyy` are indistinguishable for the first twelve
 * days of a month, which is why the transform is chosen by the administrator
 * rather than sniffed from the data. A sniffer would be right on the 13th and
 * catastrophically wrong on the 5th, filing a term's attendance against the
 * wrong dates in a way nobody notices until a report is printed.
 */
function toIsoDate(value: string, order: "dmy" | "mdy"): string | null {
  const parts = value.trim().split(/[/\-.]/);
  if (parts.length !== 3) return null;
  const [a, b, rawYear] = parts;
  const day = order === "dmy" ? a : b;
  const month = order === "dmy" ? b : a;
  const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  if (!/^\d{4}$/.test(year) || !/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day)) return null;

  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  // Round-trip through Date to reject 31/02 and 13/13, which the regex above
  // happily accepts. An impossible date must become an error row, never a
  // silently rolled-over one — JavaScript's Date would turn 31 February into
  // 3 March without complaint.
  const parsed = new Date(`${iso}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso ? null : iso;
}

export function applyTransform(value: string, transform: FieldTransform | undefined): string | null {
  if (!transform) return value;
  switch (transform) {
    case "trim":
      return value.trim();
    case "uppercase":
      return value.trim().toUpperCase();
    case "lowercase":
      return value.trim().toLowerCase();
    case "digits_only":
      return value.replace(/\D/g, "");
    case "date_dmy":
      return toIsoDate(value, "dmy");
    case "date_mdy":
      return toIsoDate(value, "mdy");
    case "date_iso": {
      const trimmed = value.trim();
      return /^\d{4}-\d{2}-\d{2}/.test(trimmed) ? trimmed.slice(0, 10) : null;
    }
    default: {
      // Exhaustiveness: a new FieldTransform that forgets a case fails to
      // compile rather than silently passing values through untransformed.
      const never: never = transform;
      return never;
    }
  }
}

// ---------------------------------------------------------------------------
// Validating a mapping
// ---------------------------------------------------------------------------

export interface MappingProblem {
  source: string;
  target: string;
  message: string;
}

/**
 * Checks a mapping before it is saved, against the resource it claims to map
 * and (optionally) the column headers of a real file.
 *
 * Validating at *save* time rather than at import time is the point. An
 * administrator configuring a nightly sync at 4pm should find out then that
 * they typed `studnet_id`, not at 2am when the sync produces an empty import
 * and an email nobody reads.
 */
export function validateMapping(
  mappings: readonly FieldMapping[],
  resource: IntegrationResource,
  availableColumns?: readonly string[],
): MappingProblem[] {
  const problems: MappingProblem[] = [];
  const seenTargets = new Set<string>();
  const seenSources = new Set<string>();
  const columns = availableColumns ? new Set(availableColumns.map((c) => c.trim().toLowerCase())) : null;

  for (const mapping of mappings) {
    const source = mapping.source.trim();
    if (!source) {
      problems.push({ source: mapping.source, target: mapping.target, message: "External field name is empty." });
      continue;
    }

    const target = targetField(mapping.target);
    if (!target) {
      problems.push({ source, target: mapping.target, message: `Unknown field \`${mapping.target}\`.` });
      continue;
    }
    if (target.resource !== resource) {
      problems.push({
        source,
        target: mapping.target,
        message: `\`${mapping.target}\` belongs to ${target.resource}, not ${resource}.`,
      });
    }
    // Two external columns writing one of our fields is not a merge — it is
    // whichever one the loop reaches last, which is a coin flip dressed up as
    // configuration.
    if (seenTargets.has(mapping.target)) {
      problems.push({ source, target: mapping.target, message: `\`${mapping.target}\` is mapped more than once.` });
    }
    if (seenSources.has(source.toLowerCase())) {
      problems.push({ source, target: mapping.target, message: `\`${source}\` is used more than once.` });
    }
    if (columns && !columns.has(source.toLowerCase())) {
      problems.push({ source, target: mapping.target, message: `The file has no column named \`${source}\`.` });
    }
    seenTargets.add(mapping.target);
    seenSources.add(source.toLowerCase());
  }

  for (const field of targetFieldsFor(resource)) {
    if (field.required && !seenTargets.has(field.key)) {
      problems.push({ source: "", target: field.key, message: `\`${field.key}\` (${field.label}) is required.` });
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Applying a mapping
// ---------------------------------------------------------------------------

export interface MappedRow {
  /** Canonical key → value. Only keys the mapping produced a value for. */
  values: Record<string, string>;
  /** Per-field failures: a transform that could not parse its input. */
  errors: MappingProblem[];
}

/**
 * Applies a mapping to one row of external data.
 *
 * Header lookup is case-insensitive and whitespace-tolerant because a
 * spreadsheet that has been through Excel, a mail client and a re-save has a
 * trailing space in a header roughly half the time, and refusing the whole
 * file over it helps nobody.
 *
 * `student.name` is split here rather than at the database: a single-token
 * name becomes the first name with an empty surname, which is correct for the
 * many people who have one — the alternative, refusing the row, would be this
 * system telling a real student their name is invalid.
 */
export function applyMapping(row: Record<string, string>, mappings: readonly FieldMapping[]): MappedRow {
  const lookup = new Map(Object.entries(row).map(([key, value]) => [key.trim().toLowerCase(), value]));
  const values: Record<string, string> = {};
  const errors: MappingProblem[] = [];

  for (const mapping of mappings) {
    const raw = lookup.get(mapping.source.trim().toLowerCase());
    const source = raw === undefined || raw.trim() === "" ? mapping.fallback : raw;
    if (source === undefined) continue;

    const transformed = applyTransform(source, mapping.transform);
    if (transformed === null) {
      errors.push({
        source: mapping.source,
        target: mapping.target,
        message: `\`${source}\` is not a valid value for ${mapping.transform ?? "this field"}.`,
      });
      continue;
    }
    const value = transformed.trim();
    if (value === "") continue;

    if (mapping.target === "student.name") {
      const parts = value.split(/\s+/);
      values["student.firstName"] = parts[0];
      values["student.lastName"] = parts.slice(1).join(" ");
      continue;
    }

    const field = targetField(mapping.target);
    if (field?.enumValues) {
      const upper = value.toUpperCase();
      if (!field.enumValues.includes(upper)) {
        errors.push({
          source: mapping.source,
          target: mapping.target,
          message: `\`${value}\` is not one of ${field.enumValues.join(", ")}.`,
        });
        continue;
      }
      values[mapping.target] = upper;
      continue;
    }

    values[mapping.target] = value;
  }

  return { values, errors };
}
