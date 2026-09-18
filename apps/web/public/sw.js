/**
 * Service worker: the app shell, and nothing else.
 *
 * ## What this is for
 *
 * One job. Next's own offline handling keeps a *soft navigation* pending until
 * the network returns, but a hard reload — the tab was closed, the tablet was
 * restarted, the teacher tapped the home-screen icon — needs the browser to
 * fetch HTML, and with no network there is nothing to fetch. That is the gap
 * this fills: a reload with no connection lands on `/offline`, which reads the
 * rosters and queued registers out of IndexedDB and works exactly as it did
 * before the reload.
 *
 * ## What it will not cache, and why that rule has not moved
 *
 * **No authenticated HTML. No API responses. No personal data.** Almost every
 * page in this app is somebody's attendance record, and the devices it runs on
 * are shared — a classroom tablet passed between teachers, a lab machine. A
 * Cache Storage entry outlives the session cookie and is *not* cleared by
 * logging out, so a cached `/portal` or review board is a student's attendance
 * left on disk for the next person who opens the app. That is a worse failure
 * than a slow first paint, and it is still true now that this worker does real
 * work.
 *
 * So the cache holds exactly three kinds of thing, all of them identical for
 * every user of this deployment:
 *
 * - hashed build output under `/_next/static/` (immutable by construction),
 * - icons and the manifest,
 * - the `/offline` shell, which is a static page with no server data in it.
 *
 * `/offline` is safe to cache precisely because it renders nothing from the
 * server. The rosters and registers it displays come from IndexedDB, which is
 * cleared on sign-out.
 *
 * ## What it does not intercept
 *
 * Everything else — every authenticated page, every Server Action, every call
 * to `/api/*` including the sync endpoint. Those requests reach the network
 * untouched, or fail, and failing is the signal the sync queue is built to
 * act on. A worker that quietly answered a sync POST from a cache would be a
 * worker that reported attendance as synced when it was not.
 */

const CACHE_VERSION = "v1";
const SHELL_CACHE = `attendance-shell-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline";

const PRECACHE_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/apple-touch-icon.png",
];

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);

      // Precache the shell, then the build assets that shell actually needs.
      //
      // Caching the HTML alone is not enough and is the classic way this goes
      // wrong: the page is served from cache, asks for its hashed JavaScript
      // chunks, and those are not there — so the offline page renders as a
      // blank frame at the exact moment somebody needs it. Parsing the shell's
      // own <script src> and <link href> and caching those is what makes it
      // genuinely self-sufficient.
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: "reload", credentials: "omit" });
            if (response.ok) await cache.put(url, response.clone());
            if (url === OFFLINE_URL && response.ok) {
              await cacheShellAssets(cache, await response.text());
            }
          } catch {
            // A precache miss is not fatal: the install still completes and the
            // worker caches what it can at runtime. Failing install would leave
            // the app with no worker at all.
          }
        }),
      );
    })(),
  );
  // Take over as soon as this worker is ready rather than waiting for every
  // tab to close. The cache contents are static assets and a data-free shell,
  // so there is no half-migrated state for an early activation to expose.
  self.skipWaiting();
});

/**
 * Pulls the asset URLs out of the shell's HTML and caches the same-origin ones.
 *
 * A regex rather than a parser because a service worker has no DOM, and the
 * input is this application's own build output rather than arbitrary markup.
 */
async function cacheShellAssets(cache, html) {
  const urls = new Set();
  const pattern = /(?:src|href)="(\/_next\/static\/[^"]+)"/g;
  let match;
  while ((match = pattern.exec(html)) !== null) urls.add(match[1]);

  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const response = await fetch(url, { credentials: "omit" });
        if (response.ok) await cache.put(url, response.clone());
      } catch {
        // Same reasoning as above.
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions. Hashed asset names mean a stale
      // cache is never *wrong*, only wasteful — but on a school tablet with
      // little free space, wasteful eventually evicts an unsynced register,
      // and that is not a trade worth making.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("attendance-shell-") && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only GET. A POST is a mutation, and a service worker has no business
  // answering one from a cache.
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Never touch the API. The sync endpoint's failures are load-bearing.
  if (url.pathname.startsWith("/api/")) return;

  if (isCacheableAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkThenOfflineShell(request));
  }

  // Everything else falls through to the browser untouched, including RSC
  // payload requests — those carry personal data and must always be live.
});

function isCacheableAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/icons/") ||
    pathname === "/manifest.webmanifest"
  );
}

/**
 * Hashed and versioned assets: cache first, and populate on a miss.
 *
 * Safe because the filename contains a content hash — a cached entry can never
 * be a stale version of a different file, only an old file nothing references
 * any more.
 */
async function cacheFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

/**
 * Navigations: always the network, with the offline shell as the fallback.
 *
 * Network-*first* and never cache-first, and the response is never stored. A
 * dashboard page is somebody's attendance; the only thing that may be served
 * from disk here is the data-free shell.
 */
async function networkThenOfflineShell(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const shell = await cache.match(OFFLINE_URL);
    if (shell) return shell;
    // No shell cached yet — the worker installed on a page load that never
    // reached the network. An honest failure beats a fabricated page.
    return new Response(
      "Offline, and the offline page has not been downloaded yet. Reconnect once and reopen the app.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }
}
