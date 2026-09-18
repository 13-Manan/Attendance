import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { promisify } from "node:util";

// promisify(scrypt) resolves to the wrong overload (drops the `options`
// param) because crypto.scrypt has multiple overloads with different
// arities — cast explicitly rather than let TS pick one for us. This keeps
// the KDF work off the main event loop (unlike scryptSync, which would
// block it for the ~10-50ms cost of every login).
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
// N/r/p are encoded into the stored hash so cost parameters can be raised
// later without invalidating existing hashes (older hashes just get
// verified with their own recorded params, until the user next logs in and
// could be re-hashed — that upgrade path isn't built this phase).
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(plain, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return [
    "scrypt",
    SCRYPT_PARAMS.N,
    SCRYPT_PARAMS.r,
    SCRYPT_PARAMS.p,
    salt.toString("hex"),
    key.toString("hex"),
  ].join("$");
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, keyHex] = parts;

  const expected = Buffer.from(keyHex, "hex");
  const derived = await scryptAsync(plain, Buffer.from(saltHex, "hex"), expected.length, {
    N: Number(nStr),
    r: Number(rStr),
    p: Number(pStr),
  });

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}
