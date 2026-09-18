import type { ApiScope } from "./scopes";

/**
 * Types for the Integration Hub.
 *
 * ## Where integration state lives, and why it is not a new table
 *
 * The database schema is frozen for this phase, so there is no `Integration`
 * table, no `WebhookDelivery` table and no `SyncRun` table. Rather than
 * pretend otherwise, integration state is placed where the schema already has
 * room for it, and each choice is a fit rather than a workaround:
 *
 * - **Connections, field mappings and sync schedules** → `Institution.settings`
 *   (a `Json` column). These are *configuration*: a handful of rows per
 *   institution, read whole, written by an admin, never queried across
 *   tenants. That is the same shape as `academicUnitLabels` and
 *   `confidenceThresholds`, which already live there, and the same pattern
 *   `AttendanceSession.metadata` carries for the review and offline-sync
 *   modules.
 *
 * - **Webhook deliveries and sync runs** → `AuditLog` rows. This is not a
 *   substitute for a deliveries table; it is a better fit than one. The
 *   product requirement for both is "an administrator can see what was
 *   attempted, when, by which client, and why it failed" — which is what an
 *   audit log is. `AuditLog` already has `institutionId`, `actorApiKeyId`,
 *   `beforeJson`/`afterJson`, and a `[entityType, entityId]` index that makes
 *   "every attempt for delivery X" a single indexed read.
 *
 * What this costs, stated plainly: there is no unique constraint the database
 * enforces on a delivery id, and no foreign key from a mapping to a subject.
 * Uniqueness and referential checks are done in the service layer and are
 * tested there. A future migration that promotes these to tables changes the
 * repository and nothing above it — which is why the codecs in
 * `connections.ts` are pure functions over plain objects rather than Prisma
 * types leaking upward.
 */

// ---------------------------------------------------------------------------
// Authentication context
// ---------------------------------------------------------------------------

/**
 * The authenticated caller of a `/api/v1/*` request.
 *
 * Deliberately says nothing about *how* the caller proved itself. An API key
 * produces one of these today; an OAuth2 client-credentials token or a
 * service account produces the same shape tomorrow, and every authorization
 * decision downstream keeps working untouched. `authMethod` exists so the
 * audit trail can record which proof was used without any authorization code
 * branching on it.
 */
export interface ApiKeyContext {
  apiKeyId: string;
  institutionId: string;
  scopes: string[];
  /** Human label for the key, for audit lines. Optional: older callers omit it. */
  name?: string;
  authMethod?: ApiAuthMethod;
}

export type ApiAuthMethod = "api_key" | "oauth2_client_credentials" | "service_account";

// ---------------------------------------------------------------------------
// Integration connections
// ---------------------------------------------------------------------------

/**
 * The adapter kinds the registry knows about.
 *
 * Open by design: `IntegrationProvider` is an interface and the registry is a
 * map, so a new kind is a new file plus one registration. Nothing in the core
 * application knows what a "Fedena" or a "Campus 365" is, and nothing should —
 * the brief's instruction not to hardcode one school's ERP is enforced by the
 * fact that the only provider-specific knowledge in this repo is *transport*
 * shape (REST, webhook, file), never vendor shape.
 */
export type IntegrationKind = "rest" | "webhook" | "csv";

export type IntegrationStatus =
  | "DRAFT"
  | "ACTIVE"
  | "PAUSED"
  | "ERROR";

export type SyncMode = "MANUAL" | "SCHEDULED" | "INCREMENTAL";

export type IntegrationResource =
  | "students"
  | "classes"
  | "sections"
  | "programs"
  | "subjects"
  | "faculty"
  | "enrollments"
  | "attendance";

/**
 * Non-secret connection configuration.
 *
 * `headers` carries auth headers for a REST provider, which is why the whole
 * object goes through `redact()` before it is logged or returned to a UI, and
 * why `describeConfig` exists to render it safely. Storing an external
 * system's bearer token in `Institution.settings` is the same trust level as
 * storing `WebhookEndpoint.secret` in its column: encrypted at rest by the
 * database, readable by the application, never sent to a browser.
 */
export interface IntegrationConfig {
  /** REST: the external system's base URL. */
  baseUrl?: string;
  /** REST: a health/ping path used by "Test connection". */
  testPath?: string;
  /** REST: extra headers, including the external system's own credential. */
  headers?: Record<string, string>;
  /** REST: per-resource path overrides, e.g. `{ students: "/api/pupils" }`. */
  resourcePaths?: Partial<Record<IntegrationResource, string>>;
  /** CSV: the delimiter the external export uses. Defaults to ",". */
  delimiter?: string;
  /** Webhook: the URL we deliver to. Mirrors WebhookEndpoint.url. */
  deliveryUrl?: string;
  /** Anything a future adapter needs and this interface has not anticipated. */
  extra?: Record<string, unknown>;
}

