# Architecture

Foundation-phase architecture for the School & College Face Recognition
Attendance Platform. This document describes the boundaries that later
phases build inside — it does not describe a finished product. See
`docs/` for narrower topics and `docs/adr/` for individual decisions with
their rationale.

## System overview

```
                    ┌─────────────────────────┐
                    │   apps/web (Next.js)    │
                    │  UI + API + business    │
                    │  logic + Postgres access│
                    └───────────┬─────────────┘
                                │ internal REST (ADR-0002)
                                │ POST /v1/detect-embed
                                ▼
                    ┌─────────────────────────┐
                    │ services/face-ai         │
                    │ (FastAPI, stateless)     │
                    │ image -> detect -> align │
                    │ -> embed. No DB access.  │
                    │ FaceModelProvider adapter│
                    │ -> swappable model       │
                    └─────────────────────────┘

apps/web also owns:
  - PostgreSQL + pgvector (via Prisma)          — database/vector layer
  - /api/v1/*  (API-key auth, versioned)        — integration layer
  - /api/realtime/* (Server-Sent Events)        — realtime layer
  - modules/offline-sync + lib/offline    — offline capture & sync layer
```

## Attendance pipeline

```
Classroom camera
  -> Capture 1/2/3 images            ─ app/dashboard/attendance/[cohortId]/capture
  -> Quality check
  -> Face detection        ┐
  -> Face alignment        ├─ services/face-ai (POST /v1/detect-embed)
  -> Face embedding        ┘
  -> Class-specific vector search   ─ apps/web, Prisma $queryRaw against
                                       FaceEmbedding, scoped to the session's
                                       Cohort's enrolled students
  -> Confidence engine               ─ modules/recognition-results/service.ts
                                       classifyRecognitionConfidence()
  -> Attendance candidate generation ─ modules/attendance-review/service.ts
                                       ONE row per ENROLLED student, not per
                                       recognised face (docs/ATTENDANCE_ENGINE.md)
  -> Attendance review (Present / Absent / Needs Review)
                                     ─ app/dashboard/attendance/[cohortId]/
                                       review/[sessionId]
  -> Faculty verification            ─ modules/attendance-review/actions.ts
                                       correctAttendanceRecord underneath
  -> Finalization                    ─ modules/sessions/service.ts, blocked while
                                       any NEEDS_REVIEW row is unresolved
  -> Final attendance                ─ AttendanceRecord.finalResult
  -> Student portal (app/portal/attendance), live over SSE
```

Recognition is **advisory** at every step above the review board; the only
thing that makes attendance final is a faculty member pressing Confirm. See
`docs/ATTENDANCE_ENGINE.md`.

**Why the vector search happens in Next.js, not in the Python service**: the
Python service has no database credentials at all — it is a pure function
(image in, embedding out), which is what makes it swappable without
touching the attendance system (ADR-0005) and keeps its attack surface
minimal (ADR-0002). All product policy — confidence thresholds, what counts
as Present vs Needs Review — lives in TypeScript in `modules/recognition-results`,
configured per-institution via `Institution.settings.confidenceThresholds`.

## AI is advisory, faculty is authoritative

`AttendanceRecord` carries two result fields:

- `aiResult` / `aiConfidence` — written once by the pipeline, never edited.
- `finalResult` — mutable, and the only field UI/API responses should treat
  as "the" attendance result.

Every change to `finalResult` goes through
`modules/attendance/service.ts#correctAttendanceRecord`, which — inside one
transaction — updates `finalResult` and inserts an append-only
`AttendanceCorrection` row (previous result, new result, who, when, why,
and a `source` enum distinguishing a faculty review from a public-API
correction). There is no code path that can change `finalResult` without
also writing that row. See `docs/DATA_MODEL.md`.

## Portals

Three audiences read the same finalized attendance through two modules —
`attendance-analytics` for the portals, `attendance-reporting` for
institution-wide reports — both **read-only by construction**. Neither exposes
an action, a mutation, or a function that accepts a caller-supplied
`studentId`/`institutionId`; the tenant is always derived from the session. That
is what enforces "students must not be allowed to alter attendance": there is
nothing for a student session to call, rather than a guard that could be
forgotten.

