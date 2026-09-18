import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { getSectionEndpoint } from "@/modules/integrations/service";

/** `/api/v1/sections/{id}` */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["sections:read"], resource: "AcademicUnit" }, async (ctx) =>
  okResponse(await getSectionEndpoint(ctx), ctx.requestId),
);
