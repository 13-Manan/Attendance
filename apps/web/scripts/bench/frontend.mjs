/**
 * FRONTEND — real browser measurements over the Chrome DevTools Protocol.
 *
 *   1. build and serve:  npm run build --workspace=web && npx next start -p 3100
 *   2. launch a browser that is NOT your daily one:
 *        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *          --headless=new --remote-debugging-port=9333 \
 *          --user-data-dir=/tmp/bench-chrome-profile \
 *          --no-first-run --no-default-browser-check
 *   3. node scripts/bench/frontend.mjs --base http://127.0.0.1:3100 --cdp http://127.0.0.1:9333
 *
 * ## Why this exists instead of the DevTools MCP
 *
 * The chrome-devtools MCP server owns a single profile directory and refuses
 * to attach when a Chrome is already using it. On this machine a Chrome
 * always is. Rather than close somebody's browser to take a measurement,
 * this script speaks CDP to a separate instance with its own
 * `--user-data-dir`. Node 26 ships a global `WebSocket`, so this costs no
 * dependency.
 *
 * ## What it can and cannot reach
 *
 * Every route under `/dashboard` and `/portal` requires a session, and a
 * session requires a seeded database. There is no pgvector-capable Postgres
 * in this environment (`docker` is not installed, and building pgvector from
 * source is out of scope), so those pages cannot be loaded at all. This
 * script therefore measures the routes that render without a database —
 * `/`, `/login`, `/offline`, `/unauthorized` — and reports them as what they
 * are: the shell, the framework runtime and the shared client bundle that
 * every other page also pays for, measured honestly, rather than an estimate
 * of a page nobody here can open.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "results");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = arg("base", "http://127.0.0.1:3100");
const CDP = arg("cdp", "http://127.0.0.1:9333");
const ROUTES = ["/", "/login", "/offline", "/unauthorized"];
const RUNS = Number(arg("runs", "5"));

/**
 * Two device profiles.
 *
 * The mobile one throttles the CPU 4x and shapes the network to roughly a
 * mid-tier phone on mobile data. Faculty take attendance on a phone in a
 * classroom, so an unthrottled localhost number would be the least
 * representative measurement available.
 */
const PROFILES = {
  desktop: {
    cpuThrottle: 1,
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
    network: null,
  },
  mobile: {
    cpuThrottle: 4,
    viewport: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
    network: {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    },
  },
};

/** A minimal CDP client: one WebSocket, id-matched replies, event listeners. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      const handlers = this.listeners.get(msg.method);
      if (handlers) for (const h of handlers) h(msg.params);
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)), {
        once: true,
      });
    });
    return new Cdp(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  once(method) {
    return new Promise((resolve) => {
      const handler = (params) => {
        const list = this.listeners.get(method);
        list.splice(list.indexOf(handler), 1);
        resolve(params);
      };
      this.on(method, handler);
    });
  }

  close() {
    this.ws.close();
  }
}

/**
 * One cold navigation.
 *
 * The cache is disabled and the target is a fresh tab each time, because a
 * warm-cache reload measures the second visit — and the measurement that
 * decides whether faculty keep using the product is the first one.
 */
