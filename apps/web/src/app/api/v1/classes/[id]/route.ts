import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { getClassEndpoint } from "@/modules/integrations/service";

/** `/api/v1/classes/{id}` */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["classes:read"], resource: "Cohort" }, async (ctx) =>
  okResponse(await getClassEndpoint(ctx), ctx.requestId),
);
