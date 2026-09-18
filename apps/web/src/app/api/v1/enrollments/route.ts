import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { listEnrollmentsEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/enrollments` — which students belong to which class.
 *
 * Filters: `cohortId`, `studentId`, `status`.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["enrollments:read"], resource: "Enrollment" }, async (ctx) =>
  okResponse(await listEnrollmentsEndpoint(ctx), ctx.requestId),
);
