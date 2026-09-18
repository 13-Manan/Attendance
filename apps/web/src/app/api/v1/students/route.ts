import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { createStudentEndpoint, listStudentsEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/students`
 *
 * Completes the Phase 2 scaffold that proved the auth contract by returning an
 * empty array. The URL, the `data` envelope and the 401 shape are unchanged —
 * anything already pointed at this endpoint keeps working and now receives
 * real rows.
 *
 * Filters: `status`, `cohortId`, `studentCode`, `updatedSince`, `limit`, `cursor`.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["students:read"], resource: "Student" }, async (ctx) =>
  okResponse(await listStudentsEndpoint(ctx), ctx.requestId),
);

export const POST = apiRoute({ scopes: ["students:write"], resource: "Student" }, async (ctx) => {
  const { body, status } = await createStudentEndpoint(ctx);
  return Response.json(body, { status });
});
