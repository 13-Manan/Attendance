import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { getInstitutionEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/institutions` — the caller's own institution, and only that one.
 *
 * There is no tenant parameter and no listing of other schools. What comes
 * back is the profile an integrator needs to read the rest of the API: the id,
 * the academic-unit labels (so "class" vs "course" resolves), and the
 * attendance mode. Connections, credentials and rate-limit overrides live in
 * the same settings column and are deliberately not in the response.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["institutions:read"], resource: "Institution" }, async (ctx) =>
  okResponse(await getInstitutionEndpoint(ctx), ctx.requestId),
);
