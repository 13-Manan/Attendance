/**
 * Credentials an institution issues to other systems.
 *
 * Two kinds, one property in common: the secret exists in exactly one
 * response and is never readable again. `ApiKey.hashedKey` holds an HMAC, not
 * a key, and `WebhookEndpoint.secret` is never selected by any read path in
 * this module — so "show me the key again" is not a feature that was left out,
 * it is a thing the storage layer makes impossible. An administrator who loses
 * one issues another and revokes the old, which is the correct operation
 * anyway: a credential that has been lost has also, possibly, been found.
 *
 * No schema change. `ApiKey` and `WebhookEndpoint` already exist and are
 * already written by the integration API; this module is the screen an
 * administrator uses to manage the same rows.
 */

/** Longest name a credential may carry. A label, not a description. */
export const MAX_CREDENTIAL_NAME = 80;

/** Longest URL accepted for a webhook endpoint, matching the public API. */
export const MAX_WEBHOOK_URL = 2048;

export interface ApiKeySummary {
  id: string;
  name: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  /** Derived, never stored: a key is active until it is revoked. */
  isActive: boolean;
}

export interface WebhookSummary {
  id: string;
  url: string;
  eventTypes: string[];
  isActive: boolean;
  createdAt: Date;
}

/**
 * The plaintext half of a newly issued credential.
 *
 * Returned by the create paths and by nothing else. Never audited, never
 * logged, never re-read from the database — see `redaction.ts`, which would
 * catch it by key name if some future caller tried.
 */
export interface IssuedSecret {
  /** The value to copy. Shown once. */
  secret: string;
  notice: string;
}

export const ONE_TIME_NOTICE =
  "Copy this now. It is shown once and cannot be retrieved again — not by you, " +
  "not by support, not from the database. If it is lost, issue a new one and revoke this.";

export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}
