# Database operations

PostgreSQL + pgvector. Migrations, backup, restore, and the handful of things
about this database that are not standard Postgres.

Everything below was executed against PostgreSQL 17.11 with pgvector 0.8.6 while
Phase 15 was written, not reasoned about from documentation. Where a command was
not run, it says so.

---

## 1. What makes this database non-standard

Three things. Each one is a way a routine operation can go wrong.

**The `vector` extension is a hard prerequisite.** `FaceEmbedding.embedding` is
`vector(128)`. The baseline migration creates the extension as its first
statement, but `CREATE EXTENSION` can only succeed if the pgvector files are
present on the server's filesystem. On a server without them the failure is:

```
ERROR:  extension "vector" is not available
DETAIL:  Could not open extension control file ".../extension/vector.control"
HINT:   The extension must first be installed on the system where PostgreSQL is running.
```

This is a server-provisioning problem, not a migration problem — no migration
can fix it. The repository's `docker-compose.yml` uses `pgvector/pgvector:pg16`,
which ships with it. A managed Postgres must have pgvector on its extension
allow-list before the first deploy.

**One index cannot be expressed in `schema.prisma`.** `role_key_platform_unique`
is a *partial* unique index — `ON "Role"(key) WHERE "institutionId" IS NULL` —
and Prisma has no syntax for the `WHERE`. It exists only in the hand-written
portion of `migrations/20260917000000_init/migration.sql`. `prisma migrate diff`
will never regenerate it, so if the baseline is ever squashed or rebuilt it must
be re-added by hand or platform-wide roles silently start duplicating. The same
applies to `CREATE EXTENSION vector`.

**`updatedAt` columns have no database default.** Prisma's `@updatedAt` is
enforced in the client, so the column is `NOT NULL` with no `DEFAULT`. Every
write through Prisma is fine. A write that bypasses Prisma — a repair script, an
import, hand-written SQL — must supply the value or it gets
`null value in column "updatedAt" violates not-null constraint`.

---

## 2. Migrations

Two migrations, applied in order:

| Migration | What it does |
| --- | --- |
| `20260917000000_init` | The whole schema from empty: 8 enums, 24 tables, 43 foreign keys, the `vector` extension, the partial unique index on `Role`. |
| `20260917000100_query_pattern_indexes` | Nine indexes for named read patterns; drops three single-column indexes that the new composites subsume. |

### Applying them

```bash
cd apps/web
DATABASE_URL=... npx prisma migrate deploy   # production: applies, never generates
DATABASE_URL=... npx prisma generate
```

`migrate deploy` is the only command that should ever touch a production
database. It applies pending migrations and nothing else. Do not use
`migrate dev` (it may generate, reset, or reseed) and never `migrate reset`,
which drops every table.

### Before applying anything, in order

1. **Read the SQL.** `migrations/*/migration.sql`. Both current migrations are
   commented with their data impact and rollback.
2. **Check what is pending.** `npx prisma migrate status`.
3. **Take a backup** (§3). This is the rollback plan for anything the migration
   itself cannot undo.
4. **Check for drift** — that the live database still matches what the migration
   history says it should:
   ```bash
   npx prisma migrate diff \
     --from-schema-datasource prisma/schema.prisma \
     --to-schema-datamodel  prisma/schema.prisma --script
   ```
   A clean database prints `-- This is an empty migration.` Anything else is a
   hand-edit someone made outside the migration history; resolve it before
   applying more.

### Data impact of the current two

Neither migration destroys data. `20260917000000_init` only creates and can only
run against an empty schema. `20260917000100_query_pattern_indexes` only creates
and drops indexes, which do not hold row data — dropping one costs query
performance and nothing else. There is no `DROP TABLE`, `DROP COLUMN`,
`ALTER COLUMN ... TYPE` or `NOT NULL` addition anywhere in the history, which is
the class of statement that needs a migration-specific recovery plan.

### Applying index migrations to a live database

