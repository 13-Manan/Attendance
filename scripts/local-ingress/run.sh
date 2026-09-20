#!/usr/bin/env bash
# Phase 17 test harness: two real app instances behind a local nginx ingress,
# both on the one local Postgres. TEST ONLY — see nginx.conf.
#
#   ./scripts/local-ingress/run.sh start [a|b|both]
#   ./scripts/local-ingress/run.sh kill-a | kill-b      (hard, incl. draining)
#   ./scripts/local-ingress/run.sh stop
#   ./scripts/local-ingress/run.sh routing              (who served what)
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB="$HERE/../../apps/web"
RUN=/tmp/attendance-ingress
CONF="$HERE/nginx.conf"

# The instances need the same environment a developer's shell has. Sourced
# here rather than inherited, because each instance is spawned in its own
# subshell and would otherwise fail env validation at boot.
ENV_FILE="${ATTENDANCE_ENV_FILE:-/tmp/smoke-env.sh}"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
else
  echo "no env file at $ENV_FILE (set ATTENDANCE_ENV_FILE)"; exit 1
fi

# Refuse to run against anything but the local development database.
case "${DATABASE_URL:-}" in
  *127.0.0.1:5433*|*localhost:5433*) : ;;
  *) echo "REFUSING: DATABASE_URL is not the local dev cluster: ${DATABASE_URL:-unset}"; exit 1 ;;
esac

# A hard kill that also takes draining processes. Next.js keeps existing SSE
# streams alive across SIGTERM (it stops accepting, but does not hang up), so a
# polite kill leaves the browser still connected to a "terminated" instance —
# which silently invalidates a failover test.
hard_kill_port() {
  lsof -nP -iTCP:"$1" 2>/dev/null | awk 'NR>1 && $1=="node" {print $2}' | sort -u | xargs kill -9 2>/dev/null
}

start_instance() {
  local port=$1 name=$2
  hard_kill_port "$port"
  ( cd "$WEB" && PORT="$port" NODE_ENV=production \
      nohup node .next/standalone/apps/web/server.js > "$RUN/instance-$name.log" 2>&1 & ) </dev/null >/dev/null 2>&1
}

case "${1:-}" in
  start)
    mkdir -p "$RUN"
    case "${2:-both}" in
      a)    start_instance 3101 A ;;
      b)    start_instance 3102 B ;;
      both) start_instance 3101 A; start_instance 3102 B ;;
    esac
    sleep 13
    nginx -c "$CONF" 2>/dev/null || nginx -s reload -c "$CONF" 2>/dev/null
    sleep 2
    echo "ingress :3100  A :3101=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3101/login)  B :3102=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3102/login)"
    ;;
  kill-a) hard_kill_port 3101; echo "A terminated" ;;
  kill-b) hard_kill_port 3102; echo "B terminated" ;;
  stop)
    nginx -s quit -c "$CONF" 2>/dev/null
    [ -f "$RUN/nginx.pid" ] && kill -9 "$(cat "$RUN/nginx.pid")" 2>/dev/null
    hard_kill_port 3101; hard_kill_port 3102
    echo "harness stopped"
    ;;
  routing) tail -n "${2:-20}" "$RUN/routing.log" ;;
  *) echo "usage: $0 {start [a|b|both]|kill-a|kill-b|stop|routing [n]}"; exit 1 ;;
esac
