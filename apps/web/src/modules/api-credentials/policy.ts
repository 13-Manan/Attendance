import { normalizeScopes, type ApiScope } from "@/modules/integrations/scopes";
import { WEBHOOK_EVENTS } from "@/modules/integrations/types";
import { validateBaseUrl } from "@/modules/integrations/providers/rest-provider";
import { CredentialError, MAX_CREDENTIAL_NAME, MAX_WEBHOOK_URL } from "./types";

/**
 * What a credential is allowed to be, before anything is written.
 *
 * Pure: no Prisma, no session, no randomness. Everything here refuses with a
 * sentence an administrator can act on, because the alternative — a form that
 * says "invalid" — makes people retype the same thing and then give up and ask
 * for a key with every scope.
 *
 * The SSRF rules for a webhook URL are not re-implemented here. They are
 * `validateBaseUrl` from the REST provider, reused deliberately: two subtly
 * different URL validators in one codebase means one of them is the weaker
 * one, and nobody knows which until it is used to reach a metadata endpoint.
 */

export function validateCredentialName(raw: unknown): string {
  const name = String(raw ?? "").trim();
  if (name === "") {
    throw new CredentialError(
      "Give the key a name that says which system uses it — 'Fee portal nightly sync' rather " +
        "than 'key 2'. It is the only thing you will have to go on when deciding whether it is " +
        "still needed.",
    );
  }
  if (name.length > MAX_CREDENTIAL_NAME) {
    throw new CredentialError(`The name must be ${MAX_CREDENTIAL_NAME} characters or fewer.`);
  }
  return name;
}

/**
 * Narrows a requested scope list to the ones this build knows.
 *
 * `normalizeScopes` drops unknown strings, de-duplicates and returns catalog
 * order. An empty result is refused rather than stored: a key with no scopes
 * authenticates successfully and is then rejected by every endpoint, which
 * looks to the integrator like an outage rather than a permissions problem.
 */
export function validateScopes(raw: readonly string[]): ApiScope[] {
  const scopes = normalizeScopes(raw);
  if (scopes.length === 0) {
    throw new CredentialError(
      "Choose at least one scope. A key with no scopes can sign in and do nothing, which is " +
        "indistinguishable from a broken integration.",
    );
  }
  return scopes;
}

export function validateWebhookUrl(raw: unknown): string {
  const url = String(raw ?? "").trim();
  if (url.length > MAX_WEBHOOK_URL) {
    throw new CredentialError(`The URL must be ${MAX_WEBHOOK_URL} characters or fewer.`);
  }
  const problems = validateBaseUrl(url).map((problem) =>
    problem.replace("Base URL", "Delivery URL"),
  );
  if (problems.length > 0) throw new CredentialError(problems.join(" "));
  return url;
}

/**
 * The events an endpoint subscribes to.
 *
 * An unknown event name is refused rather than dropped, which is the opposite
 * of the scope rule above and deliberate: a dropped scope leaves a key that
 * can do less than asked, which fails loudly at the first request. A dropped
 * event leaves an endpoint that silently never receives the thing it was
 * registered for, and nobody notices until somebody asks why the ERP is three
 * weeks behind.
 */
export function validateEventTypes(raw: readonly string[]): string[] {
  const events: string[] = [];
  for (const entry of raw) {
    const value = String(entry ?? "").trim();
    if (value === "") continue;
    if (!(WEBHOOK_EVENTS as readonly string[]).includes(value)) {
      throw new CredentialError(
        `"${value}" is not an event this system sends. Supported: ${WEBHOOK_EVENTS.join(", ")}.`,
      );
    }
    if (!events.includes(value)) events.push(value);
  }
  if (events.length === 0) {
    throw new CredentialError(
      "Choose at least one event. An endpoint subscribed to nothing is never called.",
    );
  }
  return events;
}
