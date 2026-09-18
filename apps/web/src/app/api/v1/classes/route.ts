import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { listClassesEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/classes` — the enrollable teaching groups (`Cohort`).
 *
 * Read-only. Creating a class means choosing an academic unit and an academic
 * session, which is a structural decision an administrator makes in the portal
 * with the tree in front of them; an API that let an ERP invent cohorts would
 * produce duplicates nobody can reconcile.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["classes:read"], resource: "Cohort" }, async (ctx) =>
  okResponse(await listClassesEndpoint(ctx), ctx.requestId),
);
