import { apiRoute, okResponse } from "@/modules/integrations/api-route";

/**
 * `/api/v1/reports` — a discovery index, not a report.
 *
 * An integrator hitting the resource named in the docs should learn what
 * reports exist and what each one takes, rather than a 404 that reads like a
 * deployment problem. Costs one authenticated round trip and saves a support
 * email.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["reports:read"], resource: "Report" }, async (ctx) =>
  okResponse(
    {
      data: [
        {
          id: "attendance",
          path: "/api/v1/reports/attendance",
          description:
            "Attendance totals for a window, with a per-student breakdown. Unreviewed records are reported separately and are never counted as present or absent.",
          parameters: ["cohortId", "studentId", "sessionId", "from", "to", "result"],
        },
      ],
      requestId: ctx.requestId,
    },
    ctx.requestId,
  ),
);
