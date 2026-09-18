import type { IntegrationKind } from "../types";
import { CsvProvider } from "./csv-provider";
import { RestProvider } from "./rest-provider";
import { WebhookProvider } from "./webhook-provider";
import type { IntegrationProvider } from "./provider";

/**
 * The provider registry.
 *
 * ## This file is the entire "add a new integration type" checklist
 *
 * Write a class implementing `IntegrationProvider`, add one line below. No
 * route changes, no service changes, no UI changes — the Integration Center
 * renders from `listProviders()` and the capability flags, so a new kind
 * appears in the "Add Integration" picker with the right buttons enabled by
 * virtue of existing.
 *
 * ## Why a map and not a switch
 *
 * A `switch (kind)` in the service layer is the same information, expressed
 * so that it must be repeated everywhere the kind is inspected — and the
 * fourth copy is the one that forgets a case. One map, looked up in one
 * place, means an unregistered kind fails identically everywhere.
 *
 * ## Instantiated once
 *
 * Providers are stateless and hold no per-connection data — configuration is
 * passed to every method rather than held in a field. That is what makes a
 * module-level singleton safe here, and it is also what would make a
 * per-institution provider instance pointless.
 */

const PROVIDERS: Record<IntegrationKind, IntegrationProvider> = {
  rest: new RestProvider(),
  webhook: new WebhookProvider(),
  csv: new CsvProvider(),
};

export function getProvider(kind: IntegrationKind): IntegrationProvider {
  // `Object.hasOwn`, not `PROVIDERS[kind]` alone: a stored kind of `toString`
  // or `constructor` resolves off `Object.prototype` to a function, which is
  // truthy, which walks straight past the guard below and fails later as
  // `provider.capabilities is undefined` in a place that has nothing to do
  // with the cause.
  const provider = Object.hasOwn(PROVIDERS, kind) ? PROVIDERS[kind] : undefined;
  if (!provider) {
    // Reachable: `kind` comes out of a JSON settings blob that a previous
    // build wrote, so a downgrade can produce a kind this build has never
    // heard of. Failing loudly beats returning a null provider whose methods
    // are then called.
    throw new Error(`Unknown integration kind: ${kind}`);
  }
  return provider;
}

export function isIntegrationKind(value: unknown): value is IntegrationKind {
  // Same reason as above: `"toString" in PROVIDERS` is true, and this function
  // is what decides whether a connection out of the settings blob is kept.
  return typeof value === "string" && Object.hasOwn(PROVIDERS, value);
}

export function listProviders(): IntegrationProvider[] {
  return Object.values(PROVIDERS);
}

/** Shape the "Add Integration" picker renders from. */
export interface ProviderSummary {
  kind: IntegrationKind;
  label: string;
  capabilities: IntegrationProvider["capabilities"];
}

export function listProviderSummaries(): ProviderSummary[] {
  return listProviders().map((provider) => ({
    kind: provider.kind,
    label: provider.label,
    capabilities: provider.capabilities,
  }));
}