`CREATE INDEX` takes a `SHARE` lock and blocks writes to the table until it
finishes. Against an empty database that is instantaneous; against a populated
one it is an outage. `20260917000100_query_pattern_indexes` is written as plain
`CREATE INDEX` because it is authored for a fresh deployment.

To add the same indexes to a database that already has traffic, run them by hand
with `CONCURRENTLY` first, then mark the migration applied without executing it:

```bash
# One statement per psql invocation: CREATE INDEX CONCURRENTLY cannot run
# inside a transaction block, and psql wraps multi-statement -c in one.
psql "$DATABASE_URL" -c 'CREATE INDEX CONCURRENTLY "CohortFaculty_userId_idx" ON "CohortFaculty"("userId")'
# ... one per CREATE in the migration ...
psql "$DATABASE_URL" -c 'DROP INDEX CONCURRENTLY "AttendanceSession_institutionId_idx"'

npx prisma migrate resolve --applied 20260917000100_query_pattern_indexes
```

`CREATE INDEX CONCURRENTLY` can fail and leave an `INVALID` index behind. Check
for them afterwards and drop any that turn up:

```sql
SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
WHERE NOT i.indisvalid;
```

### Rolling a migration back

Prisma Migrate has no `down`. The procedures, cheapest first:

- **Index-only migrations** (`20260917000100_query_pattern_indexes`): run the
  down-migration commented at the foot of the file, revert the matching
  `@@index` lines in `schema.prisma`, then
  `prisma migrate resolve --rolled-back <migration_name>`. No data is at risk.
- **The baseline** (`20260917000000_init`): there is nothing to roll back to — it
  builds from empty. Recovery is to drop and recreate the database.
- **Anything that alters or drops data**: restore from backup (§3). Write the
  restore step into the deployment plan *before* running such a migration; do
  not discover mid-incident that the last backup predates the change.

### Adopting a database that already has these tables

If a database was built by some route other than this migration history, do not
run `migrate deploy` — it will try to create tables that exist. Baseline it:

```bash
npx prisma migrate resolve --applied 20260917000000_init
npx prisma migrate resolve --applied 20260917000100_query_pattern_indexes
```

Then run the drift check above and reconcile whatever it reports.

---

## 3. Backup and restore

### Backup

```bash
pg_dump --format=custom --no-owner --no-privileges \
        --file=attendance-$(date -u +%Y%m%dT%H%M%SZ).dump \
        "$DATABASE_URL"
```

`--format=custom` rather than plain SQL, because it is compressed, restores in
parallel, and lets `pg_restore --list` show what a dump contains before anything
is written. `--no-owner --no-privileges` makes the dump restorable as whatever
role the target happens to use.

**A dump of this database contains biometric templates.** Every
`FaceEmbedding.embedding` row is in it. Treat a dump file with the same care as
the database: encrypted at rest, access-controlled, retention-bounded, never
copied to a developer machine "to debug something". ADR-0008 sets the retention
policy the live table follows; a dump that outlives that policy quietly defeats
it.

Schema-only and data-only variants, when a full dump is more than is needed:

```bash
pg_dump --format=custom --schema-only --file=schema.dump "$DATABASE_URL"
pg_dump --format=custom --data-only   --file=data.dump   "$DATABASE_URL"
pg_dump --format=custom --exclude-table-data='"FaceEmbedding"' \
        --file=no-biometrics.dump "$DATABASE_URL"   # for a non-production copy
```

The last one is the right dump to hand to anyone who needs realistic data
without needing faces.

### Restore

```bash
createdb attendance_restored
pg_restore --no-owner --no-privileges --dbname=attendance_restored \
           --jobs=4 attendance-20260917T000000Z.dump
```

Restore into a **new, empty** database. `pg_restore --clean` against a live
database drops objects before recreating them, which turns a partial failure
into a destroyed database rather than a failed restore.

The target server must already have pgvector available — the dump carries
`CREATE EXTENSION vector`, which fails with the error in §1 otherwise. This is
the single most likely way a restore fails at the worst moment, and it is worth
proving on the standby server before it is needed.

### Verifying a restore

