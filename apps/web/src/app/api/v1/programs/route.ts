import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { listProgramsEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/programs` — everything in the academic tree that is not a section:
 * a department, a grade, a semester, a course. One resource because the schema
 * models them as one table on purpose (see `AcademicUnit` in schema.prisma);
 * `kind` on each row says which it is.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["programs:read"], resource: "AcademicUnit" }, async (ctx) =>
  okResponse(await listProgramsEndpoint(ctx), ctx.requestId),
);
