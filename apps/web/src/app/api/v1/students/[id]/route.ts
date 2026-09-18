import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { getStudentEndpoint, updateStudentEndpoint } from "@/modules/integrations/service";

/** `/api/v1/students/{id}` — read one, or PATCH the fields an ERP owns. */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["students:read"], resource: "Student" }, async (ctx) =>
  okResponse(await getStudentEndpoint(ctx), ctx.requestId),
);

export const PATCH = apiRoute({ scopes: ["students:write"], resource: "Student" }, async (ctx) =>
  okResponse(await updateStudentEndpoint(ctx), ctx.requestId),
);