async function measure(cdp, url, profile) {
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  // Per-target cache disabling is not enough: the HTTP cache is shared by
  // the whole browser, so without this the second run of any route reports
  // near-zero bytes and the numbers quietly become a cache-hit benchmark.
  await cdp.send("Network.clearBrowserCache");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuThrottle });
  await cdp.send("Emulation.setDeviceMetricsOverride", profile.viewport);
  if (profile.network) {
    await cdp.send("Network.emulateNetworkConditions", profile.network);
  }

  // LCP is only observable through a PerformanceObserver — there is no
  // `getEntriesByType('largest-contentful-paint')` buffer to read after the
  // fact. The observer has to be installed before any document script runs,
  // which is what `addScriptToEvaluateOnNewDocument` is for.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__lcp = null;
      window.__cls = 0;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__lcp = e.startTime;
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            if (!e.hadRecentInput) window.__cls += e.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {}
    `,
  });

  // Byte accounting from the protocol rather than from Resource Timing.
  // `encodedDataLength` is what the socket actually carried, headers
  // included; Resource Timing's `transferSize` reports 0 for anything the
  // browser served out of a cache, which is exactly the case this benchmark
  // must not silently report as "fast".
  const bytesByType = new Map();
  let cdpEncoded = 0;
  let cdpRequests = 0;
  let servedFromCache = 0;
  const typeOf = new Map();
  cdp.on("Network.responseReceived", (p) => typeOf.set(p.requestId, p.type));
  cdp.on("Network.requestServedFromCache", () => servedFromCache++);
  cdp.on("Network.loadingFinished", (p) => {
    cdpRequests++;
    const n = p.encodedDataLength ?? 0;
    cdpEncoded += n;
    const t = typeOf.get(p.requestId) ?? "Other";
    bytesByType.set(t, (bytesByType.get(t) ?? 0) + n);
  });

  const loaded = cdp.once("Page.loadEventFired");
  await cdp.send("Page.navigate", { url });
  await loaded;

  // Give paint metrics a moment to settle — LCP in particular is only final
  // once the page stops changing.
  await new Promise((r) => setTimeout(r, 600));

  const { result } = await cdp.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paints = {};
      for (const p of performance.getEntriesByType('paint')) paints[p.name] = p.startTime;

      // Resource Timing is the authoritative byte source here: it counts the
      // document itself plus every subresource, and reports compressed
      // (transferSize) and uncompressed (decodedBodySize) separately, which
      // is the difference between "what the network carried" and "what the
      // phone had to parse".
      const resources = performance.getEntriesByType('resource');
      let transfer = nav.transferSize ?? 0;
      let decoded = nav.decodedBodySize ?? 0;
      let scriptTransfer = 0;
      let scriptDecoded = 0;
      for (const r of resources) {
        transfer += r.transferSize ?? 0;
        decoded += r.decodedBodySize ?? 0;
        if (r.initiatorType === 'script' || /\\.js(\\?|$)/.test(r.name)) {
          scriptTransfer += r.transferSize ?? 0;
          scriptDecoded += r.decodedBodySize ?? 0;
        }
      }

      return {
        ttfbMs: nav.responseStart ?? null,
        domContentLoadedMs: nav.domContentLoadedEventEnd ?? null,
        loadMs: nav.loadEventEnd ?? null,
        firstPaintMs: paints['first-paint'] ?? null,
        firstContentfulPaintMs: paints['first-contentful-paint'] ?? null,
        largestContentfulPaintMs: window.__lcp,
        cumulativeLayoutShift: window.__cls,
        domNodes: document.getElementsByTagName('*').length,
        requests: resources.length + 1,
        transferBytes: transfer,
        decodedBytes: decoded,
        scriptTransferBytes: scriptTransfer,
        scriptDecodedBytes: scriptDecoded,
      };
    })()`,
  });

  return {
    ...result.value,
    cdpRequests,
    servedFromCache,
    transferBytes: cdpEncoded,
    scriptTransferBytes: bytesByType.get("Script") ?? 0,
    documentTransferBytes: bytesByType.get("Document") ?? 0,
    stylesheetTransferBytes: bytesByType.get("Stylesheet") ?? 0,
  };
}

function avgKb(runs, key) {
  return Number((runs.reduce((a, r) => a + (r[key] ?? 0), 0) / runs.length / 1024).toFixed(1));
}

function summarise(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length === 0) return null;
  const sorted = clean.slice().sort((a, b) => a - b);
  return {
    mean: Number((sorted.reduce((a, b) => a + b, 0) / sorted.length).toFixed(1)),
    p50: Number(sorted[Math.floor(sorted.length / 2)].toFixed(1)),
    p95: Number(sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)].toFixed(1)),
  };
}

