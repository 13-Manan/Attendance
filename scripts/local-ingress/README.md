# Local ingress harness

**Test infrastructure. Nothing here is deployed, and no application code
depends on it.** Production ingress is Azure Container Apps
(`infra/azure/modules/app.bicep`), which this directory does not touch.

It exists to answer one question that a single process cannot:

> When the instance serving a browser's SSE stream is destroyed, does the
> browser reconnect **to a different instance**, get re-authorized there, and
> reconcile authoritative state?

## Topology

```
browser ──▶ 127.0.0.1:3100  nginx
                 ├──▶ 127.0.0.1:3101  instance A  (primary)
                 └──▶ 127.0.0.1:3102  instance B  (backup)
            both ──▶ 127.0.0.1:5433  the one local Postgres
```

A and B are two real `node .next/standalone/apps/web/server.js` processes.
Nothing is simulated in-process.

## Usage

```bash
npm run build --workspace=web          # standalone output must exist
cp -R apps/web/.next/static  apps/web/.next/standalone/apps/web/.next/static
cp -R apps/web/public        apps/web/.next/standalone/apps/web/public

./scripts/local-ingress/run.sh start both
./scripts/local-ingress/run.sh kill-a     # terminate A; reconnects must land on B
./scripts/local-ingress/run.sh routing    # who served what
./scripts/local-ingress/run.sh stop
```

`ATTENDANCE_ENV_FILE` points at the env to source (default `/tmp/smoke-env.sh`).
The script **refuses to start** unless `DATABASE_URL` is the local 5433 cluster.

## How routing is proven

Two independent signals, neither of which the application produces:

1. `X-Upstream-Instance` — added by nginx from `$upstream_addr`, readable in
   DevTools. Test-only, carries an address the operator already knows.
2. `/tmp/attendance-ingress/routing.log` — one line per request with the
   upstream that served it. A long-lived SSE stream is logged when it
   *closes*, so a failover appears as `-> 127.0.0.1:3101, 127.0.0.1:3102`:
   tried the dead primary, served by the backup.

`backup` on B is what makes this evidence rather than coincidence — while A is
alive every request goes to A, so a connection on B can only be a failover.
Reverse the direction by running `start b` alone.

## Two gotchas this harness encodes

Both cost real debugging time; both are written into `nginx.conf` so they are
not rediscovered.

**1. Forward `$http_host`, not `$host`.** `$host` drops the port, so the
instance saw `Host: localhost` while the browser's `Origin` was
`localhost:3100`. Next.js then correctly refuses every Server Action:

```
`x-forwarded-host` header with value `localhost` does not match
`origin` header with value `localhost:3100`. Aborting the action.
```

The fix is to forward the Host the browser sent. **Do not** solve this by
disabling origin validation.

**2. `SIGTERM` does not disconnect SSE clients.** Next.js stops accepting new
connections but keeps existing streams alive, so a politely-killed instance
still serves the browser — and a failover test silently proves nothing.
`run.sh` uses `kill -9` against *every* node process holding the port,
including one that is draining.

## Timeouts

`proxy_read_timeout` / `proxy_send_timeout` are **75s**: five server heartbeats
(15s) and comfortably past the client's 40s silence watchdog. Long enough that
the proxy never cuts a healthy stream, short enough that a dead upstream is
released. An unbounded timeout would hide the very failure this harness exists
to observe.

## What this is not

Local nginx is **not** Azure Container Apps ingress. It demonstrates that the
application's reconnect-and-reconcile design survives a genuine instance
replacement behind a genuine reverse proxy. It does not establish how Azure's
ingress drains connections during a revision swap, which remains untested.
