import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import {
  createExternalIdEndpoint,
  deleteExternalIdEndpoint,
  listExternalIdsEndpoint,
} from "@/modules/integrations/service";

/**
 * `/api/v1/external-ids` — what another system calls things in this institution.
 *
 * The resource that makes every other endpoint usable from an ERP. A caller
 * that only knows `STU-10092` can map it once and thereafter address this
 * platform's own ids, instead of the importer guessing that an external id and
 * the institution's roll number are the same string.
 *
 * Read and write are separate scopes because they are separate powers: an
 * export job needs to *read* what the ERP calls a student, and nothing more.
 *
 * There is no institution parameter here and there cannot be one — it comes
 * from the API key. Two tenants using the same vendor both have a student
 * `STU-10092`, and keeping those apart is the whole point of the table behind
 * this route.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute(
  { scopes: ["integrations:read"], resource: "ExternalIdentity" },
  async (ctx) => okResponse(await listExternalIdsEndpoint(ctx), ctx.requestId),
);

export const POST = apiRoute(
  { scopes: ["integrations:write"], resource: "ExternalIdentity" },
  async (ctx) => okResponse(await createExternalIdEndpoint(ctx), ctx.requestId),
);

export const DELETE = apiRoute(
  { scopes: ["integrations:write"], resource: "ExternalIdentity" },
  async (ctx) => okResponse(await deleteExternalIdEndpoint(ctx), ctx.requestId),
);
