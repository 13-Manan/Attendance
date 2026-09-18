import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { listSectionsEndpoint } from "@/modules/integrations/service";

/** `/api/v1/sections` — `AcademicUnit` rows of kind SECTION. */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["sections:read"], resource: "AcademicUnit" }, async (ctx) =>
  okResponse(await listSectionsEndpoint(ctx), ctx.requestId),
);