| Route | Audience | Scope |
| --- | --- | --- |
| `/portal` | Student | Own records only (`attendanceRecord.read.own`), resolved from the session's `Student` row |
| `/portal/attendance/[recordId]` | Student | One own record; a record belonging to anyone else is a `ForbiddenError`, and a record whose session is not `FINALIZED` is indistinguishable from one that does not exist |
| `/dashboard` | Faculty / admin | `resolveFacultyScope` |
| `/dashboard/attendance/[cohortId]/history` | Class teacher / lecturer | The class, or — for a subject-only lecturer — only their subjects' sessions |
| `/dashboard/reports` | Institution admin | Institution-wide, always windowed (`attendance-reporting`) |
| `/dashboard/reports/print` | Institution admin | The same report, same parameters, print stylesheets instead of chrome |
| `/api/reports/export` | Institution admin | The same report as CSV or XLSX; no `institutionId` parameter exists |
| `/dashboard/offline` | Faculty (`attendanceSession.capture`) | The offline workbench: download rosters, take a register with no network, watch the sync queue. The kit is assembled server-side by `buildOfflineKit` under the same `requireCohortAccess` checks as online capture |
| `/offline` | Anyone | Static, data-free navigation fallback served by the service worker on a reload with no network. Renders the same workbench against IndexedDB; **no `requireUser()`**, because a page needing a server round-trip cannot render offline |
| `/api/sync/attendance` | Faculty (`attendanceSession.capture` + `attendanceRecord.correct`) | The idempotent sync batch. Tenant from the session cookie, never the payload |
| `/api/local-ai/health` | Any signed-in user | Server-to-server probe of the institution's local inference node. `UNCONFIGURED` unless `LOCAL_AI_ENABLED` is opted into |

Faculty scope is a **two-clause OR**, not a flattened cohort-id list:

```
cohortId IN (cohorts I am CohortFaculty on)
  OR cohortSubjectId IN (subjects assigned to me)
```

This is what makes "college faculty should only see assigned subjects,
classes and sessions" true in the narrow case that matters: a lecturer who
teaches one subject to a class they are not the class teacher of sees that
subject's registers and nothing else from that class. `cohort.manage`
(admin) widens the scope to the whole institution; a platform-level user with
no `institutionId` is refused rather than shown an empty institution.

Two rules the read models keep that the UI must not undo:

- **A percentage that does not exist is `null`, never `0`.** A student with no
  classes yet has no attendance rate; rendering that as "0%" tells them they
  missed everything. Same reasoning as a null recognition confidence.
- **Denominators count decided results only.** `NEEDS_REVIEW` /
  `NOT_EVALUATED` rows are excluded from both numerator and denominator, so an
  unresolved row can never silently depress somebody's percentage. Finalization
  already blocks unresolved rows; this is defence in depth.

Reports add a third, for the same reason: **the low-attendance threshold is a
per-institution setting, never a constant in a component.** There is exactly one
literal `75` in `apps/web/src/`, in `modules/institutions/types.ts`, and it is
only the fallback. See `docs/REPORTING.md`.

### PWA

The manifest is complete (icons at 192/512, a maskable variant, an
apple-touch-icon, `id`/`scope`/`theme_color`), so the app installs and its
window matches the app inside it.

`public/sw.js` is now a real **app-shell** worker, registered in production
only. The original prohibition it was written around is unchanged and is the
reason the worker looks the way it does: almost every authenticated page here
is somebody's attendance record, the devices are shared — a classroom tablet,
a lab machine — and a Cache Storage entry outlives the session cookie and is
not cleared by logging out. So **no personal data enters Cache Storage**:
`/api/*` is never intercepted, authenticated HTML and RSC payloads are passed
through without being stored, and the cache holds only `/_next/static/`,
`/icons/`, the manifest, and the static `/offline` route.

The outbound capture queue that section anticipated is `lib/offline/queue.ts`,
backed by IndexedDB — not by Cache Storage and not by `localStorage`. Next 16's
`experimental.useOffline` handles retrying failed navigations and Server
Actions, and catches the "associated but no upstream" case `navigator.onLine`
misses; the worker exists for the one thing it explicitly does not cover, a
full page reload with no network. See `docs/OFFLINE_SYNC.md`.

## Module boundaries (`apps/web/src/modules/*`)

