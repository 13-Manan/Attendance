import {
  VALID_RESULTS,
  normalizeFilters,
  normalizePage,
  type RawReportQuery,
} from "@/modules/attendance-reporting/service";
import type { RollupOrder } from "@/modules/attendance-reporting/repository";
import {
  REPORT_DIMENSIONS,
  isReportDimension,
  type AttendanceMode,
  type ReportDimension,
  type ReportFilters,
  type ReportPageRequest,
} from "@/modules/attendance-reporting/types";

/**
 * The reporting workbench's URL, parsed.
 *
 * The URL *is* the report's state — every filter, the dimension, the page and
 * the sort. That is deliberate and costs nothing: an administrator can
 * bookmark a report, mail the link to a colleague, and the export button is a
 * plain link carrying the same query string, so the spreadsheet cannot
 * disagree with the screen. It is also why the whole workbench works with
 * JavaScript disabled — the filters are a GET form.
 *
 * Shared with the print route for the same reason: `/dashboard/reports/print`
 * reads the identical parameters and therefore shows the identical numbers.
 */
export type SearchParams = Record<string, string | string[] | undefined>;

function one(params: SearchParams, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/** A filter may appear repeated (`?cohortIds=a&cohortIds=b`) or comma-joined. */
function many(params: SearchParams, key: string): string[] | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((v) => v.split(",")).filter(Boolean);
}

export interface ReportRequest {
  dimension: ReportDimension;
  filters: ReportFilters;
  page: ReportPageRequest;
  order: RollupOrder;
  /** Present only when an administrator is trying a different rule on screen. */
  thresholdOverride: number | undefined;
  /** What the URL said, kept so links can be rebuilt without re-serializing dates. */
  raw: RawReportQuery;
}

export function parseReportQuery(params: SearchParams, now: Date): ReportRequest {
  const raw: RawReportQuery = {
    from: one(params, "from"),
    to: one(params, "to"),
    cohortIds: many(params, "cohortIds"),
    academicUnitIds: many(params, "academicUnitIds"),
    subjectIds: many(params, "subjectIds"),
    facultyIds: many(params, "facultyIds"),
    studentIds: many(params, "studentIds"),
    results: many(params, "results"),
  };

  const dimensionParam = one(params, "dimension") ?? "";
  const thresholdParam = Number(one(params, "threshold"));

  return {
    dimension: isReportDimension(dimensionParam) ? dimensionParam : "cohort",
    filters: normalizeFilters(raw, now),
    page: normalizePage({
      page: Number(one(params, "page")),
      pageSize: Number(one(params, "pageSize")),
    }),
    order: one(params, "order") === "rate" ? "rate" : "label",
    thresholdOverride: Number.isFinite(thresholdParam) ? thresholdParam : undefined,
    raw,
  };
}

/**
 * Rebuilds the query string with some parameters replaced.
 *
 * Used for every link on the page — a dimension tab, a page button, the
 * export buttons — so that changing one thing preserves the rest. Switching
 * dimension while a faculty filter is applied must keep the faculty filter;
 * losing it silently would show a different report under the same heading.
 */
export function reportHref(
  base: string,
  request: ReportRequest,
  overrides: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  const put = (key: string, values: string[] | undefined) => {
    for (const value of values ?? []) params.append(key, value);
  };

  params.set("dimension", request.dimension);
  // The normalized window, not the raw one: a link built from a page showing
  // the default 30 days should carry those dates explicitly, so the report
  // does not silently shift when it is opened on a later day.
  params.set("from", request.filters.from.toISOString().slice(0, 10));
  params.set("to", new Date(request.filters.to.getTime() - 1).toISOString().slice(0, 10));
  put("cohortIds", request.raw.cohortIds);
  put("academicUnitIds", request.raw.academicUnitIds);
  put("subjectIds", request.raw.subjectIds);
  put("facultyIds", request.raw.facultyIds);
  put("studentIds", request.raw.studentIds);
  put("results", request.raw.results);
  if (request.order !== "label") params.set("order", request.order);
  if (request.page.page !== 1) params.set("page", String(request.page.page));
  if (request.thresholdOverride !== undefined) {
    params.set("threshold", String(request.thresholdOverride));
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) params.delete(key);
    else params.set(key, String(value));
  }
  return `${base}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------

/**
 * What each dimension is called on screen.
 *
 * Deliberately worded as the brief words them — a school administrator asks
 * for "class-wise", not for "a rollup keyed on an AcademicUnit of kind GRADE".
 */
export const DIMENSION_LABELS: Record<ReportDimension, string> = {
  cohort: "Class",
  department: "Department",
  semester: "Semester",
  course: "Course",
  grade: "Grade",
  section: "Section",
  subject: "Subject",
  faculty: "Faculty",
  student: "Student",
  day: "Daily",
  month: "Monthly",
};

/**
 * The record-listing status filter, in the words a register uses.
 *
 * Applies to the record listing only — never to a rollup. Filtering a
 * percentage by "Absent" would give every group 0%, which is arithmetic
 * working correctly and a report meaning nothing.
 */
export const RESULT_LABELS: Record<(typeof VALID_RESULTS)[number], string> = {
  PRESENT: "Present",
  ABSENT: "Absent",
  NEEDS_REVIEW: "Needs review",
  NOT_EVALUATED: "Not evaluated",
};

/**
 * Which dimensions a given institution is offered.
 *
 * A school has no subjects and no semesters; a college has no grades. Offering
 * every dimension to everyone would mean half the tabs on any given screen
 * lead to an empty report — technically correct, and useless. The split
 * follows the brief's own SCHOOL/COLLEGE lists.
 *
 * This is presentation only. The service and the repository handle all eleven
 * dimensions for any institution, and a hand-edited URL asking a school for a
 * subject-wise report gets a correct empty result rather than an error.
 */
export function dimensionsFor(mode: AttendanceMode): ReportDimension[] {
  const college: ReportDimension[] = [
    "department",
    "semester",
    "course",
    "section",
    "subject",
    "faculty",
    "cohort",
    "student",
    "day",
    "month",
  ];
  const school: ReportDimension[] = [
    "grade",
    "section",
    "cohort",
    "faculty",
    "student",
    "day",
    "month",
  ];
  const chosen = mode === "SUBJECT_WISE" ? college : school;
  // Guards against a dimension being added to the union and quietly never
  // appearing in the UI.
  return chosen.filter((d) => REPORT_DIMENSIONS.includes(d));
}
