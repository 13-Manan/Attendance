"use client";

import type { LocalAiProbeResult } from "@/modules/offline-sync/types";

/**
 * The client half of the local-AI probe.
 *
 * Three states, three different sentences to a teacher, and no fourth state
 * where the app guesses. The brief's rule is *do not pretend full offline AI
 * works if the local AI runtime is not actually available*, and a probe that
 * defaults to optimistic when it cannot tell is exactly that pretence.
 *
 * So: a failed probe reads `UNAVAILABLE`, never `AVAILABLE`, and never a
 * cached earlier `AVAILABLE`. A node that answered five minutes ago on a
 * different network says nothing about the one this classroom is on.
 */

const PROBE_ENDPOINT = "/api/local-ai/health";
const CLIENT_TIMEOUT_MS = 3_000;

export async function probeLocalAi(): Promise<LocalAiProbeResult> {
  const checkedAt = new Date().toISOString();
  const startedAt = Date.now();
  try {
    const response = await fetch(PROBE_ENDPOINT, {
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    if (!response.ok) {
      return unavailable(checkedAt, Date.now() - startedAt, `http_${response.status}`);
    }
    return (await response.json()) as LocalAiProbeResult;
  } catch {
    // The app server itself is unreachable. On a cloud deployment this is the
    // normal offline case; on a LAN deployment it means the server in the
    // building is down. Either way the honest answer is the same one, and the
    // register is taken by hand.
    return unavailable(checkedAt, Date.now() - startedAt, "unreachable");
  }
}

function unavailable(checkedAt: string, latencyMs: number, error: string): LocalAiProbeResult {
  return {
    status: "UNAVAILABLE",
    modelName: null,
    modelVersion: null,
    latencyMs,
    checkedAt,
    error,
  };
}

/** One short sentence a teacher can act on, per state. */
export function localAiMessage(result: LocalAiProbeResult | null): string {
  if (!result) return "Checking for a local recognition node…";
  switch (result.status) {
    case "CHECKING":
      return "Checking for a local recognition node…";
    case "UNCONFIGURED":
      return "No local recognition node is configured. Mark this register by hand.";
    case "AVAILABLE":
      return `Local recognition available (${result.modelName ?? "model"}).`;
    case "UNAVAILABLE":
      return result.error === "timeout"
        ? "The local recognition node did not answer. Mark this register by hand."
        : "Recognition is unavailable offline. Mark this register by hand.";
  }
}
