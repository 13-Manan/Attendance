import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { getSessionEndpoint } from "@/modules/integrations/service";

/** `/api/v1/attendance/sessions/{id}` */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["attendance:read"], resource: "AttendanceSession" }, async (ctx) =>
  okResponse(await getSessionEndpoint(ctx), ctx.requestId),
);