| Module | Owns |
| --- | --- |
| `institutions` | Institution CRUD, settings (academic unit labels, confidence thresholds) |
| `academic-sessions` | AcademicSession (named academic year) create/list/archive |
| `academic-structure` | AcademicUnit tree (Grade/Section, Department/Semester/Course, …) |
| `cohorts` | Cohort create/list + class-teacher/faculty (CohortFaculty) assignment |
| `subjects` | College Subject + CohortSubject + StudentSubjectEnrollment |
| `enrollment` | Student ↔ Cohort binding (the choke point for cohort-scoped face search) |
| `students` | Student records |
| `face-enrollment` | Biometric enrollment orchestration + quality gate + audit; never returns raw embeddings |
| `faculty` | User/faculty records, cohort assignment |
| `sessions` | AttendanceSession lifecycle/state machine, SessionImage, unified DAILY/SUBJECT_WISE creation |
| `recognition-results` | Confidence engine — turns a similarity score into Present/Absent/Needs-Review |
| `attendance-capture` | Capture-wizard orchestration: session start/resume, subject picker, image intake |
| `recognition-engine` | Class-scoped search, scoring, deduplication → an **advisory** run summary |
| `attendance-review` | Candidate generation from the enrolled roster, review board, faculty correction, finalization, student view |
| `attendance` | AttendanceRecord + the correction/audit workflow |
| `attendance-analytics` | **Read-only** portal aggregation: student percentages (subject-wise / daily), faculty dashboard + class history. Has no write path by construction |
| `attendance-reporting` | **Read-only** institution reporting: eleven rollup dimensions, low attendance, record listing, CSV/XLSX export. Aggregates in SQL, never in memory. See `docs/REPORTING.md` |
| `integrations` | The whole Integration Hub: API-key auth + scopes + rate limiting + audit for `/api/v1`, the provider adapter system (REST / webhook / CSV), outbound webhook signing and delivery, field mapping, CSV/XLSX import, sync planning, and the Integration Center's own service and Server Actions. Zero new npm dependencies; schema-frozen (connections live in `Institution.settings`, run history in `AuditLog`). See `docs/INTEGRATIONS.md` |
| `realtime` | Attendance event publisher/subscriber (SSE-backed) |
| `offline-sync` | Offline capture + sync engine: idempotent batch application, conflict reporting, backoff policy, the download kit, and the sync-status decision. Pure logic in `idempotency.ts`/`status.ts`; the client half lives in `lib/offline/*`. See `docs/OFFLINE_SYNC.md` |
| `auth-tenancy` | Session/user type contracts; real auth deferred |

Each module owns its own `types.ts` + thin `repository.ts` (Prisma access)
+ `service.ts` (business rules) so a later auth or UI phase can depend on a
stable module surface instead of reaching into Prisma directly.

## Three API surfaces — do not conflate them

