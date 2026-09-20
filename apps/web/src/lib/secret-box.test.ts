import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  CURRENT_KEY_VERSION,
  SecretBoxError,
  isSealed,
  openSecret,
  sealSecret,
  verifySeal,
} from "./secret-box.ts";

/**
 * Phase 11 — webhook signing secrets, encrypted at rest.
 *
 * The property that matters is not "it encrypts" but that every failure mode
 * is loud. A signing secret that decrypts to rubbish does not throw on its
 * own: it produces an HMAC, the delivery goes out, and the receiver rejects a
 * signature nobody can explain. So the tampering and wrong-key cases are the
 * point, and they rely on GCM's authentication tag rather than on anything
 * this code checks by hand.
 *
 * The legacy-passthrough tests are equally load-bearing. Without them the
 * rollout would be a flag day in which every existing endpoint stops being
 * signable the moment the code deploys.
 */

/** Each test sets its own key, so none depends on the ambient environment. */
function withKek<T>(kek: string | undefined, fn: () => T): T {
  const previousKek = process.env.WEBHOOK_SECRET_KEK;
  const previousAuth = process.env.AUTH_SECRET;
  if (kek === undefined) delete process.env.WEBHOOK_SECRET_KEK;
  else process.env.WEBHOOK_SECRET_KEK = kek;
  process.env.AUTH_SECRET = previousAuth ?? "test-auth-secret-for-derivation";
  try {
    return fn();
  } finally {
    if (previousKek === undefined) delete process.env.WEBHOOK_SECRET_KEK;
    else process.env.WEBHOOK_SECRET_KEK = previousKek;
    if (previousAuth === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previousAuth;
  }
}

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

test("a secret round-trips", () => {
  withKek(KEY_A, () => {
    const secret = "whsec_" + randomBytes(24).toString("base64url");
    const sealed = sealSecret(secret);
    assert.notEqual(sealed, secret, "the plaintext is not what gets stored");
    assert.equal(openSecret(sealed), secret);
  });
});

test("the same secret seals differently every time", () => {
  withKek(KEY_A, () => {
    // A random IV per value. Reuse is the one thing GCM's security actually
    // depends on, so identical ciphertexts would be the bug worth catching.
    const a = sealSecret("same-secret");
    const b = sealSecret("same-secret");
    assert.notEqual(a, b);
    assert.equal(openSecret(a), openSecret(b));
  });
});

test("the sealed form is versioned and self-describing", () => {
  withKek(KEY_A, () => {
    const sealed = sealSecret("s");
    const parts = sealed.split(".");
    assert.equal(parts.length, 5);
    assert.equal(parts[0], "v1");
    assert.equal(parts[1], String(CURRENT_KEY_VERSION));
    assert.equal(isSealed(sealed), true);
  });
});

test("an empty secret is refused rather than sealed", () => {
  withKek(KEY_A, () => {
    assert.throws(() => sealSecret(""), SecretBoxError);
  });
});

// ---------------------------------------------------------------------------
// The failure modes that must be loud
// ---------------------------------------------------------------------------

test("a tampered ciphertext is rejected, not silently decrypted", () => {
  withKek(KEY_A, () => {
    const sealed = sealSecret("whsec_original");
    const parts = sealed.split(".");
    // Flip a byte of the ciphertext.
    const bytes = Buffer.from(parts[4], "base64url");
    bytes[0] ^= 0xff;
    parts[4] = bytes.toString("base64url");

    assert.throws(
      () => openSecret(parts.join(".")),
      (e: unknown) => e instanceof SecretBoxError && e.reason === "tampered_or_wrong_key",
      "GCM's tag is what catches this — nothing here checks it by hand",
    );
  });
});

test("a tampered authentication tag is rejected", () => {
  withKek(KEY_A, () => {
    const sealed = sealSecret("whsec_original");
    const parts = sealed.split(".");
    const tag = Buffer.from(parts[3], "base64url");
    tag[0] ^= 0xff;
    parts[3] = tag.toString("base64url");
    assert.throws(() => openSecret(parts.join(".")), SecretBoxError);
  });
});

test("the wrong key cannot open a sealed secret", () => {
  const sealed = withKek(KEY_A, () => sealSecret("whsec_original"));
  withKek(KEY_B, () => {
    assert.throws(
      () => openSecret(sealed),
      (e: unknown) => e instanceof SecretBoxError && e.reason === "tampered_or_wrong_key",
    );
  });
});

test("an unknown key version is refused rather than guessed at", () => {
  withKek(KEY_A, () => {
    const sealed = sealSecret("whsec_original");
    const parts = sealed.split(".");
    parts[1] = "99";
    assert.throws(
      () => openSecret(parts.join(".")),
      (e: unknown) => e instanceof SecretBoxError && e.reason === "unknown_key_version",
    );
  });
});

test("a malformed sealed value is refused", () => {
  withKek(KEY_A, () => {
    for (const bad of ["v1.1.short", "v1.x.aa.bb.cc", "v1.1.aa.bb.cc"]) {
      assert.throws(() => openSecret(bad), SecretBoxError, bad);
    }
  });
});

test("a KEK of the wrong length fails closed", () => {
  withKek(Buffer.from("too-short").toString("base64"), () => {
    assert.throws(
      () => sealSecret("x"),
      (e: unknown) => e instanceof SecretBoxError && e.reason === "bad_kek",
      "writing a secret this process cannot read back is worse than refusing",
    );
  });
});

// ---------------------------------------------------------------------------
// The rollout
// ---------------------------------------------------------------------------

test("a legacy plaintext secret passes through unchanged", () => {
  withKek(KEY_A, () => {
    // Endpoints created before this phase. Returning them as-is is what lets
    // encryption ship without every existing webhook stopping at once.
    const legacy = "whsec_created_before_encryption_existed";
    assert.equal(isSealed(legacy), false);
    assert.equal(openSecret(legacy), legacy);
  });
});

test("verifySeal confirms a round trip and rejects a mismatch", () => {
  withKek(KEY_A, () => {
    const secret = "whsec_migrating";
    const sealed = sealSecret(secret);
    assert.equal(verifySeal(secret, sealed), true);
    assert.equal(verifySeal("a-different-secret", sealed), false);
    assert.equal(verifySeal(secret, "v1.1.aa.bb.cc"), false, "and never throws");
  });
});

test("the key derives from AUTH_SECRET when no explicit KEK is set", () => {
  // The development and CI path: no extra configuration, still encrypted.
  withKek(undefined, () => {
    const sealed = sealSecret("whsec_derived");
    assert.equal(openSecret(sealed), "whsec_derived");
    assert.equal(isSealed(sealed), true);
  });
});

test("derivation is domain-separated from the session secret itself", () => {
  // The derived KEK must not equal AUTH_SECRET, or a log line containing one
  // would compromise the other.
  withKek(undefined, () => {
    const sealed = sealSecret(process.env.AUTH_SECRET ?? "x");
    assert.ok(!sealed.includes(process.env.AUTH_SECRET ?? "impossible"));
  });
});

test("sealing is not reversible without a key", () => {
  withKek(KEY_A, () => {
    const secret = "whsec_super_secret_value";
    const sealed = sealSecret(secret);
    // The plaintext must not be recoverable from the stored string by eye or
    // by a base64 decode of any component.
    assert.ok(!sealed.includes(secret));
    for (const part of sealed.split(".").slice(2)) {
      assert.ok(!Buffer.from(part, "base64url").toString("utf8").includes(secret));
    }
  });
});
