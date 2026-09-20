import { lookup } from "node:dns/promises";

/**
 * The second half of the SSRF guard: where a hostname actually points.
 *
 * `validateBaseUrl` in `providers/rest-provider.ts` checks the *string* an
 * administrator typed, which catches `http://127.0.0.1/` and
 * `http://169.254.169.254/`. It cannot catch `http://metadata.my-erp.example/`
 * resolving to `169.254.169.254`, because nothing about that hostname looks
 * wrong — and the brief is explicit that hostname validation alone is not
 * enough.
 *
 * So this resolves the name and applies the same rule to the address that came
 * back. Deliberately the *same* rule, not a stricter one: private ranges stay
 * allowed, because an on-premises school ERP on the same LAN is the case this
 * integration exists for, and the trust boundary being relied on is that only
 * an institution admin can configure a connection. Loopback and link-local are
 * blocked in both halves — those are never a legitimate ERP and always worth a
 * credential to whoever can reach them.
 *
 * ## What this does not close
 *
 * DNS rebinding. Between this lookup and the socket the runtime opens, a
 * hostile resolver can answer differently, and Node's `fetch` gives no hook to
 * pin the address it dials. Closing that needs a custom agent that connects to
 * a validated IP and carries the original `Host` header — a real change to how
 * every outbound request is made, and out of scope here. What this does buy is
 * that the *straightforward* version of the attack, a hostname that simply
 * resolves to the metadata endpoint, now fails. The residual risk is recorded
 * in the Phase 10 report rather than left implied.
 */

export class BlockedAddressError extends Error {
  // Declared rather than written as constructor parameter properties: Node's
  // type-stripping loader runs this file directly and rejects that syntax.
  readonly host: string;
  readonly address: string;

  constructor(host: string, address: string) {
    super(
      `${host} resolves to ${address}, which this server will not call. ` +
        `Point the integration at a routable address.`,
    );
    this.name = "BlockedAddressError";
    this.host = host;
    this.address = address;
  }
}

/** Loopback: 127.0.0.0/8 and ::1. */
function isLoopback(address: string, family: number): boolean {
  if (family === 4) return address.startsWith("127.");
  return address === "::1" || address === "0:0:0:0:0:0:0:1";
}

/**
 * Link-local, which is where every cloud's instance-metadata service lives:
 * 169.254.0.0/16 and fe80::/10. `169.254.169.254` is the well-known one on
 * AWS, GCP and Azure alike.
 */
function isLinkLocal(address: string, family: number): boolean {
  if (family === 4) return address.startsWith("169.254.");
  const lower = address.toLowerCase();
  return lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb");
}

/** The unspecified address, which on some stacks routes to localhost. */
function isUnspecified(address: string): boolean {
  return address === "0.0.0.0" || address === "::";
}

export function isBlockedAddress(address: string, family: number): boolean {
  return isLoopback(address, family) || isLinkLocal(address, family) || isUnspecified(address);
}

/**
 * Resolves `url`'s hostname and throws if any answer is blocked.
 *
 * *Any*, not *all*: a name answering with one routable address and one
 * link-local one is a name this server declines to call, because which answer
 * the runtime dials is not something the caller controls.
 *
 * A resolution failure is not treated as a block — an ERP that is briefly
 * unresolvable should surface as the connection error it is, and be retried by
 * the caller's own policy, rather than as a security refusal that reads like a
 * misconfiguration.
 */
export async function assertOutboundAddressAllowed(
  url: string,
  resolver: typeof lookup = lookup,
): Promise<void> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return; // Malformed URLs are the string validator's job, not this one's.
  }

  // A bracketed IPv6 literal, or a bare IPv4 one, needs no lookup — and
  // `dns.lookup` on a literal just echoes it back anyway.
  const literal = host.replace(/^\[|\]$/g, "");

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await resolver(literal, { all: true, verbatim: true });
  } catch {
    return;
  }

  for (const answer of answers) {
    if (isBlockedAddress(answer.address, answer.family)) {
      throw new BlockedAddressError(host, answer.address);
    }
  }
}
