import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { getProgramEndpoint } from "@/modules/integrations/service";

/** `/api/v1/programs/{id}` */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["programs:read"], resource: "AcademicUnit" }, async (ctx) =>
  okResponse(await getProgramEndpoint(ctx), ctx.requestId),
);
