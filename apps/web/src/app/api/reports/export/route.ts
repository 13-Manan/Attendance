import { getCurrentUser } from "@/modules/auth-tenancy/session";
import { hasPermission } from "@/modules/authorization/service";
import { ForbiddenError } from "@/modules/authorization/types";
import { isExportFormat } from "@/modules/attendance-reporting/export";
import {
  buildReportExport,
  isReportKind,
  normalizeFilters,
  type RawReportQuery,
} from "@/modules/attendance-reporting/service";
import { isReportDimension } from "@/modules/attendance-reporting/types";

/**
 * Report download: CSV or Excel.
 *
 * A route handler rather than a server action because the product of this
 * endpoint is a *file*. A server action returns a value to a React tree; a
 * download needs a real HTTP response with its own content type and a
 * `Content-Disposition`, which is what a route handler is for.
 *
 * ## Authorization
 *
 * Checked twice, on purpose, and the two checks are not redundant. The
 * `hasPermission` calls here turn "not allowed" into a clean 403 JSON body
 * instead of an unhandled `ForbiddenError` and a 500. The real boundary is
 * still inside the service — `buildReportExport` reaches the data only through
 * `getRollup`/`getLowAttendance`/`getRecords`, each of which calls
 * `requireReportAccess` itself and resolves the institution from the session.
 * Delete this handler's checks and nothing becomes accessible; delete the
 * service's and everything does. The `catch` below is the proof that the
 * service check is the one being relied on.
 *
 * There is no `institutionId` parameter, and there cannot be one. The scope
 * comes from the session, so a caller cannot ask for another institution's
 * spreadsheet by editing a query string.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Repeated keys, e.g. `?cohortIds=a&cohortIds=b`. */
function multi(params: URLSearchParams, key: string): string[] | undefined {
  const values = params.getAll(key);
  return values.length ? values : undefined;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "unauthenticated" }, { status: 401 });
  }
  if (!hasPermission(user, "institution.read") || !hasPermission(user, "attendanceRecord.read")) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;

  // Unknown values are rejected rather than defaulted. Everywhere else in this
  // module a bad parameter narrows the report, because an administrator with a
  // stale bookmark should still see figures; here it would produce a file
  // labelled as one thing and containing another, which is worse than an
  // error.
  const kindParam = params.get("kind") ?? "rollup";
  if (!isReportKind(kindParam)) {
    return Response.json({ error: "invalid_kind" }, { status: 400 });
  }
  const dimensionParam = params.get("dimension") ?? "cohort";
  if (!isReportDimension(dimensionParam)) {
    return Response.json({ error: "invalid_dimension" }, { status: 400 });
  }
  const formatParam = params.get("format") ?? "csv";
  if (!isExportFormat(formatParam)) {
    return Response.json({ error: "invalid_format" }, { status: 400 });
  }

  const raw: RawReportQuery = {
    from: params.get("from") ?? undefined,
    to: params.get("to") ?? undefined,
    cohortIds: multi(params, "cohortIds"),
    academicUnitIds: multi(params, "academicUnitIds"),
    subjectIds: multi(params, "subjectIds"),
    facultyIds: multi(params, "facultyIds"),
    studentIds: multi(params, "studentIds"),
    results: multi(params, "results"),
  };
  const filters = normalizeFilters(raw, new Date());

  const thresholdRaw = Number(params.get("threshold"));
  const order = params.get("order") === "rate" ? "rate" : "label";

  let file: Awaited<ReturnType<typeof buildReportExport>>;
  try {
    file = await buildReportExport(user, kindParam, dimensionParam, filters, formatParam, {
      order,
      thresholdOverride: Number.isFinite(thresholdRaw) ? thresholdRaw : undefined,
    });
  } catch (error) {
    if (error instanceof ForbiddenError) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    throw error;
  }

  return new Response(new Uint8Array(file.body), {
    headers: {
      "Content-Type": file.contentType,
      // The filename is already restricted to `[A-Za-z0-9._-]` by
      // `safeFilename`, so it cannot carry a quote or a newline into this
      // header. Quoted anyway, because an unquoted `filename` with a `.` in it
      // is not valid per RFC 6266.
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Content-Length": String(file.body.length),
      // Reports are institution data and vary by session. A shared cache must
      // never hold one, and a stale window would be reported as current.
      "Cache-Control": "no-store, private",
      // Says so in a header as well as in the file, so an automated consumer
      // can notice a truncated export without parsing the spreadsheet.
      "X-Report-Truncated": String(file.truncated),
      "X-Report-Total-Rows": String(file.totalRows),
    },
  });
}
