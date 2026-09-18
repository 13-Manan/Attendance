# Attendance reporting

Institution-wide reporting: `apps/web/src/modules/attendance-reporting/`, the
workbench at `/dashboard/reports`, the printable view at
`/dashboard/reports/print`, and the download route at `/api/reports/export`.

This document covers the two things that are not obvious from the code: what is
counted, and what the query performance work actually measured.

## 1. What a report counts

**Confirmed registers only.** A percentage on any report screen is computed from
`AttendanceRecord` rows belonging to a session the faculty member has finalized.
Sessions still in review contribute to no numerator and no denominator.

They are not hidden either — every surface reports outstanding review work as
its own figure ("N registers still in review", "N marks awaiting review, not
counted above"). This is the reporting half of the rule stated in
`ARCHITECTURE.md` under *AI is advisory, faculty is authoritative*: an
unreviewed recognition result is not an attendance fact, and a report is exactly
the place where an unreviewed guess would quietly become an official number
somebody quotes in a meeting.

A record whose result is null or unresolved is counted in `unresolved`, never in
`present` and never in `absent`. `percentage` is `null` — not `0` — when the
denominator is zero. A student with no marks has not attended 0% of classes;
they have no percentage at all. Both the CSV and the XLSX writer leave such a
cell blank rather than writing a zero.

## 2. The low-attendance threshold

There is exactly one literal `75` in `apps/web/src/`:

```
src/modules/institutions/types.ts:  export const DEFAULT_LOW_ATTENDANCE_THRESHOLD = 75;
```

Everything else reads it, and every report resolves the *institution's* threshold
from its settings before using it (`resolveThreshold` in the reporting service).
The constant is only the fallback for an institution that has not set one.

Three consumers, in increasing order of precedence:

1. `DEFAULT_LOW_ATTENDANCE_THRESHOLD` — the fallback.
2. The institution's configured threshold — settings, per institution.
3. `?threshold=` on a report URL — a view-only override, so an administrator can
   ask "what would 80% look like" without changing anyone's policy. It changes
   the screen and the export taken from that screen; it changes no stored value.

The threshold is threaded through the analytics payloads as well
(`StudentDashboard.lowAttendanceThreshold`,
`CohortAttendanceHistory.lowAttendanceThreshold`), so the colour of a bar in the
student portal follows the institution's own rule rather than a hardcoded one.

Note the wording used throughout the UI: a low-attendance list is "a filter over
this period's confirmed attendance — not a shortage determination". The system
does not know an institution's condonation rules, its medical-leave policy, or
which sessions were cancelled. It reports a percentage over a window; deciding
what that means is the institution's.

## 3. Performance

### The shape of the fix

The Phase 7 report loaded every finalized record in the window and aggregated it
in JavaScript. On the benchmark institution (482,760 records, 8,856 sessions)
that measured **5.5 s and 238 MB of heap**. The same figures from a `GROUP BY`
measure **25 ms**.

Every query in `attendance-reporting/repository.ts` therefore:

- aggregates in PostgreSQL (`count(*) FILTER (WHERE ...)`), never in Node;
- paginates with `LIMIT`/`OFFSET` and gets its total from a separate
  `count(*)` — so "showing 1–25 of 2,160" is a fact, not an inference;
- filters server-side, inside the same statement, so a filtered report reads
  less rather than the same amount plus a discard pass.

### The generic-plan trap

This was the one genuinely surprising result, and it is the reason
`reportQuery()` exists.

PostgreSQL plans a prepared statement with its actual parameter values for the
first five executions, then decides whether a *generic* plan — one built without
looking at the values — is good enough, and from the sixth execution onward uses
it. Prisma prepares every `$queryRaw`. So the generic plan is not an edge case
here; it is the production steady state, reached within seconds of a report
screen being used.

For these queries the generic plan is badly wrong. A parameter-blind planner
cannot know that `sessionDate BETWEEN $1 AND $2` selects 6% of the table rather
than all of it, estimates the row count **248× low**, and picks a nested loop:

| Query | Custom plan | Generic plan |
| --- | --- | --- |
| Student rollup | 22 ms | 586 ms |
| Low-attendance list | 25 ms | 600 ms |
| Records page, status filter | 32 ms | 740 ms |
| Records page 1 | 76 ms | 283 ms |

The fix is one line per statement, applied centrally:

```ts
function reportQuery<T>(sql: Prisma.Sql): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL plan_cache_mode = force_custom_plan");
    return tx.$queryRaw<T>(sql);
  });
}
```

`SET LOCAL` scopes it to the transaction, so no other query in the application
is affected. The cost is re-planning on every execution — sub-millisecond for
these statements, against the 500 ms it buys back.

**If you write a new report query, route it through `reportQuery`.** And note
how easy this was to miss: an early version of the benchmark ran each query
twice and saw none of it. The benchmark now runs six executions and reports
`first` against `steady` for exactly this reason. A two-run benchmark of a
prepared statement measures the plan you will not be using.

### Indexes: none added, and why

The brief says not to add indexes blindly, and to measure first. Measured, then:
**no index was added.** The findings, for the next person who wonders:

| Candidate | Result |
| --- | --- |
| `AttendanceRecord(studentId)` | The only one that earns its keep: 8.8 ms → 0.616 ms on the single-student lookup. |
| `AttendanceSession(institutionId, sessionDate)` | No measurable benefit. The existing indexes already cover the window scan, and the planner chose the same path with and without it. |
| `AttendanceSession(facultyId)` | No measurable benefit — `facultyId` is `NOT NULL` and the faculty-wise rollup is a hash aggregate over the window, not a lookup. |

So one of three candidates is worth having, and it is not added, because adding
it means editing `prisma/schema.prisma` — and the standing instruction for this
phase is that the database schema does not change. The 8.8 ms it would save is
on a query nothing on these screens runs in a loop.

Recorded here rather than acted on. If a future phase opens the schema, this is
the index to add, with this number attached to it:

```prisma
@@index([studentId])   // AttendanceRecord: 8.8 ms -> 0.6 ms on student history
```

### Re-running the benchmark

```bash
cd apps/web
./scripts/report-bench/setup.sh          # create, seed, and measure
./scripts/report-bench/setup.sh --drop   # remove the scratch database
```

It builds its own database (`attendance_bench` by default) from
`prisma/schema.prisma` and never touches the development database. One
substitution is made to the generated DDL: `FaceEmbedding.embedding` is created
as `bytea` rather than `vector(512)`, because pgvector is packaged for
PostgreSQL 17+ and this machine runs 16. No report query touches that table, so
the substitution cannot affect a measurement — but it does make that database
useless for anything involving face recognition.

Drop it when you are done. It is a few hundred megabytes of synthetic rows.

## 4. Export

Three formats, one code path (`attendance-reporting/export.ts`):

- **CSV** — RFC 4180, CRLF endings, quoted only where required, with a UTF-8
  BOM so Excel does not mangle non-ASCII names.
- **XLSX** — written by hand with `node:zlib`, no dependency. A `.xlsx` file is
  a zip of five XML parts; writing them directly is about 200 lines and avoids
  pulling a spreadsheet library into the server bundle. Numbers are written as
  numbers, not as text, because sorting and averaging is most of what an
  administrator opens a spreadsheet to do. The zip carries a fixed timestamp, so
  the same report exported twice is byte-identical and two months can be diffed.
- **PDF** — deliberately *not* generated. `/dashboard/reports/print` is a real
  page with print stylesheets; the browser already has a typesetting engine and
  a PDF writer. A server-side renderer would be a second layout engine to keep
  in step with the first, and the first time the two disagreed the printed copy
  would be the one somebody had already signed.

Exports are capped at `MAX_EXPORT_ROWS` (50,000), walked in pages of 5,000 so no
single query returns the lot. When the cap is hit the file says so, as a final
row *inside the file* — not only in a response header. A report that silently
stops short is a report that will be quoted as if it were complete.

## 5. The URL is the state

Every filter, the dimension, the page, the sort and the threshold override live
in the query string, parsed once by
`apps/web/src/components/reports/report-query.ts`. Consequences worth knowing:

- The workbench works with JavaScript disabled. The filters are a GET form, the
  dimension tabs and the pager are links, and the export buttons are links to a
  route handler.
- An export cannot disagree with the screen it was taken from: the same query
  string produces both.
- The print view reads the identical parameters and renders the identical
  components, so a printed report cannot drift from the screen it was printed
  from.
- A report is bookmarkable and mailable. `reportHref` writes the *normalized*
  window dates rather than the raw ones, so a link built from a page showing the
  default 30 days carries those dates explicitly and does not silently shift
  when it is opened a week later.

The dimension is a query parameter rather than a route segment because
everything else survives switching between dimensions — a report is far more
often "the same filters, grouped differently" than a fresh start.

## 6. What is left of the Phase 7 report

`getInstitutionAttendanceReport`, `buildReportRollups` and
`listFinalizedRecordsForInstitution` in `modules/attendance-analytics` are
`@deprecated` and rendered by nothing. They are the in-memory aggregation path
described above. They were left in place rather than deleted because the
standing instruction for this phase is that existing behaviour keeps working
exactly as it is; their tests still pass. Anything new belongs in
`attendance-reporting`.
