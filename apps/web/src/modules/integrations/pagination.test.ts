import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildPage,
  decodeCursor,
  encodeCursor,
  prismaPageArgs,
  readPageRequest,
} from "./pagination.ts";
import { ApiError } from "./api-route.ts";

function url(query: string): URL {
  return new URL(`https://x.test/api/v1/students${query}`);
}

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `stu-${i}` }));

// ---------------------------------------------------------------------------
// limit
// ---------------------------------------------------------------------------

test("an absent limit uses the default", () => {
  assert.equal(readPageRequest(url("")).limit, DEFAULT_PAGE_SIZE);
});

test("a valid limit is honoured", () => {
  assert.equal(readPageRequest(url("?limit=25")).limit, 25);
});

test("an out-of-range limit is clamped, not rejected", () => {
  assert.equal(readPageRequest(url("?limit=100000")).limit, MAX_PAGE_SIZE);
  assert.equal(readPageRequest(url("?limit=0")).limit, 1);
  assert.equal(readPageRequest(url("?limit=-5")).limit, 1);
});

test("a limit mangled by a templating bug falls back silently rather than stalling a 2am sync", () => {
  for (const raw of ["abc", "", "{{limit}}", "NaN", "Infinity"]) {
    const request = readPageRequest(url(`?limit=${encodeURIComponent(raw)}`));
    assert.equal(request.limit, DEFAULT_PAGE_SIZE, `${raw} should fall back`);
  }
});

test("a fractional limit floors instead of producing a fractional take", () => {
  assert.equal(readPageRequest(url("?limit=25.9")).limit, 25);
});

// ---------------------------------------------------------------------------
// cursor
// ---------------------------------------------------------------------------

test("no cursor means the first page", () => {
  assert.equal(readPageRequest(url("")).cursorId, null);
});

test("a cursor we issued round-trips", () => {
  const cursor = encodeCursor("clx9f2a0000abcdef");
  assert.equal(decodeCursor(cursor), "clx9f2a0000abcdef");
  assert.equal(readPageRequest(url(`?cursor=${cursor}`)).cursorId, "clx9f2a0000abcdef");
});

test("a malformed cursor is an error, never a silent restart from row one", () => {
  // Silently restarting would re-import the entire roster while the client
  // reported success — the failure this module exists to prevent.
  for (const raw of ["not-a-cursor!!", encodeCursor("id with spaces"), encodeCursor("x".repeat(200)), "%%%"]) {
    assert.throws(
      () => decodeCursor(raw),
      (error: unknown) => error instanceof ApiError && error.code === "invalid_request",
      `${raw.slice(0, 16)} should be rejected`,
    );
  }
});

test("a cursor carrying an injection attempt is rejected on shape", () => {
  assert.throws(() => decodeCursor(encodeCursor("' OR 1=1 --")));
});

// ---------------------------------------------------------------------------
// buildPage
// ---------------------------------------------------------------------------

test("a full page plus one signals more and never returns the extra row", () => {
  const page = buildPage(rows(11), { limit: 10, cursorId: null }, "req-1");
  assert.equal(page.data.length, 10);
  assert.equal(page.pagination.hasMore, true);
  assert.equal(page.data.at(-1)?.id, "stu-9");
  assert.equal(page.pagination.nextCursor, encodeCursor("stu-9"), "the cursor names the last returned row");
});

test("a short page is the last page and offers no cursor", () => {
  const page = buildPage(rows(3), { limit: 10, cursorId: null }, "req-1");
  assert.equal(page.pagination.hasMore, false);
  assert.equal(page.pagination.nextCursor, null);
});

test("an exactly-full page with no extra row is the last page", () => {
  const page = buildPage(rows(10), { limit: 10, cursorId: null }, "req-1");
  assert.equal(page.data.length, 10);
  assert.equal(page.pagination.hasMore, false);
  assert.equal(page.pagination.nextCursor, null);
});

test("an empty result is a valid last page, not an error", () => {
  const page = buildPage([], { limit: 10, cursorId: null }, "req-1");
  assert.deepEqual(page.data, []);
  assert.equal(page.pagination.hasMore, false);
  assert.equal(page.pagination.nextCursor, null);
});

test("the page echoes the effective limit and the request id", () => {
  const page = buildPage(rows(2), { limit: 7, cursorId: null }, "req-42");
  assert.equal(page.pagination.limit, 7);
  assert.equal(page.requestId, "req-42");
});

// ---------------------------------------------------------------------------
// Prisma arguments
// ---------------------------------------------------------------------------

test("the first page takes one extra row and uses no cursor", () => {
  assert.deepEqual(prismaPageArgs({ limit: 50, cursorId: null }), { take: 51 });
});

test("a subsequent page skips the cursor row, so page boundaries are not duplicated", () => {
  assert.deepEqual(prismaPageArgs({ limit: 50, cursorId: "stu-9" }), {
    take: 51,
    cursor: { id: "stu-9" },
    skip: 1,
  });
});

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

test("walking with the issued cursors visits every row exactly once", () => {
  const all = rows(25);
  const seen: string[] = [];
  let cursorId: string | null = null;

  for (let guard = 0; guard < 10; guard += 1) {
    const request = { limit: 10, cursorId };
    const args = prismaPageArgs(request);
    const start = cursorId ? all.findIndex((row) => row.id === cursorId) + 1 : 0;
    const page = buildPage(all.slice(start, start + args.take), request, "req");

    seen.push(...page.data.map((row) => row.id));
    if (!page.pagination.nextCursor) break;
    cursorId = decodeCursor(page.pagination.nextCursor);
  }

  assert.equal(seen.length, 25);
  assert.equal(new Set(seen).size, 25, "no row is returned twice");
  assert.deepEqual(seen, all.map((row) => row.id));
});
