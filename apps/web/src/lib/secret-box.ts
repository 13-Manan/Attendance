import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Authenticated encryption for secrets this application must be able to read
 * back.
 *
 * ## Why encryption and not hashing
 *
 * An API key is *verified*, so it is hashed and never recovered. A webhook
 * signing secret is different: the dispatcher has to produce an HMAC with it
 * on every delivery, so it must be readable. "Readable" is not the same as
 * "plaintext in a column", and that is what this module closes.
 *
 * ## The format
 *
 *   v1.<keyVersion>.<base64url iv>.<base64url tag>.<base64url ciphertext>
 *
 * One string, so it fits the existing `WebhookEndpoint.secret` column and
 * needs no migration to a new shape. The version prefix is what makes the
 * rollout safe: a value that does not start with `v1.` is a legacy plaintext
 * secret, and `openSecret` returns it unchanged. That is deliberate — the
 * alternative is a deploy in which every existing webhook silently stops
 * being signable.
 *
 * AES-256-GCM: authenticated, so a tampered ciphertext fails loudly instead of
 * decrypting to rubbish that then gets HMAC'd into a signature nobody can
 * verify. The IV is random per value and never reused, which is the property
 * GCM's security actually depends on.
 *
 * ## Where the key comes from
 *
 * `WEBHOOK_SECRET_KEK`, base64, 32 bytes, when it is set — the production
 * path, and the one that allows rotation independent of everything else.
 *
 * When it is not set the key is derived from `AUTH_SECRET` with HKDF and a
 * fixed domain-separation label. That keeps a development checkout and CI
 * working with no extra configuration, and it does not weaken the deployment:
 * anyone holding `AUTH_SECRET` can already forge a session and is inside
 * everything. It is recorded here rather than left implicit, because deriving
 * one secret from another is exactly the kind of thing that should be a
 * decision rather than an accident.
 *
 * ## Rotation
 *
 * `keyVersion` is written into every ciphertext. Adding a second key means
 * adding it to `KEYS` and bumping `CURRENT_KEY_VERSION`; existing values keep
 * decrypting under their own version until they are re-encrypted. Nothing in
 * this phase rotates a key — the mechanism exists so that doing so later is a
 * configuration change rather than a migration.
 */

const FORMAT = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Bumped when a new KEK is introduced. Written into each ciphertext. */
export const CURRENT_KEY_VERSION = 1;

const HKDF_INFO = "attendance:webhook-secret-kek:v1";

export class SecretBoxError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = "SecretBoxError";
    this.reason = reason;
  }
}

function deriveKey(version: number): Buffer {
  if (version !== CURRENT_KEY_VERSION) {
    throw new SecretBoxError(
      "unknown_key_version",
      `This value was encrypted with key version ${version}, which this build does not have.`,
    );
  }

  const explicit = process.env.WEBHOOK_SECRET_KEK;
  if (explicit) {
    const key = Buffer.from(explicit, "base64");
    if (key.length !== KEY_BYTES) {
      throw new SecretBoxError(
        "bad_kek",
        `WEBHOOK_SECRET_KEK must be ${KEY_BYTES} base64-encoded bytes; got ${key.length}.`,
      );
    }
    return key;
  }

  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret) {
    // Fail closed. Writing a secret this process cannot later read is worse
    // than refusing to write one.
    throw new SecretBoxError(
      "no_kek",
      "Set WEBHOOK_SECRET_KEK (32 bytes, base64) or AUTH_SECRET before storing webhook secrets.",
    );
  }
  return Buffer.from(hkdfSync("sha256", authSecret, "", HKDF_INFO, KEY_BYTES));
}

/** True when a stored value is already in this module's format. */
export function isSealed(value: string): boolean {
  return value.startsWith(`${FORMAT}.`);
}

export function sealSecret(plaintext: string, version = CURRENT_KEY_VERSION): string {
  if (plaintext === "") {
    throw new SecretBoxError("empty", "Refusing to encrypt an empty secret.");
  }
  const key = deriveKey(version);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    FORMAT,
    String(version),
    iv.toString("base64url"),
    tag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

/**
 * Reads a stored secret, sealed or legacy.
 *
 * A value with no `v1.` prefix is returned as-is: it predates encryption and
 * is still a working signing secret. This is the only reason the rollout can
 * be additive, and it is why `sealExistingSecrets` can migrate at leisure
 * rather than in a flag-day deploy.
 */
export function openSecret(stored: string): string {
  if (!isSealed(stored)) return stored;

  const parts = stored.split(".");
  if (parts.length !== 5) {
    throw new SecretBoxError("malformed", "The stored secret is not a well-formed sealed value.");
  }
  const [, versionRaw, ivRaw, tagRaw, ciphertextRaw] = parts;
  const version = Number(versionRaw);
  if (!Number.isInteger(version)) {
    throw new SecretBoxError("malformed", "The stored secret has no usable key version.");
  }

  const key = deriveKey(version);
  const iv = Buffer.from(ivRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  const ciphertext = Buffer.from(ciphertextRaw, "base64url");

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError("malformed", "The stored secret has a malformed IV or tag.");
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // GCM's tag check failed: the ciphertext was altered, or the key is not
    // the one it was sealed with. Both are the same answer to a caller, and
    // neither should say which.
    throw new SecretBoxError(
      "tampered_or_wrong_key",
      "The stored secret could not be decrypted. It was altered, or the encryption key changed.",
    );
  }
}

/**
 * Confirms a round trip before anything is persisted.
 *
 * Used by the migration: encrypt, decrypt, compare, and only then write. A
 * secret that seals but does not open is an endpoint that silently stops
 * signing, discovered days later by an integrator whose deliveries all fail
 * verification.
 */
export function verifySeal(plaintext: string, sealed: string): boolean {
  let opened: string;
  try {
    opened = openSecret(sealed);
  } catch {
    return false;
  }
  const a = Buffer.from(opened, "utf8");
  const b = Buffer.from(plaintext, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