1. **Internal Next↔Python contract** — `apps/web/src/app/api/internal/*` and
   `services/face-ai`'s `/v1/*`. Private and not internet-facing, *and*
   authenticated: every `/v1/*` endpoint except `/v1/health` requires a shared
   service token (`Authorization: Bearer <FACE_AI_AUTH_TOKEN>`, matched against
   apps/web's `FACE_AI_SERVICE_TOKEN`). Network isolation is not the only
   control, because a process cannot verify its own network and `/v1/enroll`
   turns a photograph into a biometric template. Contract types are shared
   via `packages/shared-types/src/face-ai-contract.ts` (TypeScript) mirrored
   by hand in `services/face-ai/app/schemas.py` (Pydantic). See
   `docs/SECURITY.md` and `docs/API_CONTRACTS.md` §A.
2. **Public integration REST API** — `apps/web/src/app/api/v1/*`. Versioned,
   `Authorization: Bearer <key>` against the `ApiKey` model
   (`modules/integrations/api-key-auth.ts`), authorized by **scope** rather
   than role, rate-limited per key, and audited per request. OAuth2
   client-credentials is reserved at `/api/v1/oauth/token` (which answers
   `501`) but not implemented; `ApiKeyContext` already carries `authMethod` so
   landing it changes no authorization code. See `docs/API_CONTRACTS.md` §B
   and `docs/INTEGRATIONS.md`.
3. **Server Actions** (`"use server"`, e.g. `modules/attendance/actions.ts`) —
   in-app, session-authenticated UI mutations. Use a Route Handler instead of
   a Server Action whenever the caller isn't a React client of this app:
   service-to-service calls, streaming responses (SSE), or anything
   public/webhook-facing.

Full request/response shapes: `docs/API_CONTRACTS.md`.

## Multi-tenancy: one schema for schools and colleges

`AcademicUnit` is a self-referential tree discriminated by `kind`
(`DEPARTMENT | GRADE | SEMESTER | COURSE | SECTION | GENERIC`). A school
nests `GRADE -> SECTION`; a college nests `DEPARTMENT -> SEMESTER -> COURSE`.
`Cohort` (the actual enrollable, attendance-taking group) attaches to
whichever `AcademicUnit` is the "bottom" of that institution's tree.
Institution-specific UI labels come from `Institution.settings.academicUnitLabels`
(JSON), not from a schema fork. Full rationale and worked examples:
`docs/MULTI_TENANCY.md` and ADR-0003.

## Monorepo layout

```
attendance/
├── apps/web/            Next.js app — UI, API, business logic, DB access
├── services/face-ai/    FastAPI service — stateless image -> embedding
├── packages/shared-types/  TS contract types shared by apps/web (mirrored
│                           by hand into services/face-ai's Pydantic schemas)
├── docs/                Architecture documentation + ADRs
└── infra/               Empty placeholder — deployment is a later phase
```

npm workspaces (`apps/*`, `packages/*`), no Nx/Turborepo — see ADR-0001 for
why, and the trigger for revisiting it.

## Explicitly deferred (not built in this phase)

- Real face detection/embedding model integration. The model-provider
  abstraction, the internal AI contract and the ONNX backend scaffold are
  built; no model is licensed for production use. InsightFace's pretrained
  weights are confirmed **non-commercial research only** — see
  `docs/FACE_AI_ARCHITECTURE.md`, `services/face-ai/app/models/LICENSING.md`
  and ADR-0006.
- Time-series **charts**. The reports are tables and rollups; daily and monthly
  dimensions give the series, nothing plots it. (Report exports are no longer
  deferred — CSV and XLSX are built, and the printable view is a real page
  rather than a server-side PDF renderer; see `docs/REPORTING.md`.)
- **Scheduled / emailed reports.** Every report is a URL, which is most of what
  a scheduler needs, but nothing runs one on a timer or delivers it.
- An **index on `AttendanceRecord(studentId)`**, which the benchmark says is
  worth 8.8 ms → 0.6 ms on a student's history. Not added, because adding it
  means a schema change and this phase forbade one. The measurement and the two
  candidates that turned out *not* to be worth it are in
  `docs/REPORTING.md#indexes-none-added-and-why`.
- **A durable webhook queue and a shared rate-limit store.** Delivery,
  signing, retry/backoff and per-key rate limiting are all built and tested,
  but both run **in-process**: the rate limit is therefore per instance
  (*n* instances → *n* × limit), and a retry in backoff does not survive a
  restart. Both sit behind interfaces (`RateLimiter`; the pure
  `webhook-delivery`/`webhook-signature` modules) precisely so the backend can
  be swapped without touching `api-route.ts` or any `/api/v1` contract. See
  ADR-0007.
- **A scheduler.** `SCHEDULED` and `INCREMENTAL` connections enforce their
  interval gate correctly and `runSync` already accepts
  `trigger: "scheduled"`, but nothing in this repo runs on a timer — an
  external caller has to invoke it.
- **Sync of anything but students.** `SYNCABLE_RESOURCES = ["students"]`;
  every other resource is refused with a sentence rather than offered as a
  checkbox that quietly does nothing. The API *reads* all eleven resources.
- **Background Sync / Periodic Background Sync.** The queue drains on a
  connectivity edge, tab focus, a 20 s poll, and an explicit Retry — all of
  which need the tab alive. The `SyncManager` API would drain it with the app
  closed; it is Chromium-only, so it would be an enhancement on top of these
  triggers rather than a replacement for them.
- **Offline photograph upload.** Images captured offline stay in IndexedDB as
  the teacher's own record and are never uploaded by the sync engine; only
  `captureImageCount` is synced. See `docs/OFFLINE_SYNC.md`.
- A **`SyncedOperation(deviceId, operationId)` table.** The idempotency ledger
  lives in `AttendanceSession.metadata` under a `FOR UPDATE` lock because this
  phase forbade schema changes. It would replace exactly two functions in
  `offline-sync/idempotency.ts` — and it is a *reporting* improvement, not a
  correctness fix: exactly-once already rests on unique indexes the schema
  has.
- Multi-instance realtime. Attendance mutations do publish SSE events, but
  the publisher is an in-process EventEmitter (ADR-0004); horizontal scaling
  needs Redis or Postgres `LISTEN/NOTIFY` behind the same interface.
- `finalizedBy` / `finalizedAt` as real columns. They are recorded in
  `AttendanceSession.metadata` plus the authoritative `AuditLog` row, because
  the phase that needed them forbade schema changes — see
  `docs/ATTENDANCE_ENGINE.md` §3.
- End-to-end browser verification of the attendance engine **and of the offline
  workflow** (no pgvector-capable local Postgres available in the development
  environment; see README and `docs/OFFLINE_SYNC.md#testing-it-by-hand`).
- **A scheduler for the retention sweep.** The policy is enforced by
  `modules/privacy/runRetentionSweep`, which an administrator triggers from
  Institution Settings. No scheduler ships with this build (ADR-0007), so
  retention periods are not enforced until somebody presses the button. The
  service takes a `SessionUser` and resolves the institution from it, so
  whatever eventually runs it on a timer will need a service account — which is
  the right thing to need before deleting biometric templates.
- **Encryption at rest for face embeddings.** `FaceEmbedding.vector` is stored
  as pgvector data protected by database and filesystem access control, not by
  application-level encryption. Encrypting it would either break the ANN index
  the recognition path depends on or require a key-management dependency, and
  this phase permitted neither a new dependency nor a schema change. See
  `docs/SECURITY.md` for what does protect it.
- OAuth2 flow (API-key auth only)
- Any production/Hostinger deployment configuration