Object counts, the extension, the hand-patched index, the migration ledger, and
that a vector actually survived as a vector:

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
SELECT count(*) FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE';          -- 25 (24 + _prisma_migrations)
SELECT count(*) FROM pg_indexes WHERE schemaname='public';          -- 77
SELECT count(*) FROM pg_constraint WHERE contype='f';               -- 43
SELECT count(*) FROM pg_indexes WHERE indexname='role_key_platform_unique';  -- 1
SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL;
SELECT vector_dims(embedding) FROM "FaceEmbedding" LIMIT 1;         -- 128
```

The counts above are for the schema as of Phase 15; they are a tripwire for a
partial restore, not a permanent constant — update them when the schema changes.

Then point the application at the restored database and run
`npx prisma migrate status`. "Database schema is up to date!" confirms the
migration ledger came across intact and the application will not try to
re-migrate.

**Verified on 2026-09-17**: a `pg_dump -Fc` / `pg_restore` round-trip of a
database holding 22,003 students, 150,000 attendance records, 80,000 audit rows
and the contract's vector width reproduced all 25 tables, all 77 indexes, all 43
foreign keys, the partial unique index, both migration ledger rows, and the
vector values identically.

### Point-in-time recovery

Not configured, and out of scope for this phase. `pg_dump` gives recovery to the
last dump, which means the recovery point objective is the dump interval.
Anything better needs WAL archiving (`archive_mode`, `archive_command`,
`restore_command`) or the equivalent managed-service feature, configured on the
server rather than in this repository.

---

## 4. Bootstrap and seeding

Four different things write rows that did not arrive as application traffic.
They are routinely confused with each other, so they are named separately here.
Three of them are required in production; the fourth must never reach it.

| | What it writes | Runs where | How often |
| --- | --- | --- | --- |
| 1. Migrations | Schema only — tables, indexes, extensions | Every database | Every deployment that carries a new migration |
| 2. System bootstrap | 8 `Role` + 116 `RolePermission` | Every database | Idempotent; safe to repeat |
| 3. First-tenant bootstrap | 1 `Institution`, 1 admin `User`, 1 `UserRoleAssignment` | Every database | Exactly once, on an empty database |
| 4. Development fixture | Demo institutions, staff, cohorts, students | localhost only | Any time |

A database that has had 1 and 2 but not 3 is reachable and correct but has
nobody who can sign in. A database that has had 1 but not 2 cannot resolve a
single permission check, so even a user row would not get anyone in. The order
is fixed: migrations, then system, then tenant.

### 4.1 Migrations

Section 1. `prisma migrate deploy`, and nothing else, ever, against production.

### 4.2 System bootstrap — roles and permissions

Eight platform-wide roles (`institutionId IS NULL`) and their permission grants.
No institution, no user, no student, no face template. Idempotent by
construction: it converges `RolePermission` to whatever `permissions.ts`
currently declares, adding what is missing and removing what is stale, so
re-running after editing the permission catalog does not layer new grants on top
of old ones. Existing rows that are still correct keep their ids, so there is no
window in which a role is missing a permission it is supposed to have.

The logic lives in `src/modules/authorization/bootstrap.ts`. Two callers reach
it, and which one you use depends only on which database you mean:

```bash
# Development — also runs automatically after `prisma migrate dev`.
cd apps/web && npm run prisma:seed

# Any database, including production — see §4.5 for the production procedure.
BOOTSTRAP_TARGET=local npm run bootstrap:system --workspace=web
```

`prisma/seed.ts` is a thin wrapper around the same function. It is deliberately
absent from the production migration image (`apps/web/Dockerfile.migrate`), so
production is never reached by the seed path — it reaches the identical rows
through the bootstrap script instead. The rows are the same because the code is
the same; only the entry point and its guards differ.

### 4.3 First-tenant bootstrap — the first institution and its administrator

The chicken-and-egg case. Every other account in the system is created by an
authenticated administrator through the faculty directory, which needs an
institution, a role assignment and a signed-in actor to already exist. The first
one cannot be, so it is created out of band, once.

```bash
BOOTSTRAP_TARGET=local \
BOOTSTRAP_INSTITUTION_NAME="..." \
BOOTSTRAP_INSTITUTION_TYPE=SCHOOL \
BOOTSTRAP_ADMIN_NAME="..." \
BOOTSTRAP_ADMIN_EMAIL="..." \
  npm run bootstrap:tenant --workspace=web
