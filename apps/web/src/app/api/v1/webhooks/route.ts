import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { createWebhookEndpointEndpoint, listWebhookEndpointsEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/webhooks`
 *
 * Completes the Phase 2 scaffold, which validated `{ url, eventTypes }` and
 * answered 501. The request shape is unchanged; the 501 is now a 201 and a
 * real `WebhookEndpoint` row.
 *
 * The signing secret is in the creation response and nowhere else — not in the
 * list, not in an audit row, not in a log line. A receiver that loses it
 * registers a new endpoint.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["integrations:read"], resource: "WebhookEndpoint" }, async (ctx) =>
  okResponse(await listWebhookEndpointsEndpoint(ctx), ctx.requestId),
);

export const POST = apiRoute({ scopes: ["integrations:write"], resource: "WebhookEndpoint" }, async (ctx) => {
  const { body, status } = await createWebhookEndpointEndpoint(ctx);
  return Response.json(body, { status });
});
