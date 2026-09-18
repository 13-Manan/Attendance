import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { listSessionsEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/attendance/sessions`
 *
 * A static segment sitting beside `attendance/[id]`, which Next resolves in
 * favour of the literal — `/attendance/sessions` is never read as a record id.
 *
 * `metadata` is not exposed: it carries review and offline-sync internals that
 * change without an API version bump.
 *
 * Filters: `cohortId`, `status`, `from`, `to`.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["attendance:read"], resource: "AttendanceSession" }, async (ctx) =>
  okResponse(await listSessionsEndpoint(ctx), ctx.requestId),
);
