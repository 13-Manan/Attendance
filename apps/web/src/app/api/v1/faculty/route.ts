import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { listFacultyEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/faculty`
 *
 * Teaching staff, identified by role or by an actual teaching link — see
 * `facultyWhere` in modules/integrations/repository.ts for why both. Never
 * includes a password hash or a last-login time.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["faculty:read"], resource: "User" }, async (ctx) =>
  okResponse(await listFacultyEndpoint(ctx), ctx.requestId),
);
