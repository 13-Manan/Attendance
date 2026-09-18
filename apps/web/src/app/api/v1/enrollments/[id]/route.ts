import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { getEnrollmentEndpoint } from "@/modules/integrations/service";

/** `/api/v1/enrollments/{id}` */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["enrollments:read"], resource: "Enrollment" }, async (ctx) =>
  okResponse(await getEnrollmentEndpoint(ctx), ctx.requestId),
);
