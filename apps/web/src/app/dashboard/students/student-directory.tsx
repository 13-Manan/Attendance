import Link from "next/link";
import {
  NO_CAMPUS,
  NO_COHORT,
  STUDENT_SORTS,
  studentFilterQuery,
  type StudentFilters,
} from "@/modules/students/directory-filters";
import {
  STUDENT_STATUSES,
  STUDENT_STATUS_LABEL,
  type StudentFormOptions,
  type StudentListRow,
  type StudentPage,
  type StudentStatus,
} from "@/modules/students/directory-types";
import { studentDisplayName } from "@/modules/students/types";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { TableScroll } from "@/components/ui/table-scroll";

/**
 * The student directory's filters, table and pager.
 *
 * Shared by the whole-institution directory on /dashboard/students and a
 * section's directory under /dashboard/students/classes, so a section lists
 * students exactly as the directory does — same columns, same actions, same
 * search — with only the class fixed.
 */

const BASE = "/dashboard/students";

/**
 * Formatted in UTC because an admission date is stored as UTC midnight — the
 * calendar day somebody typed. Formatting it in the reader's zone would show
 * the day before to anybody west of Greenwich.
 */
const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

const STATUS_TONE: Record<StudentStatus, BadgeTone> = {
  ACTIVE: "positive",
  INACTIVE: "neutral",
  TRANSFERRED: "neutral",
  COMPLETED: "info",
};

const labelClass = "flex flex-col gap-1.5 text-xs font-medium text-neutral-600";

