import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { deleteWebhookEndpointEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/webhooks/{id}`
 *
 * DELETE deactivates rather than erasing. The delivery history in `AuditLog`
 * points at this id, and "why did we stop receiving events on the 3rd?" is a
 * question an administrator should still be able to answer in six months.
 */
export const dynamic = "force-dynamic";

export const DELETE = apiRoute({ scopes: ["integrations:write"], resource: "WebhookEndpoint" }, async (ctx) =>
  okResponse(await deleteWebhookEndpointEndpoint(ctx), ctx.requestId),
);