async function main() {
  const versionRes = await fetch(`${CDP}/json/version`);
  if (!versionRes.ok) throw new Error(`no CDP endpoint at ${CDP}`);
  const version = await versionRes.json();
  console.log(`browser: ${version.Browser}`);
  console.log(`target:  ${BASE}`);

  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const wsBase = version.webSocketDebuggerUrl.replace(/\/devtools\/browser\/.*$/, "");

  const results = [];

  for (const [profileName, profile] of Object.entries(PROFILES)) {
    for (const route of ROUTES) {
      const runs = [];
      for (let i = 0; i < RUNS; i++) {
        // A fresh *browser context* per run, not just a fresh tab. A tab
        // shares the HTTP cache with every other tab, so a second visit to
        // any route would be measured warm; an isolated context has its own
        // cache partition and makes every run a genuine first visit.
        const { browserContextId } = await browser.send("Target.createBrowserContext");
        const { targetId } = await browser.send("Target.createTarget", {
          url: "about:blank",
          browserContextId,
        });
        const cdp = await Cdp.connect(`${wsBase}/devtools/page/${targetId}`);
        try {
          runs.push(await measure(cdp, `${BASE}${route}`, profile));
        } finally {
          cdp.close();
          await browser.send("Target.closeTarget", { targetId });
          await browser.send("Target.disposeBrowserContext", { browserContextId });
        }
      }

      const row = {
        profile: profileName,
        route,
        runs: runs.length,
        ttfbMs: summarise(runs.map((r) => r.ttfbMs)),
        firstContentfulPaintMs: summarise(runs.map((r) => r.firstContentfulPaintMs)),
        largestContentfulPaintMs: summarise(runs.map((r) => r.largestContentfulPaintMs)),
        domContentLoadedMs: summarise(runs.map((r) => r.domContentLoadedMs)),
        loadMs: summarise(runs.map((r) => r.loadMs)),
        cumulativeLayoutShift: Number(
          (runs.reduce((a, r) => a + (r.cumulativeLayoutShift ?? 0), 0) / runs.length).toFixed(
            4,
          ),
        ),
        requests: Math.round(runs.reduce((a, r) => a + r.cdpRequests, 0) / runs.length),
        servedFromCache: Math.round(
          runs.reduce((a, r) => a + r.servedFromCache, 0) / runs.length,
        ),
        transferKb: avgKb(runs, "transferBytes"),
        decodedKb: avgKb(runs, "decodedBytes"),
        scriptTransferKb: avgKb(runs, "scriptTransferBytes"),
        scriptDecodedKb: avgKb(runs, "scriptDecodedBytes"),
        domNodes: Math.round(runs.reduce((a, r) => a + r.domNodes, 0) / runs.length),
      };
      results.push(row);
      console.log(
        `  ${profileName.padEnd(7)} ${route.padEnd(14)} ` +
          `TTFB ${String(row.ttfbMs?.p50 ?? "-").padStart(7)}ms  ` +
          `FCP ${String(row.firstContentfulPaintMs?.p50 ?? "-").padStart(7)}ms  ` +
          `LCP ${String(row.largestContentfulPaintMs?.p50 ?? "-").padStart(7)}ms  ` +
          `${String(row.requests).padStart(3)} req  ` +
          `${String(row.transferKb).padStart(7)} KB over the wire ` +
          `(${row.scriptTransferKb} KB js, ${row.decodedKb} KB decoded)`,
      );
    }
  }

  browser.close();

  mkdirSync(OUT_DIR, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    browser: version.Browser,
    base: BASE,
    runsPerRoute: RUNS,
    note:
      "Only routes that render without a database. /dashboard/* and /portal/* need a " +
      "session and a seeded pgvector Postgres, which this environment does not have.",
    profiles: PROFILES,
    results,
  };
  writeFileSync(join(OUT_DIR, "frontend.json"), `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${join(OUT_DIR, "frontend.json")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
