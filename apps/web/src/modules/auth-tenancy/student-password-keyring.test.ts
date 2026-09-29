import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { SecretBoxError, openParts, sealParts } from "../../lib/secret-box.ts";
import {
  DEVELOPMENT_KEY_VERSION,
  STUDENT_PASSWORD_KEY_VERSION,
  studentPasswordKeyring,
} from "./student-password-keyring.ts";

/**
 * The student-password key: which key seals a student's recoverable password,
 * and — the part that matters — that production never works without the real
 * one and never accepts the public development key.
 */

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const production = (key?: string) => ({ NODE_ENV: "production", STUDENT_PASSWORD_ENCRYPTION_KEY: key });
const development = (key?: string) => ({ NODE_ENV: "development", STUDENT_PASSWORD_ENCRYPTION_KEY: key });
const refusedAs = (reason: string) => (error: unknown) => error instanceof SecretBoxError && error.reason === reason;

test("production without the key fails closed: no keyring, so nothing can be sealed or opened", () => {
  assert.throws(() => studentPasswordKeyring(production(undefined)), refusedAs("no_kek"));
  assert.throws(() => studentPasswordKeyring(production("")), refusedAs("no_kek"));
  assert.throws(() => studentPasswordKeyring(production("   ")), refusedAs("no_kek"));
});

test("production with the key seals under version 1", () => {
  const ring = studentPasswordKeyring(production(KEY));
  assert.equal(ring.current, STUDENT_PASSWORD_KEY_VERSION);
  const sealed = sealParts(ring, "Password-B", "attendance:student-password:u1");
  assert.equal(sealed.keyVersion, 1);
  assert.equal(openParts(ring, sealed, "attendance:student-password:u1"), "Password-B");
});

test("production refuses the development key, for sealing and for opening", () => {
  const devSealed = sealParts(studentPasswordKeyring(development(undefined)), "dev-password", "a");
  assert.equal(devSealed.keyVersion, DEVELOPMENT_KEY_VERSION);
  const ring = studentPasswordKeyring(production(KEY));
  assert.throws(() => ring.key(DEVELOPMENT_KEY_VERSION), refusedAs("unknown_key_version"));
  assert.throws(() => openParts(ring, devSealed, "a"), refusedAs("unknown_key_version"));
});

test("development without the key uses the public development key; with it, the real one", () => {
  const withoutKey = studentPasswordKeyring(development(undefined));
  assert.equal(withoutKey.current, DEVELOPMENT_KEY_VERSION);
  const withKey = studentPasswordKeyring(development(KEY));
  assert.equal(withKey.current, STUDENT_PASSWORD_KEY_VERSION);
  // A development database's older rows stay readable there.
  const old = sealParts(withoutKey, "older", "a");
  assert.equal(openParts(withKey, old, "a"), "older");
});

test("a malformed key is a configuration error, not a key", () => {
  for (const bad of ["not-base64!", Buffer.from("too short").toString("base64"), randomBytes(33).toString("base64"), randomBytes(32).toString("base64url")]) {
    assert.throws(() => studentPasswordKeyring(production(bad)), refusedAs("bad_kek"), bad);
  }
});

test("the wrong key fails safely: tampered-or-wrong-key, never another password", () => {
  const sealed = sealParts(studentPasswordKeyring(production(KEY)), "Password-C", "a");
  assert.throws(() => openParts(studentPasswordKeyring(production(OTHER_KEY)), sealed, "a"), refusedAs("tampered_or_wrong_key"));
});

test("a restart with the same key opens what an earlier process sealed", () => {
  // Nothing is cached: a new keyring from the same configuration is all a restart is.
  const sealed = sealParts(studentPasswordKeyring(production(KEY)), "Password-D", "attendance:student-password:u9");
  const afterRestart = studentPasswordKeyring(production(` ${KEY} `));
  assert.equal(openParts(afterRestart, sealed, "attendance:student-password:u9"), "Password-D");
});

test("the development key is not derived from AUTH_SECRET", () => {
  const previous = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "one-auth-secret-for-this-test";
  const a = sealParts(studentPasswordKeyring({ NODE_ENV: "test" }), "x", "a");
  process.env.AUTH_SECRET = "a-different-auth-secret-for-this-test";
  try {
    assert.equal(openParts(studentPasswordKeyring({ NODE_ENV: "test" }), a, "a"), "x");
  } finally {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
  }
});
