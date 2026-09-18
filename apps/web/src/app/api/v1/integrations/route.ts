import { apiRoute, okResponse } from "@/modules/integrations/api-route";
import { listIntegrationsEndpoint } from "@/modules/integrations/service";

/**
 * `/api/v1/integrations` — connection status, without credentials.
 *
 * Read-only over the public API on purpose. Creating and editing connections
 * is an administrator action in the Integration Center, where the credentials
 * are entered and a human sees what they are pointing at; an API that let one
 * integration create another would let a compromised key establish persistent
 * outbound access to a server of its choosing.
 */
export const dynamic = "force-dynamic";

export const GET = apiRoute({ scopes: ["integrations:read"], resource: "Integration" }, async (ctx) =>
  okResponse(await listIntegrationsEndpoint(ctx), ctx.requestId),
);
