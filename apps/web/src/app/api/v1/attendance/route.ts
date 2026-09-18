import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { listAttendanceEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/attendance` — the register.
 *
 * Returns `finalResult` only. The model's own guess and its confidence are not
 * published under any name and are not even selected from the database; see
 * `ATTENDANCE_SELECT` in modules/integrations/repository.ts.
 *
 * Filters: `sessionId`, `studentId`, `cohortId`, `from`, `to`, `result`,
 * `updatedSince`.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["attendance:read"], resource: "AttendanceRecord" }, async (ctx) =>
  okResponse(await listAttendanceEndpoint(ctx), ctx.requestId),
);
