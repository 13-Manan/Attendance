import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "./password.ts";

test("a correct password verifies against its own hash", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
});

test("an incorrect password is rejected", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.equal(await verifyPassword("wrong password", hash), false);
});

test("two hashes of the same password are not identical (random salt)", async () => {
  const a = await hashPassword("same password");
  const b = await hashPassword("same password");
  assert.notEqual(a, b);
});

test("malformed stored hashes are rejected rather than throwing", async () => {
  assert.equal(await verifyPassword("anything", "not-a-real-hash"), false);
});
