import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { getSubjectEndpoint } from "@/modules/integrations/service";

/** `/api/v1/subjects/{id}` */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["subjects:read"], resource: "Subject" }, async (ctx) =>
  okResponse(await getSubjectEndpoint(ctx), ctx.requestId),
);
