import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "Every protected route must enforce authorization server-side."
 *
 * The way that requirement usually rots is not by someone deleting a check —
 * it is by someone adding a page. A new file under `src/app` ships a new URL,
 * and nothing about writing it forces a thought about who may open it. Hiding
 * its link in the sidebar feels like enough and is not: the URL is still
 * there, and typing it is not an exploit.
 *
 * So this test reads the route tree off disk rather than trusting a list. A
 * page counts as protected if it calls an auth function itself, or if any
 * layout above it does — which is how `/dashboard/**` is actually secured, by
 * `requireUser()` in `dashboard/layout.tsx`. Anything else has to be named in
 * the allowlists below, with a reason, by a person.
 *
 * What this does NOT check is whether the permission chosen is the right one;
 * that is what `security.test.ts` and each module's own tests are for. This
 * checks that a decision was made at all.
 */

const APP_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Calls that establish a server-side identity. `getCurrentUser` is included
 * because routes that answer non-browser callers use it and turn `null` into
 * a 401 rather than a redirect — both are enforcement, they differ in how
 * they report failure.
 */
const AUTH_MARKERS = [
  "requireUser(",
  "requirePermissionOrRedirect(",
  "requirePermission(",
  "getCurrentUser(",
];

/** The API surface authenticates by key, through one wrapper, by design. */
const API_MARKERS = [...AUTH_MARKERS, "apiRoute(", "notImplementedRoute("];

/**
 * Pages that are deliberately reachable signed-out. Each is here because it
 * renders nothing belonging to anybody.
 */
const PUBLIC_PAGES = new Map([
  ["page.tsx", "The marketing/landing page: static copy, no data."],
  ["login/page.tsx", "The sign-in form itself — requiring a session would be a loop."],
  ["unauthorized/page.tsx", "The 403 destination; it is what a failed check redirects to."],
  [
    "offline/page.tsx",
    "Must render with no server round-trip, so the service worker can cache it. Renders only this browser's own IndexedDB, and grants nothing: queued work is still authorized on sync.",
  ],
]);

/** Route handlers that answer without a caller identity, and why. */
const PUBLIC_ROUTES = new Map([
  [
    join("api", "health", "route.ts"),
    "Container liveness probe. Returns a constant; deliberately touches neither Prisma nor env.",
  ],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const ALL_FILES = walk(APP_DIR);
const rel = (file: string) => relative(APP_DIR, file).split(sep).join("/");
const read = (file: string) => readFileSync(file, "utf8");
const mentions = (source: string, markers: string[]) =>
  markers.some((marker) => source.includes(marker));

/** Every layout.tsx from `src/app` down to the file's own directory. */
function ancestorLayouts(file: string): string[] {
  const layouts: string[] = [];
  let dir = dirname(file);
  for (;;) {
    const layout = join(dir, "layout.tsx");
    if (ALL_FILES.includes(layout)) layouts.push(layout);
    if (dir === APP_DIR) break;
    dir = dirname(dir);
  }
  return layouts;
}

const PAGES = ALL_FILES.filter((file) => file.endsWith(`${sep}page.tsx`));
const ROUTES = ALL_FILES.filter((file) => file.endsWith(`${sep}route.ts`));

test("the route tree was actually found", () => {
  // A path change that silently made this scan an empty directory would turn
  // every assertion below into a test that passes by doing nothing.
  assert.ok(PAGES.length > 20, `only found ${PAGES.length} pages`);
  assert.ok(ROUTES.length > 20, `only found ${ROUTES.length} route handlers`);
});

test("every page is protected by itself or by a layout above it", () => {
  const unprotected: string[] = [];

  for (const page of PAGES) {
    const path = rel(page);
    if (PUBLIC_PAGES.has(path)) continue;

    const sources = [page, ...ancestorLayouts(page)].map(read);
    if (!sources.some((source) => mentions(source, AUTH_MARKERS))) unprotected.push(path);
  }

  assert.deepEqual(
    unprotected,
    [],
    `These pages enforce nothing server-side. Add an auth call, put them under a layout that has one, or — if they are genuinely public — add them to PUBLIC_PAGES with a reason:\n  ${unprotected.join("\n  ")}`,
  );
});

test("every route handler authenticates its caller", () => {
  const unprotected: string[] = [];

  for (const route of ROUTES) {
    const path = relative(APP_DIR, route);
    if (PUBLIC_ROUTES.has(path)) continue;
    if (!mentions(read(route), API_MARKERS)) unprotected.push(rel(route));
  }

  assert.deepEqual(
    unprotected,
    [],
    `These route handlers accept a request without establishing who is asking:\n  ${unprotected.join("\n  ")}`,
  );
});

test("a path segment named 'internal' is not treated as a control", () => {
  // It is documentation. app/api/** compiles into the same public router as
  // everything else, so /api/internal/... is served to whoever types it.
  const internal = ROUTES.filter((route) => rel(route).includes("api/internal/"));
  assert.ok(internal.length > 0, "expected at least one route under api/internal");

  for (const route of internal) {
    assert.ok(
      mentions(read(route), AUTH_MARKERS),
      `${rel(route)} relies on its URL to keep people out`,
    );
  }
});

test("the public allowlists stay small and current", () => {
  // Every entry must still exist — an allowlist naming a deleted file is an
  // exemption waiting to be silently inherited by a new one at that path.
  for (const path of PUBLIC_PAGES.keys()) {
    assert.ok(
      PAGES.some((page) => rel(page) === path),
      `PUBLIC_PAGES names ${path}, which no longer exists`,
    );
  }
  for (const path of PUBLIC_ROUTES.keys()) {
    assert.ok(
      ROUTES.some((route) => relative(APP_DIR, route) === path),
      `PUBLIC_ROUTES names ${path}, which no longer exists`,
    );
  }

  // Not a style rule: each exemption is a URL anybody on the internet can
  // open, and a list that grows without anyone noticing is how the first
  // accidental one arrives.
  assert.ok(PUBLIC_PAGES.size <= 6, `${PUBLIC_PAGES.size} public pages is more than expected`);
  assert.ok(PUBLIC_ROUTES.size <= 2, `${PUBLIC_ROUTES.size} public routes is more than expected`);
});

test("nothing under /dashboard or /portal is exempt", () => {
  // These two trees are the signed-in product. An exemption inside either is
  // never the right fix, whatever the page does.
  for (const path of PUBLIC_PAGES.keys()) {
    assert.ok(
      !path.startsWith("dashboard/") && !path.startsWith("portal/"),
      `${path} is exempt but lives in a signed-in area`,
    );
  }
});
