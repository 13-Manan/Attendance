import type { ConflictEvent, DecisionEvent, PairConflict, StandingDecision } from "./types";

/**
 * The pure half of twin confirmations: naming a pair, and folding the audit
 * events about it into where it stands. No database, no session.
 */

/** Ids as this app writes them: cuids, or the readable ids tests and seeds use. */
const STUDENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The pair's key: both ids, sorted, joined with `~`.
 *
 * Sorted so the pair is one thing whichever student was being enrolled when
 * the conflict was found — "A matched B" and "B matched A" are the same
 * question about the same two people, and must share one decision.
 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

/**
 * The two ids in a key, or null for anything that is not a key this app could
 * have written: wrong shape, one id twice, unsorted, or characters an id never
 * has. A URL segment is user input.
 */
export function parsePairKey(key: unknown): [string, string] | null {
  if (typeof key !== "string" || key.length > 140) return null;
  const parts = key.split("~");
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  if (!STUDENT_ID.test(a) || !STUDENT_ID.test(b) || a === b) return null;
  if (pairKey(a, b) !== key) return null;
  return [a, b];
}

/**
 * Each pair's latest decision row — the one that stands, whatever its kind.
 * The same "latest wins" rule the enrollment check reads (repository.ts).
 */
export function latestDecisionByPair(decisions: readonly DecisionEvent[]): Map<string, DecisionEvent> {
  const latest = new Map<string, DecisionEvent>();
  for (const decision of decisions) {
    const current = latest.get(decision.pair);
    if (!current || isLater(decision, current)) latest.set(decision.pair, decision);
  }
  return latest;
}

/** A latest row that is a decision, not the withdrawal of one. */
export function standingOf(decision: DecisionEvent | null | undefined): StandingDecision | null {
  return decision && decision.decision !== "withdrawn" ? (decision as StandingDecision) : null;
}

/**
 * Pairs whose standing decision is a declaration made in advance: marked as
 * known twins or lookalikes, and neither withdrawn nor overruled by a review
 * since. Keyed by pair.
 */
export function declaredPairs(decisions: readonly DecisionEvent[]): Map<string, StandingDecision> {
  const declared = new Map<string, StandingDecision>();
  for (const [pair, latest] of latestDecisionByPair(decisions)) {
    if (latest.decision === "confirmed" && latest.source === "declared" && parsePairKey(pair)) {
      declared.set(pair, latest as StandingDecision);
    }
  }
  return declared;
}

/**
 * Every pair with at least one conflict, and where each stands.
 *
 * A pair is pending until somebody decides; after that the latest decision is
 * its state. A conflict recorded after a decision does not reopen it — a
 * student retrying after "not confirmed" must not put the pair back in front
 * of staff on every attempt. A withdrawn declaration is no decision, so a
 * conflict about that pair is pending again. Decisions about a pair with no
 * conflict are ignored here: there is nothing for them to apply to (declared
 * pairs are listed on their own — `declaredPairs`).
 */
export function foldPairs(
  conflicts: readonly ConflictEvent[],
  decisions: readonly DecisionEvent[],
): PairConflict[] {
  const latestDecision = latestDecisionByPair(decisions);

  const pairs = new Map<string, PairConflict>();
  for (const conflict of conflicts) {
    if (conflict.blockedStudentId === conflict.matchedStudentId) continue;
    const key = pairKey(conflict.blockedStudentId, conflict.matchedStudentId);
    const existing = pairs.get(key);
    if (!existing) {
      pairs.set(key, {
        pair: key,
        blockedStudentId: conflict.blockedStudentId,
        matchedStudentId: conflict.matchedStudentId,
        firstDetectedAt: conflict.at,
        lastDetectedAt: conflict.at,
        attempts: 1,
        lastChannel: conflict.channel,
        decision: null,
        state: "pending",
      });
      continue;
    }
    existing.attempts += 1;
    if (conflict.at < existing.firstDetectedAt) existing.firstDetectedAt = conflict.at;
    if (conflict.at >= existing.lastDetectedAt) {
      existing.lastDetectedAt = conflict.at;
      existing.blockedStudentId = conflict.blockedStudentId;
      existing.matchedStudentId = conflict.matchedStudentId;
      existing.lastChannel = conflict.channel;
    }
  }

  for (const pair of pairs.values()) {
    const decision = standingOf(latestDecision.get(pair.pair));
    pair.decision = decision;
    pair.state = decision ? decision.decision : "pending";
  }
  return [...pairs.values()];
}

function isLater(a: { at: Date; id: string }, b: { at: Date; id: string }): boolean {
  const difference = a.at.getTime() - b.at.getTime();
  return difference !== 0 ? difference > 0 : a.id > b.id;
}

/**
 * Pending first, most recently detected first; then decided, most recently
 * decided first. The queue is for working through, the history for looking up.
 */
export function orderForQueue<T extends { state: string; lastDetectedAt: Date; decidedAt: Date | null }>(
  items: readonly T[],
): { pending: T[]; decided: T[] } {
  const pending = items
    .filter((item) => item.state === "pending")
    .sort((a, b) => b.lastDetectedAt.getTime() - a.lastDetectedAt.getTime());
  const decided = items
    .filter((item) => item.state !== "pending")
    .sort((a, b) => (b.decidedAt?.getTime() ?? 0) - (a.decidedAt?.getTime() ?? 0));
  return { pending, decided };
}

/**
 * A student's own standing as the refused side of a conflict, as their
 * enrollment page and the verification checklist read it: still waiting for
 * staff, not confirmed, or confirmed and free to enroll. Pending outranks
 * rejected outranks confirmed — a student is blocked by any conflict nobody
 * has cleared.
 */
export function blockedStateOf(
  pairs: readonly PairConflict[],
  studentId: string,
): "pending" | "not_confirmed" | "confirmed" | null {
  const mine = pairs.filter((pair) => pair.blockedStudentId === studentId);
  if (mine.length === 0) return null;
  if (mine.some((pair) => pair.state === "pending")) return "pending";
  if (mine.some((pair) => pair.state === "rejected")) return "not_confirmed";
  return "confirmed";
}
