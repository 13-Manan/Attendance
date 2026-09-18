# Attendance Platform

School & college face-recognition attendance management, where the
recognition is **advisory** and a faculty member owns every final result.
See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the system design and
[`docs/`](docs/) for data model, API contracts, multi-tenancy, and ADRs.

> No face recognition model here is cleared for commercial use.
> **License verification required before production deployment** — see
> [`services/face-ai/app/models/LICENSING.md`](services/face-ai/app/models/LICENSING.md)
> and ADR-0006.

## Prerequisites

- Node.js 20+ (developed against Node 26)
- Docker Desktop or Colima (for local Postgres+pgvector — dev only, see
  `docker-compose.yml`)
- Python 3.11+ for `services/face-ai` (a version manager like `pyenv` is
  recommended if your system Python is older)

## Repo layout

```
apps/web/            Next.js app — UI, API routes, Prisma/Postgres access
services/face-ai/     FastAPI service — stateless face detection/embedding
packages/shared-types/  TypeScript types shared at API boundaries
docs/                 Architecture documentation and ADRs
infra/                Placeholder — no deployment config yet
```

## Setup

```bash
npm install                     # installs all workspaces
cp .env.example .env            # for docker-compose / Prisma CLI
cp .env.example apps/web/.env.local   # for the Next.js app at runtime
```

### Local database

The schema declares a `vector(512)` column, so **Postgres must have the
pgvector extension available** — a stock Homebrew/apt Postgres does not, and
`prisma migrate` will fail against one with `type "vector" does not exist`.
Two supported ways:

```bash
docker compose up -d postgres          # pgvector/pgvector:pg16 — recommended
```

or, with an existing Homebrew Postgres, install pgvector built for *that*
major version (`brew install pgvector` ships builds for the current default
formula only; for `postgresql@16` build from source with
`PG_CONFIG=/opt/homebrew/opt/postgresql@16/bin/pg_config`). Verify before
migrating:

```bash
psql -d attendance -c "select * from pg_available_extensions where name='vector'"
```

Apply the schema. Because Prisma has no native vector type, the first
migration needs a hand-patch — see `docs/DATA_MODEL.md#pgvector`:

```bash
npm run prisma:migrate --workspace=web
```

Run the Next.js app:

```bash
npm run dev
# http://localhost:3000
# curl localhost:3000/api/health
```

Run the face AI service (separate terminal):

```bash
cd services/face-ai
python3.11 -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
uvicorn app.main:app --reload --port 8000
# curl localhost:8000/v1/health
```

## Verification (this phase)

```bash
npm run typecheck
npm run lint
npm run build
npx prisma validate --schema=apps/web/prisma/schema.prisma

npm test --workspace=web              # unit tests (hermetic: no DB, no network)
( cd services/face-ai && .venv/bin/pytest && .venv/bin/ruff check . )

./scripts/integration-test.sh         # boots face-ai, runs the web suite against it
```

Report query plans are measured separately, against a throwaway database of
synthetic attendance — the unit suite is hermetic and cannot see a plan:

```bash
cd apps/web
./scripts/report-bench/setup.sh          # create, seed (~480k records), measure
./scripts/report-bench/setup.sh --drop   # remove the scratch database
```

