import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedStateOf, foldPairs, orderForQueue, pairKey, parsePairKey } from "./policy.ts";
import type { ConflictEvent, DecisionEvent } from "./types.ts";

/**
 * The pure rules of twin confirmations: how a pair is named, and how the audit
 * events about it fold into where it stands.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 9, minute));
const conflict = (id: string, blocked: string, matched: string, minute: number, channel: "SELF" | "STAFF" = "SELF"): ConflictEvent => ({
  id,
  blockedStudentId: blocked,
  matchedStudentId: matched,
  at: at(minute),
  channel,
});
const decision = (id: string, a: string, b: string, value: "confirmed" | "rejected", minute: number): DecisionEvent => ({
  id,
  pair: pairKey(a, b),
  decision: value,
  at: at(minute),
  byUserId: "reviewer",
});

test("a pair has one key, whichever student was being enrolled", () => {
  assert.equal(pairKey("stu-b", "stu-a"), "stu-a~stu-b");
  assert.equal(pairKey("stu-a", "stu-b"), "stu-a~stu-b");
});

test("a key parses back to its two students, and nothing else parses", () => {
  assert.deepEqual(parsePairKey("stu-a~stu-b"), ["stu-a", "stu-b"]);
  for (const junk of [
    "stu-b~stu-a", // unsorted: never written by this app
    "stu-a~stu-a", // one student twice
    "stu-a",
    "stu-a~stu-b~stu-c",
    "stu-a~",
    "~stu-b",
    "stu a~stu-b",
    "stu-a~stu-b'; drop",
    `${"x".repeat(70)}~stu-b`,
    undefined,
    42,
  ]) {
    assert.equal(parsePairKey(junk), null, String(junk));
  }
});

test("a conflict nobody has decided is pending; attempts and dates are counted", () => {
  const [pair] = foldPairs(
    [conflict("c1", "stu-b", "stu-a", 1), conflict("c2", "stu-b", "stu-a", 5, "STAFF")],
    [],
  );
  assert.deepEqual(
    [pair.pair, pair.state, pair.attempts, pair.blockedStudentId, pair.matchedStudentId, pair.lastChannel],
    ["stu-a~stu-b", "pending", 2, "stu-b", "stu-a", "STAFF"],
  );
  assert.deepEqual([pair.firstDetectedAt, pair.lastDetectedAt], [at(1), at(5)]);
});

test("the latest decision is the pair's state — a later one changes it", () => {
  const conflicts = [conflict("c1", "stu-b", "stu-a", 1)];
  assert.equal(foldPairs(conflicts, [decision("d1", "stu-a", "stu-b", "confirmed", 2)])[0].state, "confirmed");
  assert.equal(
    foldPairs(conflicts, [
      decision("d1", "stu-a", "stu-b", "confirmed", 2),
      decision("d2", "stu-b", "stu-a", "rejected", 3),
    ])[0].state,
    "rejected",
    "a confirmation revoked",
  );
});

test("a retry after 'not confirmed' does not put the pair back in front of staff", () => {
  const [pair] = foldPairs(
    [conflict("c1", "stu-b", "stu-a", 1), conflict("c2", "stu-b", "stu-a", 9)],
    [decision("d1", "stu-a", "stu-b", "rejected", 5)],
  );
  assert.equal(pair.state, "rejected");
  assert.equal(pair.attempts, 2);
});

test("a decision applies to its own pair and no other", () => {
  const pairs = foldPairs(
    [conflict("c1", "stu-b", "stu-a", 1), conflict("c2", "stu-b", "stu-c", 2)],
    [decision("d1", "stu-a", "stu-b", "confirmed", 3)],
  );
  const state = Object.fromEntries(pairs.map((pair) => [pair.pair, pair.state]));
  assert.deepEqual(state, { "stu-a~stu-b": "confirmed", "stu-b~stu-c": "pending" });
});

test("a decision about a pair that never collided is ignored, and so is a student matched with themselves", () => {
  assert.deepEqual(foldPairs([conflict("c1", "stu-a", "stu-a", 1)], [decision("d1", "stu-x", "stu-y", "confirmed", 2)]), []);
});

test("the queue: pending first, newest first; then decided, most recent decision first", () => {
  const items = [
    { id: "old-pending", state: "pending", lastDetectedAt: at(1), decidedAt: null },
    { id: "decided-early", state: "confirmed", lastDetectedAt: at(2), decidedAt: at(3) },
    { id: "new-pending", state: "pending", lastDetectedAt: at(8), decidedAt: null },
    { id: "decided-late", state: "rejected", lastDetectedAt: at(2), decidedAt: at(9) },
  ];
  const { pending, decided } = orderForQueue(items);
  assert.deepEqual(pending.map((item) => item.id), ["new-pending", "old-pending"]);
  assert.deepEqual(decided.map((item) => item.id), ["decided-late", "decided-early"]);
});

test("a student is blocked by any conflict nobody has cleared", () => {
  const pairs = foldPairs(
    [conflict("c1", "stu-b", "stu-a", 1), conflict("c2", "stu-b", "stu-c", 2), conflict("c3", "stu-d", "stu-a", 3)],
    [decision("d1", "stu-a", "stu-b", "confirmed", 4), decision("d2", "stu-a", "stu-d", "rejected", 5)],
  );
  assert.equal(blockedStateOf(pairs, "stu-b"), "pending", "one pair confirmed, the other still waiting");
  assert.equal(blockedStateOf(pairs, "stu-d"), "not_confirmed");
  assert.equal(blockedStateOf(pairs, "stu-a"), null, "the matched side is not blocked");
  const cleared = foldPairs([conflict("c1", "stu-b", "stu-a", 1)], [decision("d1", "stu-a", "stu-b", "confirmed", 4)]);
  assert.equal(blockedStateOf(cleared, "stu-b"), "confirmed");
});
