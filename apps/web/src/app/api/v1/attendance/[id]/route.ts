import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { correctAttendanceEndpoint, getAttendanceEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/attendance/{id}`
 *
 * PATCH applies a correction on behalf of a named, authorized human —
 * `correctedBy` is required and must be an active user of this institution
 * holding `attendanceRecord.correct`. The change is appended to
 * `AttendanceCorrection` with `source: PUBLIC_API`, exactly like a correction
 * made in the portal, so the register has one history and not two.
 *
 * Only `PRESENT` and `ABSENT` may be written. See `API_WRITABLE_RESULTS`.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["attendance:read"], resource: "AttendanceRecord" }, async (ctx) =>
  okResponse(await getAttendanceEndpoint(ctx), ctx.requestId),
);

export const PATCH = apiRoute({ scopes: ["attendance:write"], resource: "AttendanceRecord" }, async (ctx) =>
  okResponse(await correctAttendanceEndpoint(ctx), ctx.requestId),
);
