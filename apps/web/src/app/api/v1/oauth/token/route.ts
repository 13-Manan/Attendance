import { notImplementedRoute } from "@/modules/integrations/api-route";

/**
 * `/api/v1/oauth/token` — reserved, deliberately not implemented.
 *
 * The authorization model was built for this from the start: `ApiKeyContext`
 * says nothing about how a caller proved itself, `authMethod` already has
 * `oauth2_client_credentials` and `service_account` as values, and every scope
 * check reads `ctx.apiKey.scopes` — so landing OAuth2 means producing that
 * context from a token instead of a key, and changing no authorization code.
 *
 * It answers 501 rather than 404 because the two say different things to an
 * integrator: 404 sends them hunting for the right URL, 501 tells them the URL
 * is ours and is not ready. The body names the alternative that works today.
 */
export const dynamic = "force-dynamic";

export const POST = notImplementedRoute(
  "OAuth2 client credentials are not enabled yet. Authenticate with an API key: `Authorization: Bearer <key>`.",
);
