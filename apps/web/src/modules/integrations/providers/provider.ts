import type {
  IntegrationConfig,
  IntegrationKind,
  IntegrationResource,
} from "../types";

/**
 * The adapter contract.
 *
 * ## The rule this interface exists to enforce
 *
 * "Do not hardcode one school's ERP into the core application." The way that
 * rule is kept is not discipline — it is that the core has no place to put
 * such a thing. Nothing above this interface knows a vendor name, a vendor's
 * URL shape, or a vendor's field names. A provider knows a *transport*: how
 * to pull rows over REST, how to receive a push, how to read a file. What the
 * rows mean is field mapping's job, and what to do with them is the import
 * pipeline's.
 *
 * That split is why "add support for system X" is a new file in this
 * directory plus one line in the registry, and never a change to a route, a
 * service, or a screen.
 *
 * ## Why capabilities are declared rather than discovered
 *
 * "Do not assume every external system has a modern API." A CSV provider
 * cannot test a connection, cannot sync incrementally, and cannot be
 * scheduled in any meaningful sense — somebody uploads a file. Rather than
 * have the UI call `testConnection` and interpret a thrown
 * `NotSupportedError`, each provider states what it can do and the UI renders
 * accordingly. A "Test connection" button that is absent is honest; one that
 * is present and always fails is not.
 */

export interface ProviderCapabilities {
  /** Can answer "are these credentials and this URL working right now?". */
  testConnection: boolean;
  /** Can be asked for records — i.e. we pull. */
  pull: boolean;
  /** Receives records pushed at us. */
  push: boolean;
  /** Understands "only what changed since <timestamp>". */
  incremental: boolean;
  /** Can run unattended on a schedule. */
  scheduled: boolean;
  /** Resources this provider can carry at all. */
  resources: readonly IntegrationResource[];
}

export interface ConnectionTestResult {
  ok: boolean;
  /** One line for the admin UI. Never contains a credential. */
  message: string;
  /** Round-trip in ms, when a request was actually made. */
  latencyMs?: number;
  /** HTTP status, when there was one. */
  statusCode?: number;
}

export interface FetchOptions {
  resource: IntegrationResource;
  /**
   * Incremental watermark. When set, the provider should return only records
   * changed at or after this instant. A provider whose capabilities say
   * `incremental: false` may ignore it — the sync planner knows, and will not
   * claim an incremental run happened.
   */
  since?: Date;
  /** Provider-defined continuation token from the previous page. */
  cursor?: string;
  /** Upper bound on rows per call. */
  limit: number;
  signal?: AbortSignal;
}

export interface FetchPage {
  /**
   * Rows exactly as the external system presented them — keys are *its*
   * column names, values are strings. Normalisation is deliberately not done
   * here: a provider that started coercing types would be making decisions
   * that belong to the field mapping an administrator configured and can see.
   */
  rows: Array<Record<string, string>>;
  /** Pass back as `FetchOptions.cursor`. Null when the walk is complete. */
  nextCursor: string | null;
}

export interface IntegrationProvider {
  readonly kind: IntegrationKind;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  /**
   * Validates configuration *before* it is saved.
   *
   * Returns problems rather than throwing so the admin UI can show all of
   * them at once. A form that reveals one error at a time is how a person
   * ends up making five round trips to configure four fields.
   */
  validateConfig(config: IntegrationConfig): string[];

  testConnection?(config: IntegrationConfig): Promise<ConnectionTestResult>;
  fetch?(config: IntegrationConfig, options: FetchOptions): Promise<FetchPage>;
}

/** Providers that cannot do a thing say so here rather than throwing. */
export const UNSUPPORTED: ConnectionTestResult = {
  ok: false,
  message: "This integration type does not support connection testing.",
};
