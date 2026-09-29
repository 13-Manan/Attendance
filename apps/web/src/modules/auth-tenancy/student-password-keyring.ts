import { createHash } from "node:crypto";
import { SecretBoxError, type Keyring } from "@/lib/secret-box";

// The keys a student account's recoverable password is sealed under.
//
// Import-free apart from the cipher module, like `session-policy.ts`, so the
// rules can be tested without a database or the validated environment.
//
// ## Version 1: STUDENT_PASSWORD_ENCRYPTION_KEY
//
// 32 random bytes, base64 — the only key production uses. In production it
// comes from Key Vault (`STUDENT-PASSWORD-ENCRYPTION-KEY`) through the web
// app's managed identity, exactly like AUTH_SECRET; see infra/azure. It is its
// own secret — not AUTH_SECRET, not the webhook key, not derived from either
// — so holding one of those opens no student password. It never enters the
// database, a log line or a response.
//
// ## Version 0: development only
//
// A fixed, public key, so a checkout and the test suite work with nothing
// configured. It protects nothing, and that is the point of it: nothing sealed
// under it is worth protecting. Production (NODE_ENV=production) never seals
// under it and refuses to open anything that was, so a development database's
// rows cannot turn into readable passwords there, and a production row is
// never sealed with a key anyone can read in this file.
//
// ## When the key is missing
//
// In production, with STUDENT_PASSWORD_ENCRYPTION_KEY unset, there is no
// key: `studentPasswordKeyring` throws `no_kek`. Everything that must seal —
// a new login, a reset, a change of password — asks for the keyring before it
// writes anything, so it refuses with nothing changed. No key is ever
// generated in its place.
//
// ## Rotation
//
// A replacement key is a new version (2, alongside 1), never a new value under
// version 1: a row sealed under the old value would then fail its tag check
// and read as unrecoverable. Nothing rotates a key yet.

/** STUDENT_PASSWORD_ENCRYPTION_KEY. */
export const STUDENT_PASSWORD_KEY_VERSION = 1;
/** The public development key. Never accepted in production. */
export const DEVELOPMENT_KEY_VERSION = 0;

const KEY_BYTES = 32;

const DEVELOPMENT_KEY = createHash("sha256")
  .update("attendance: development-only student password key; public, never accepted in production")
  .digest();

/** The part of the environment the keyring reads. */
export interface KeyringEnvironment {
  STUDENT_PASSWORD_ENCRYPTION_KEY?: string;
  NODE_ENV?: string;
}

/**
 * The keyring for student passwords, from the environment as it is now —
 * nothing is cached, so a restart with the same key opens what an earlier
 * process sealed, and a changed key is noticed at once.
 */
export function studentPasswordKeyring(environment: KeyringEnvironment = process.env): Keyring {
  const production = environment.NODE_ENV === "production";
  const raw = environment.STUDENT_PASSWORD_ENCRYPTION_KEY?.trim();
  const configured = raw ? parseKey(raw) : null;
  if (!configured && production) {
    throw new SecretBoxError(
      "no_kek",
      "STUDENT_PASSWORD_ENCRYPTION_KEY is not set, so student passwords can be neither stored nor revealed.",
    );
  }
  return {
    current: configured ? STUDENT_PASSWORD_KEY_VERSION : DEVELOPMENT_KEY_VERSION,
    key(version: number): Buffer {
      if (version === STUDENT_PASSWORD_KEY_VERSION && configured) return configured;
      if (version === DEVELOPMENT_KEY_VERSION && !production) return DEVELOPMENT_KEY;
      throw new SecretBoxError(
        "unknown_key_version",
        `This student password was sealed under key version ${version}, which this deployment does not hold.`,
      );
    },
  };
}

/** Strict base64 of exactly 32 bytes; anything else is a configuration error, not a key. */
function parseKey(raw: string): Buffer {
  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES || key.toString("base64") !== raw) {
    throw new SecretBoxError(
      "bad_kek",
      `STUDENT_PASSWORD_ENCRYPTION_KEY must be ${KEY_BYTES} random bytes, base64-encoded.`,
    );
  }
  return key;
}