function ClassCell({ student }: { student: StudentListRow }) {
  if (student.classes.length === 0) {
    return <span className="text-sm text-amber-700">Not placed</span>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {student.classes.map((link) => (
        <li key={link.enrollmentId} className="text-sm text-neutral-600">
          {link.cohortName}
          {link.termLabel ? ` · ${link.termLabel}` : ""}
          <span className="block text-xs text-neutral-400">
            {link.academicSessionName}
            {link.academicSessionIsCurrent ? " (current year)" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Search, Status, Class (optional), Sort and Campus, as named GET fields.
 * `showClass` is false where the class is fixed by the page itself.
 */
export function StudentFilterFields({
  filters,
  options,
  showClass,
}: {
  filters: StudentFilters;
  options: StudentFormOptions;
  showClass: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <label className={labelClass}>
        Search
        <Input
          type="search"
          name="q"
          defaultValue={filters.q}
          placeholder="Name, code, email, admission no."
          autoComplete="off"
        />
      </label>
      <label className={labelClass}>
        Status
        <Select name="status" defaultValue={filters.status}>
          <option value="">Every status</option>
          {STUDENT_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STUDENT_STATUS_LABEL[status]}
            </option>
          ))}
        </Select>
      </label>
      {showClass ? (
        <label className={labelClass}>
          Class
          <Select name="cohortId" defaultValue={filters.cohortId}>
            <option value="">Any class</option>
            <option value={NO_COHORT}>Not placed in any class</option>
            {options.cohorts.map((cohort) => (
              <option key={cohort.id} value={cohort.id}>
                {cohort.name}
                {cohort.termLabel ? ` · ${cohort.termLabel}` : ""} —{" "}
                {cohort.academicSessionName}
              </option>
            ))}
          </Select>
        </label>
      ) : null}
      <label className={labelClass}>
        Sort by
        <Select name="sort" defaultValue={filters.sort}>
          {STUDENT_SORTS.map((option) => (
            <option key={option.key} value={option.key}>
              {option.label}
            </option>
          ))}
        </Select>
      </label>
      {options.campuses.length > 0 ? (
        <label className={labelClass}>
          Campus
          <Select name="campusId" defaultValue={filters.campusId}>
            <option value="">Any campus</option>
            <option value={NO_CAMPUS}>No campus</option>
            {options.campuses.map((campus) => (
              <option key={campus.id} value={campus.id}>
                {campus.name} ({campus.code})
              </option>
            ))}
          </Select>
        </label>
      ) : null}
    </div>
  );
}

/** One page of students: who they are, their class, admission, status and the actions. */
export function StudentDirectoryTable({
  rows,
  canEnrollFace,
}: {
  rows: StudentListRow[];
  canEnrollFace: boolean;
}) {
  return (
    <TableScroll minWidth="min-w-[52rem]">
      <table className="w-full border-collapse text-left">
        <thead className="bg-neutral-50">
          <tr className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
            <th className="py-2.5 pr-4 pl-3 font-medium">Student</th>
            <th className="py-2.5 pr-4 font-medium">Class</th>
            <th className="py-2.5 pr-4 font-medium">Admission</th>
            <th className="py-2.5 pr-4 font-medium">Status</th>
            <th className="py-2.5 pr-3 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((student) => (
            <tr key={student.id} className="align-top transition-colors hover:bg-neutral-50/60">
              <td className="py-3 pr-4 first:pl-3">
                <Link
                  href={`${BASE}/${student.id}`}
                  className="text-sm font-medium text-neutral-900 hover:underline"
                >
                  {studentDisplayName(student)}
                </Link>
                <p className="font-mono text-xs text-neutral-500">{student.studentCode}</p>
                {student.campusName ? (
                  <p className="text-xs text-neutral-400">{student.campusName}</p>
                ) : null}
              </td>
              <td className="py-3 pr-4 first:pl-3">
                <ClassCell student={student} />
              </td>
              <td className="py-3 pr-4 text-sm text-neutral-600">
                {student.admissionNumber ?? (
                  <span className="text-neutral-400">No number</span>
                )}
                {student.admissionDate ? (
                  <span className="block text-xs text-neutral-400">
                    {DATE_FORMAT.format(student.admissionDate)}
                  </span>
                ) : null}
              </td>
              <td className="py-3 pr-4 first:pl-3">
                <Badge tone={STATUS_TONE[student.status]}>
                  {STUDENT_STATUS_LABEL[student.status]}
                </Badge>
              </td>
              <td className="py-3 pr-3">
                <div className="flex flex-col items-start gap-2">
                  <Link href={`${BASE}/${student.id}`}>
                    <Button type="button" variant="secondary">
                      View
                    </Button>
                  </Link>
                  {canEnrollFace ? (
                    <Link
                      href={`${BASE}/${student.id}/enroll-face`}
                      className="text-xs text-neutral-600 underline underline-offset-2 hover:text-neutral-900"
                    >
                      Enroll face
                    </Link>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}

/** Previous / Page n of m / Next, as links that keep the current filters. */
export function StudentDirectoryPager({
  page,
  filters,
  baseHref,
  label,
}: {
  page: StudentPage;
  filters: StudentFilters;
  /** The page these filters apply to. */
  baseHref: string;
  label: string;
}) {
  if (page.pageCount <= 1) return null;
  return (
    <nav aria-label={label} className="mt-3 flex flex-wrap items-center justify-between gap-2">
      {/* Links rather than buttons: a page of a list is a place, and
          a reader should be able to open page 3 in a new tab or come
          back to it from history. */}
      {page.page > 1 ? (
        <Link href={`${baseHref}${studentFilterQuery(filters, { page: page.page - 1 })}`}>
          <Button type="button" variant="secondary">
            ← Previous
          </Button>
        </Link>
      ) : (
        <span className="px-3 py-2 text-sm text-neutral-400">← Previous</span>
      )}
      <p className="text-xs tabular-nums text-neutral-500">
        Page {page.page} of {page.pageCount}
      </p>
      {page.page < page.pageCount ? (
        <Link href={`${baseHref}${studentFilterQuery(filters, { page: page.page + 1 })}`}>
          <Button type="button" variant="secondary">
            Next →
          </Button>
        </Link>
      ) : (
        <span className="px-3 py-2 text-sm text-neutral-400">Next →</span>
      )}
    </nav>
  );
}
