import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertOutboundAddressAllowed,
  BlockedAddressError,
  isBlockedAddress,
} from "./outbound-guard.ts";

/**
 * Phase 10 — where a hostname actually points.
 *
 * The string validator in `providers/rest-provider.ts` catches
 * `http://169.254.169.254/`. It cannot catch `http://erp.example/` resolving
 * to the same address, and that is the version an attacker uses. So the
 * resolver is stubbed here and the tests are about the *answer*, not the URL.
 *
 * The private-range cases are as important as the blocked ones: an
 * on-premises ERP on 10.x is the main thing this feature is for, and a guard
 * that quietly broke it would be reported as "integration doesn't work"
 * rather than as a security regression.
 */

type Answer = { address: string; family: number };

/** A stub resolver, so no test depends on real DNS. */
function resolving(...answers: Answer[]) {
  return (async () => answers) as never;
}

function failing() {
  return (async () => {
    throw new Error("ENOTFOUND");
  }) as never;
}

// ---------------------------------------------------------------------------
// The address rule
// ---------------------------------------------------------------------------

test("loopback is blocked, v4 and v6", () => {
  assert.equal(isBlockedAddress("127.0.0.1", 4), true);
  assert.equal(isBlockedAddress("127.1.2.3", 4), true, "the whole 127/8, not just .0.1");
  assert.equal(isBlockedAddress("::1", 6), true);
});

test("the cloud metadata address is blocked", () => {
  // The one that turns an SSRF into stolen instance credentials on AWS, GCP
  // and Azure alike.
  assert.equal(isBlockedAddress("169.254.169.254", 4), true);
  assert.equal(isBlockedAddress("169.254.0.1", 4), true, "the whole link-local range");
  assert.equal(isBlockedAddress("fe80::1", 6), true);
});

test("the unspecified address is blocked", () => {
  assert.equal(isBlockedAddress("0.0.0.0", 4), true);
  assert.equal(isBlockedAddress("::", 6), true);
});

test("private ranges stay allowed, deliberately", () => {
  // An on-premises school ERP on the same LAN is the case this integration
  // exists for. Blocking these would make the feature useless for its primary
  // user; the trust boundary is that only an institution admin configures a
  // connection. Changing this is a product decision, not a tidy-up.
  assert.equal(isBlockedAddress("10.0.0.5", 4), false);
  assert.equal(isBlockedAddress("192.168.1.20", 4), false);
  assert.equal(isBlockedAddress("172.16.4.9", 4), false);
});

test("ordinary public addresses are allowed", () => {
  assert.equal(isBlockedAddress("93.184.216.34", 4), false);
  assert.equal(isBlockedAddress("2606:2800:220:1:248:1893:25c8:1946", 6), false);
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

test("a hostname resolving to the metadata address is refused", async () => {
  await assert.rejects(
    () =>
      assertOutboundAddressAllowed(
        "https://erp.example.edu/hook",
        resolving({ address: "169.254.169.254", family: 4 }),
      ),
    BlockedAddressError,
    "the whole point: nothing about this hostname looks wrong",
  );
});

test("the error names the host and the address it resolved to", async () => {
  const error = await assertOutboundAddressAllowed(
    "https://sneaky.example/hook",
    resolving({ address: "127.0.0.1", family: 4 }),
  ).catch((e: unknown) => e as BlockedAddressError);

  assert.ok(error instanceof BlockedAddressError);
  assert.equal(error.host, "sneaky.example");
  assert.equal(error.address, "127.0.0.1");
});

test("one bad answer among several is enough to refuse", async () => {
  // Which answer the runtime dials is not something the caller controls, so a
  // name that answers with both is a name this server declines to call.
  await assert.rejects(
    () =>
      assertOutboundAddressAllowed(
        "https://split.example/hook",
        resolving({ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }),
      ),
    BlockedAddressError,
  );
});

test("a hostname resolving to a LAN address is allowed through", async () => {
  await assert.doesNotReject(() =>
    assertOutboundAddressAllowed(
      "https://erp.school.internal/hook",
      resolving({ address: "10.1.2.3", family: 4 }),
    ),
  );
});

test("a resolution failure is not treated as a block", async () => {
  // An ERP that is briefly unresolvable should surface as the connection error
  // it is and be retried by the caller's policy — not as a security refusal,
  // which reads like a misconfiguration and sends an administrator hunting
  // for a setting that is not wrong.
  await assert.doesNotReject(() =>
    assertOutboundAddressAllowed("https://down.example/hook", failing()),
  );
});

test("a malformed URL is left to the string validator", async () => {
  await assert.doesNotReject(() => assertOutboundAddressAllowed("not a url", failing()));
});

test("an IPv6 literal has its brackets stripped before lookup", async () => {
  let asked = "";
  const resolver = (async (host: string) => {
    asked = host;
    return [{ address: "::1", family: 6 }];
  }) as never;

  await assert.rejects(
    () => assertOutboundAddressAllowed("https://[::1]/hook", resolver),
    BlockedAddressError,
  );
  assert.equal(asked, "::1", "brackets are URL syntax, not part of the address");
});
