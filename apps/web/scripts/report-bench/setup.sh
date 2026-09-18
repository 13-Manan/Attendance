#!/usr/bin/env bash
#
# Build a throwaway database with the real schema and enough synthetic
# attendance to make report query plans meaningful, then measure them.
#
#   ./scripts/report-bench/setup.sh          # create + seed + measure
#   BENCH_DB=other ./scripts/report-bench/setup.sh
#
# This never touches the development database. It creates its own, and
# `--drop` removes it again.
#
# One substitution is made to the generated DDL: FaceEmbedding.embedding is
# `vector(512)`, which needs the pgvector extension, and pgvector is only
# packaged for PostgreSQL 17+ while this machine runs 16. The column is
# created as `bytea` here instead. No report query touches that column or
# that table, so the substitution cannot affect a measurement — but it does
# mean this database is useless for anything involving face recognition.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BENCH_DB="${BENCH_DB:-attendance_bench}"
BENCH_URL="postgresql://$(whoami)@127.0.0.1:5432/${BENCH_DB}"

if [ "${1:-}" = "--drop" ]; then
  dropdb --if-exists "$BENCH_DB"
  echo "dropped $BENCH_DB"
  exit 0
fi

cd "$WEB_DIR"

echo "==> generating DDL from prisma/schema.prisma"
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script \
  | sed 's/"embedding" vector(512)/"embedding" bytea/' \
  > /tmp/attendance-bench-ddl.sql

echo "==> creating $BENCH_DB"
dropdb --if-exists "$BENCH_DB"
createdb "$BENCH_DB"
psql -q -d "$BENCH_DB" -v ON_ERROR_STOP=1 -f /tmp/attendance-bench-ddl.sql

echo "==> seeding"
psql -q -d "$BENCH_DB" -v ON_ERROR_STOP=1 -f "$WEB_DIR/scripts/report-bench/seed.sql"

echo "==> measuring"
DATABASE_URL="$BENCH_URL" node --import ./scripts/register-test-loader.mjs \
  ./scripts/report-bench/measure.ts