```

The password is prompted for, hidden, and confirmed. It is never taken from the
command line. `BOOTSTRAP_ADMIN_PASSWORD` exists only for the non-interactive
case (a Container Apps Job has no terminal), where it arrives as a Key Vault
secret reference rather than a typed value.

It refuses unless the system roles are complete **and** the database holds zero
institutions, zero users and zero role assignments. A partial state is refused
rather than repaired: a database with an institution but no admin, or an admin
with no role, is a situation somebody needs to look at, not one a script should
guess its way out of. Concurrent attempts are serialised on a transaction-scoped
Postgres advisory lock, so two operators racing produce one tenant and one clear
refusal, never two institutions.

Nothing about it is automatic. No lifecycle hook calls it, no startup path calls
it, no CI step calls it, and no deployment stage calls it. It writes when a
person runs it and says which database they meant.

### 4.4 Development fixture

```bash
cd apps/web && DATABASE_URL=postgresql://postgres@127.0.0.1:5433/attendance_dev \
  node --import ./scripts/register-test-loader.mjs scripts/dev-fixture.ts
```

Demo institutions, staff, cohorts and students, for looking at a populated UI.
`scripts/dev-fixture.ts` refuses to run against anything but localhost. There is
deliberately no fake-student or fake-embedding seed for production — see
ADR-0008 on biometric data handling. Production business data is entered through
the application by the people it belongs to.

### 4.5 Running a bootstrap against production

Both bootstrap stages refuse to do anything until the operator has said, in two
independent ways, that production is what they meant:

```
BOOTSTRAP_TARGET=production
BOOTSTRAP_CONFIRM=WRITE-TO-PRODUCTION
```

Production is never inferred from the shape of `DATABASE_URL`. Inference is the
failure mode this is built against: a heuristic that is right a hundred times
and wrong once, silently, on the database where being wrong matters. Declaring
`local` while pointing at a non-localhost database is refused outright.

The script prints identifiers and the address the administrator signs in with.
It never prints the password, the password hash, or the connection string, and
it strips anything URL-shaped out of unexpected errors before reporting them —
this output is the kind that gets pasted into a ticket.

For the production execution path — which job runs it, and how the inputs get
there without landing in a shell history — see the bootstrap section of
docs/RUNBOOK_DEPLOYMENT.md.

---

## 5. Indexes

`prisma/schema.prisma` carries the reasoning for each index next to the
declaration. Two notes that belong here rather than there:

**There is no ANN index on `FaceEmbedding.embedding`, deliberately.** No query in
this codebase uses the `<=>` operator; recognition loads the cohort's templates
and ranks them in process so every score comes from one cosine implementation
(`modules/recognition-results/repository.ts`, and docs/BENCHMARKS.md §4 for the
measurement). An HNSW index with no reader is pure write-side cost. If a future
phase adopts `<=>` pre-filtering, the statement to add is:

```sql
CREATE INDEX CONCURRENTLY "FaceEmbedding_embedding_hnsw_idx"
  ON "FaceEmbedding" USING hnsw (embedding vector_cosine_ops);
```

It only earns its keep once a scoped candidate pool is large enough that an
approximate scan beats an exact one — a class of 50–100 templates is not, and the
scope filter must stay in the query either way, because matching a student
against another class's templates is a correctness bug, not a performance one.

**`Student` has no `@@index([institutionId])` and does not need one.**
`@@unique([institutionId, studentCode])` leads with `institutionId`, so it
answers both "student by external ID" and "all students in this institution".
Confirmed by `EXPLAIN ANALYZE` against 22,003 students across two institutions:
the tenant-scoped listing uses `Student_institutionId_studentCode_key`.