export interface SyncSchedule {
  mode: SyncMode;
  /** SCHEDULED/INCREMENTAL: minutes between runs. Ignored for MANUAL. */
  intervalMinutes?: number;
  /** ISO timestamp of the last run that completed, successfully or not. */
  lastSyncAt?: string;
  /** ISO timestamp of the last run that *succeeded*. The incremental cursor. */
  lastSuccessAt?: string;
  /**
   * Opaque provider cursor (an ERP page token, a change-feed sequence). Stored
   * verbatim and never interpreted here — an adapter that needs one owns its
   * meaning.
   */
  cursor?: string;
}

export interface IntegrationError {
  at: string;
  message: string;
  /** Resource being synced when it failed, when the failure was resource-scoped. */
  resource?: IntegrationResource;
}

export interface IntegrationConnection {
  id: string;
  name: string;
  kind: IntegrationKind;
  status: IntegrationStatus;
  /** Which resources this connection is allowed to touch. */
  resources: IntegrationResource[];
  config: IntegrationConfig;
  /** External field name → our canonical field key. See field-mapping.ts. */
  fieldMappings: FieldMapping[];
  schedule: SyncSchedule;
  /**
   * The most recent failures, newest first, capped. A ring buffer rather than
   * a full history because this lives in a settings blob that is read on every
   * page load — the durable history is in `AuditLog`.
   */
  recentErrors: IntegrationError[];
  createdAt: string;
  updatedAt: string;
}

/** The whole integrations bucket inside `Institution.settings`. */
export interface IntegrationSettings {
  connections?: IntegrationConnection[];
  /** Per-API-key rate limit overrides, keyed by ApiKey.id. */
  rateLimits?: Record<string, { burst: number; refillPerMinute: number }>;
}

/** The key this module owns inside `Institution.settings`. */
export const INTEGRATION_SETTINGS_KEY = "integrations" as const;

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------

export interface FieldMapping {
  /** The column/field name in the external system, e.g. `student_id`. */
  source: string;
  /** One of `TARGET_FIELDS`, e.g. `student.externalId`. */
  target: string;
  /**
   * Optional literal used when the source column is absent or blank. Lets an
   * export that omits `status` still import as ACTIVE without the adapter
   * inventing a default the admin never saw.
   */
  fallback?: string;
  /** A named, non-arbitrary transform. See field-mapping.ts. */
  transform?: FieldTransform;
}

/**
 * The transform vocabulary.
 *
 * Closed on purpose. The natural next request is "let admins write an
 * expression", and an expression evaluator in a settings blob is a remote
 * code execution surface reachable by anyone who can edit institution
 * settings. These cover what real exports actually need — case and whitespace
 * damage, and a handful of date dialects.
 */
export type FieldTransform =
  | "trim"
  | "uppercase"
  | "lowercase"
  | "digits_only"
  | "date_dmy"
  | "date_mdy"
  | "date_iso";

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const WEBHOOK_EVENTS = [
  "student.created",
  "student.updated",
  "student.deactivated",
  "attendance.created",
  "attendance.updated",
  "attendance.finalized",
  "attendance.corrected",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookEventEnvelope<T = unknown> {
  /** Stable per logical event. The receiver's idempotency key. */
  id: string;
  type: WebhookEvent;
  /** ISO 8601, when the event happened — not when it was delivered. */
  occurredAt: string;
  institutionId: string;
  /** API version of the payload shape, so a receiver can branch safely. */
  apiVersion: "v1";
  data: T;
}

export type DeliveryStatus = "PENDING" | "DELIVERING" | "DELIVERED" | "FAILED" | "EXHAUSTED";

export interface WebhookDelivery {
  /** Stable per (event, endpoint). Our own idempotency key. */
  id: string;
  eventId: string;
  eventType: WebhookEvent;
  endpointId: string;
  status: DeliveryStatus;
  attemptCount: number;
  /** ISO timestamp; null when the delivery is settled. */
  nextAttemptAt: string | null;
  lastStatusCode?: number;
  /** Already redacted by the time it lands here. */
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------

/** The error codes `/api/v1/*` can return. Stable — integrators branch on them. */
export type ApiErrorCode =
  | "unauthorized"
  | "insufficient_scope"
  | "rate_limited"
  | "invalid_request"
  | "not_found"
  | "method_not_allowed"
  | "payload_too_large"
  | "conflict"
  | "not_implemented"
  | "internal_error";

/**
 * The success envelope.
 *
 * `data` is the field the three scaffolded endpoints already returned, and it
 * stays that field — this phase completes those endpoints rather than
 * redefining a contract that is already documented in API_CONTRACTS.md.
 * Everything else is additive.
 */
export interface ApiListResponse<T> {
  data: T[];
  pagination: {
    limit: number;
    /** Opaque; pass back as `?cursor=`. Null when there is no further page. */
    nextCursor: string | null;
    hasMore: boolean;
  };
  requestId: string;
}

export interface ApiItemResponse<T> {
  data: T;
  requestId: string;
}

export interface ApiErrorResponse {
  error: ApiErrorCode;
  message: string;
  requestId: string;
  /** Field-level detail for `invalid_request`. */
  details?: unknown;
  /** Populated on `insufficient_scope` so an integrator can fix the key. */
  requiredScopes?: ApiScope[];
}
