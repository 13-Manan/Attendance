import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { listSubjectsEndpoint } from "@/modules/integrations/service";

/** `/api/v1/subjects` — the institution's subject catalogue. */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["subjects:read"], resource: "Subject" }, async (ctx) =>
  okResponse(await listSubjectsEndpoint(ctx), ctx.requestId),
);