It never touches the development database. Read
[`docs/REPORTING.md`](docs/REPORTING.md#3-performance) before trusting a number
from it — in particular, it runs each query six times on purpose, because
PostgreSQL switches to a parameter-blind plan on the sixth execution and a
two-run benchmark measures the plan you will not be using.

The integration script starts `services/face-ai` on port 8099 with the
`mock` backend and re-runs the web suite with `FACE_AI_INTEGRATION=1`, which
un-skips the cross-service contract tests. It verifies the wire contract and
the orchestration — **not** recognition accuracy; that is what
[`services/face-ai/bench/`](services/face-ai/bench/README.md) measures, and
no benchmark has been run against a real dataset or a licensed model.

Performance and decision-policy measurements that *have* been taken — search
scaling, the 1 vs 2 vs 3 image question, a threshold sweep, service latency
and frontend page/network cost — are in
[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md), with the harnesses in
[`apps/web/scripts/bench/`](apps/web/scripts/bench/README.md) and
`services/face-ai/bench/perf.py`. Read its first section before quoting any
number: recognition accuracy on real faces remains unmeasured, and the report
says so rather than filling the gap with an estimate.

How a capture becomes an advisory attendance suggestion:
[`docs/RECOGNITION_ENGINE.md`](docs/RECOGNITION_ENGINE.md). How that advisory
becomes a register a faculty member confirms — and what the system refuses to
guess: [`docs/ATTENDANCE_ENGINE.md`](docs/ATTENDANCE_ENGINE.md).

## Using it

1. **Faculty** → Attendance → pick a class → (college: pick the subject) →
   Start attendance → capture 1–3 photos → Process.
2. The register is generated for **every enrolled student** and the session
   moves to review: `/dashboard/attendance/<cohortId>/review/<sessionId>`.
3. Resolve every Needs Review row, correct anything wrong, then **Confirm
   Attendance**. Finalization is blocked while any row is unresolved.
4. **Students** see their own finalized attendance at `/portal` — overall
   percentage, today, subject-wise (college) or day-by-day (school) — and can
   open any record at `/portal/attendance/<recordId>` for the date, subject,
   faculty, status and how it changed. The list updates live as registers are
   finalized or corrected. Students have no way to alter attendance: the
   portal's whole data module is read-only.
5. **Faculty** get today's sessions, their review queue, their classes and
   subjects on `/dashboard`, and per-class history — daily attendance, absent
   students, every correction — at
   `/dashboard/attendance/<cohortId>/history`.
6. **Institution admins** get institution-wide reporting at
   `/dashboard/reports`: a date range, filters for class, academic unit,
   subject, faculty, student and status, and eleven ways to group the result —
   class, department, semester, course, grade, section, subject, faculty,
   student, daily, monthly. Below-threshold students are listed against the
   institution's own configured percentage, with a `?threshold=` override for
   asking "what would 80% look like" without changing policy. Every view
   exports to CSV or Excel, and `/dashboard/reports/print` is the same report
   laid out for paper — print it, or save it as PDF from the browser.
   [`docs/REPORTING.md`](docs/REPORTING.md) covers what is counted, why the
   threshold is never hardcoded, and what the query benchmark measured.
7. **With no internet**, faculty take the register at `/dashboard/offline`.
   Download your classes once while connected; after that the workflow is the
   same — open the class, capture, mark, review, finalize — and the register is
   saved to IndexedDB and queued. It syncs itself when the network returns,
   with exponential backoff and an idempotency key per operation, so syncing
   the same register twice cannot create it twice. Disagreements with the
   server are shown side by side for a person to settle rather than resolved
   automatically, and nothing is ever deleted from the queue that the server
   has not acknowledged. Offline attendance does **not** depend on a cloud AI
   API; a local inference node on the institution's network is used when
   `LOCAL_AI_ENABLED` says one exists and it actually answers.
   [`docs/OFFLINE_SYNC.md`](docs/OFFLINE_SYNC.md) covers the storage choices,
   the four idempotency layers, and what is deliberately not cached.
8. **Connecting the institution's other systems** happens at
   `/dashboard/integrations`. Add an integration, enter the credentials, test
   the connection, map their column names onto ours, and sync — manually, on a
   schedule, or incrementally. If the source system has no API at all, which is
   common, `/dashboard/integrations/import` takes a CSV or Excel export
   instead: it shows exactly what would change before anything is written —
   creates, updates, unchanged rows, duplicates and errors, with your file's own
   line numbers — and hands back a downloadable error report for any row it
   could not import. Attendance flows back out over signed webhooks and the
   versioned `/api/v1` REST API, where every key is limited to the scopes it
   was granted. No credential, face embedding, classroom photo or AI confidence
   ever crosses an integration boundary.
   [`docs/INTEGRATIONS.md`](docs/INTEGRATIONS.md) covers the adapter system,
   the scope model, and what is deliberately not built.
9. **Deciding how long a face is kept** is an institution's decision, not
   ours, so it is configuration rather than a constant:
   `/dashboard/institutions/settings` sets what happens to a student's face
   template when they leave, how long a deactivated template survives before it
   is permanently deleted, and whether classroom photographs may be stored at
   all. They may not, by default — the capture path holds the bytes for one
   recognition call and writes them nowhere — and there is deliberately no
   setting that means *keep them forever*. An administrator can also erase one
   student's face data outright from that student's enrollment page; the
   attendance register survives, because it never held the biometric data in
   the first place. The face-AI service now requires a shared token on every
   endpoint that can turn a photograph into a template.
   [`docs/SECURITY.md`](docs/SECURITY.md) covers the retention policy, the
   access-control model, upload validation, what is audited, and the gaps that
   remain.

## Status

Attendance capture → recognition → register → faculty review → finalization →
student visibility is implemented end to end in code, with unit and
integration tests, and the student / faculty / admin portals over it are
built and responsive. The same register can be taken with no network and
synced later. The Integration Hub around it — the scoped `/api/v1` REST API,
signed outbound webhooks, the provider adapter system, field mapping, CSV/XLSX
import and the Integration Center UI — is implemented and unit-tested, with no
new npm dependencies and no schema change. A configurable face-data retention
policy, an authenticated face-AI service, magic-byte upload validation and an
attack suite organised by attacker rather than by module sit on top of that,
again with no new dependency and no schema change —
[`docs/SECURITY.md`](docs/SECURITY.md), including a "known gaps" section that
names what is *not* protected.

No face recognition model is licensed for production use, and **nothing here
has been exercised against a real database in a browser** — the development
environment has no pgvector-capable Postgres, so the attendance engine, the
DevTools offline walkthrough in
[`docs/OFFLINE_SYNC.md`](docs/OFFLINE_SYNC.md#testing-it-by-hand) and the
Integration Center screens are all verified by type-checking, unit tests and a
clean production build rather than by clicking through them. See "Explicitly
deferred" in `ARCHITECTURE.md` for the rest (a durable webhook queue, a shared
rate-limit store, a scheduler, Background Sync, OAuth2, production
deployment).
