import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { attendanceReportEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/reports/attendance`
 *
 * Aggregated in the database rather than paged and summed by the client.
 *
 * `attendanceRate` divides present by (present + absent). `NEEDS_REVIEW` and
 * `NOT_EVALUATED` are reported in their own fields and excluded from the
 * denominator — folding them into either side would publish a percentage no
 * teacher has agreed to.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["reports:read"], resource: "Report" }, async (ctx) =>
  okResponse(await attendanceReportEndpoint(ctx), ctx.requestId),
);
