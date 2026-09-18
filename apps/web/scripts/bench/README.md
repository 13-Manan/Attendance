# `apps/web` benchmarks

Two independent harnesses. Results and interpretation live in
[`docs/BENCHMARKS.md`](../../../../docs/BENCHMARKS.md) — this file is only
about how to run them.

Neither touches a database, a network service, or a real face. Both write
into `results/`, which is committed: a benchmark whose output is not recorded
cannot be compared against later.

---

## 1. Recognition policy (`run.ts`)

```bash
cd apps/web
node --import ./scripts/register-test-loader.mjs scripts/bench/run.ts
# -> scripts/bench/results/results.json
# -> scripts/bench/results/report.md
```

`src/lib/env.ts` validates required environment variables at module load, so
the process needs `DATABASE_URL`, `AUTH_SECRET`, `API_KEY_PEPPER`,
`FACE_AI_SERVICE_URL`, `FACE_AI_SERVICE_TOKEN` and `LOCAL_AI_ENABLED` present.
Dummy values are fine — **no connection is ever opened**; the values only have
to parse. Do not source `.env.local` for this.

Takes about a minute. Everything is seeded (`mulberry32`), so two runs on the
same machine produce identical numbers; a diff in `results.json` means the
recognition code changed, which is the point.

### What it drives

The **real shipped functions** — `scoreFaceAgainstCandidates`,
`classifyBySimilarity`, `aggregateByStudent` — over **synthetic 512-d
embedding vectors**. There is no detector and no image anywhere in this
harness.

| File | Role |
| --- | --- |
| `synthetic.ts` | Embedding geometry: identity vectors, `vectorAtCosine`, condition penalties, quality regimes. Read this first — everything downstream inherits its assumptions. |
| `search-scale.ts` | Candidate-pool scaling, with pgvector **text parsing** timed separately from **scanning** because the two have different fixes. |
| `multi-image.ts` | The 1 vs 2 vs 3 experiment, plus the look-alike sweep. |
| `run.ts` | Orchestration, threshold sweep, Markdown emission. |

**This measures the decision policy, not a face model.** It can tell you which
thresholds are safe *given* an embedding quality; it cannot tell you what
quality a real model achieves. `QUALITY_REGIMES` in `synthetic.ts` is the
knob standing in for that, which is why every result is reported across all
four regimes rather than averaged into one number.

---

## 2. Frontend (`frontend.mjs`)

Plain `.mjs`, so it needs no TypeScript loader. Speaks the Chrome DevTools
Protocol directly over Node 26's global `WebSocket` — **no new dependency**.

```bash
# 1. production build (dev-mode numbers are meaningless)
npm run build --workspace=web
cd apps/web && npx next start -p 3100 &

# 2. an isolated Chrome, with its own profile
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9333 \
  --user-data-dir=/tmp/bench-chrome-profile \
  --no-first-run --no-default-browser-check &

# 3. measure
node scripts/bench/frontend.mjs --base http://127.0.0.1:3100 --cdp http://127.0.0.1:9333
# -> scripts/bench/results/frontend.json
```

Flags: `--base` (default `http://127.0.0.1:3100`), `--cdp` (default
`http://127.0.0.1:9333`), `--runs` (default `5`).

### Two things that are deliberate

**Its own Chrome, not the `chrome-devtools` MCP.** That MCP owns a single
profile directory and fails while any Chrome holds it. Closing somebody's
browser to take a measurement is not an acceptable trade, so this script
launches a separate instance under `/tmp`.

**A fresh browser context per run.** Each run gets its own
`Target.createBrowserContext`, therefore its own HTTP cache partition. An
earlier version shared one context and reported ~10 KB transfers — a
cache-hit benchmark wearing a performance benchmark's clothes. Byte counts
come from CDP `Network.loadingFinished.encodedDataLength` (what the socket
carried, headers included), not Resource Timing, and every row carries a
`servedFromCache` counter so a bad run is visible instead of flattering.

### Scope

Only routes that render without a database: `/`, `/login`, `/offline`,
`/unauthorized`. Everything under `/dashboard` and `/portal` needs a session
and a seeded pgvector Postgres. **The attendance processing state is
therefore unmeasured**, and it is the measurement that matters most — see the
gaps section of `docs/BENCHMARKS.md`.
