import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { listAttendanceEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/attendance-records` — the Phase 2 URL, kept working.
 *
 * `/api/v1/attendance` is the documented resource and the one the brief names.
 * This path shipped first and is published in API_CONTRACTS.md, so it stays as
 * an alias of the same handler rather than becoming a 404 for anything already
 * pointed at it. Identical behaviour, identical envelope, identical scope.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["attendance:read"], resource: "AttendanceRecord" }, async (ctx) =>
  okResponse(await listAttendanceEndpoint(ctx), ctx.requestId),
);
