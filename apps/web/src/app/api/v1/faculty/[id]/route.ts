import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { getFacultyEndpoint } from "@/modules/integrations/service";

/** `/api/v1/faculty/{id}` — 404s for a user who is not teaching staff. */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["faculty:read"], resource: "User" }, async (ctx) =>
  okResponse(await getFacultyEndpoint(ctx), ctx.requestId),
);
