#!/usr/bin/env bash
#
# Run the apps/web <-> services/face-ai integration tests against a real
# FastAPI process.
#
# The unit suites on both sides stub the other side, which is precisely the
# arrangement in which a wire contract drifts unnoticed. This script boots the
# service, points the Next.js test suite at it, and tears it down again.
#
# Backend: `mock` by default — a deterministic hash stub. This verifies the
# contract, the transport and the orchestration. It verifies NOTHING about
# recognition accuracy; that is what services/face-ai/bench/ measures.
#
#   ./scripts/integration-test.sh
#   FACE_AI_PORT=9000 ./scripts/integration-test.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$ROOT/services/face-ai"
PORT="${FACE_AI_PORT:-8099}"
BACKEND="${FACE_MODEL_BACKEND:-mock}"
BASE_URL="http://127.0.0.1:${PORT}"

# The documented path is the authenticated one.
#
# This script is the only place both halves of the system run together, so it is
# the only place that can prove apps/web actually presents the service token and
# face-ai actually accepts it. Running it unauthenticated would exercise the
# development fallback and leave the production configuration untested — which
# is how a deployment discovers its credential wiring is wrong.
#
# The value is ephemeral and local to this run; it is not a secret anyone holds.
SERVICE_TOKEN="${FACE_AI_AUTH_TOKEN:-integration-test-face-ai-token}"

if [ ! -x "$SERVICE_DIR/.venv/bin/uvicorn" ]; then
  echo "error: $SERVICE_DIR/.venv is missing or incomplete." >&2
  echo "       See services/face-ai/README.md for setup." >&2
  exit 1
fi

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "==> starting face-ai (backend=$BACKEND) on $BASE_URL"
# `exec` matters: without it $! is the subshell, and killing the subshell
# leaves uvicorn orphaned holding this script's stdout. If that stdout is a
# pipe (`./scripts/integration-test.sh | tail`), the reader then blocks
# forever on a script that has already exited — a hang that looks like a
# failing test suite and is not one.
(
  cd "$SERVICE_DIR"
  exec env FACE_MODEL_BACKEND="$BACKEND" \
    FACE_AI_AUTH_TOKEN="$SERVICE_TOKEN" \
    FACE_AI_REQUIRE_AUTH=true \
    .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "$PORT" --log-level warning
) &
SERVER_PID=$!

# Poll rather than sleep: model load time varies by backend, and a fixed sleep
# either wastes seconds or produces a flaky connection-refused failure.
echo "==> waiting for /v1/health"
for _ in $(seq 1 60); do
  if curl -fsS "$BASE_URL/v1/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "error: face-ai exited during startup (check the licensing guard and backend config)" >&2
    exit 1
  fi
  sleep 0.5
done

if [ "${READY:-}" != "1" ]; then
  echo "error: face-ai did not become healthy within 30s" >&2
  exit 1
fi

# /v1/health above needs no credential — it is a liveness probe. /v1/model-info
# does, because it names the backend and its licensing posture.
curl -fsS -H "Authorization: Bearer $SERVICE_TOKEN" "$BASE_URL/v1/model-info"
echo

echo "==> running the web test suite with integration tests enabled"
cd "$ROOT"
FACE_AI_INTEGRATION=1 \
  FACE_AI_SERVICE_URL="$BASE_URL" \
  FACE_AI_SERVICE_TOKEN="$SERVICE_TOKEN" \
  DATABASE_URL="${DATABASE_URL:-postgresql://integration:integration@127.0.0.1:5432/unused}" \
  AUTH_SECRET="${AUTH_SECRET:-integration-test-auth-secret}" \
  API_KEY_PEPPER="${API_KEY_PEPPER:-integration-test-api-key-pepper}" \
  npm test --workspace=web
