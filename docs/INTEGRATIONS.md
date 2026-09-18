# Integration Hub

This platform is not an isolated attendance app. An institution already runs
an ERP, or a student information system, or — very often — a registrar with a
folder of spreadsheets. The Integration Hub is how records get in and how
attendance gets back out, without either side rewriting the other.

Four surfaces, one authorization model:

| Surface | Caller | Proves itself with | Authorized by |
| --- | --- | --- | --- |
| Public REST API (`/api/v1/*`) | external system | `Authorization: Bearer <api key>` | scopes |
| Outbound webhooks | us → them | our HMAC signature on the body | the endpoint's subscription |
| Integration Center (`/dashboard/integrations`) | an administrator | session cookie | `PermissionKey` |
| File import | an administrator | session cookie | `PermissionKey` |

---

## 1. The adapter system

> *"Do not hardcode one school's ERP into the core application."*

Every connected system is reached through an `IntegrationProvider`
(`modules/integrations/providers/provider.ts`). The core knows the interface
and nothing else:

```
IntegrationProvider            kind, label, capabilities, validateConfig()
├── RESTProvider               pull over HTTP+JSON, cursor pagination
├── WebhookProvider            receives pushes; cannot be polled
├── CSVProvider                a file drop; no network at all
└── <FutureCustomProvider>     add a file, register it, done
```

`capabilities` is the important part. It is a set of honest declarations —
`testConnection`, `pull`, `push`, `incremental`, `scheduled`, `resources` —
and the rest of the system reads them rather than special-casing a vendor:

- The **Add Integration** form renders from them. Choose a provider that cannot
  run unattended and "Scheduled" is not in the sync-mode list.
- `createConnection` rejects a configuration the provider cannot honour
  (`INCREMENTAL` against a provider with `incremental: false`) at save time,
  with a sentence, rather than at 2am with a stack trace.
- **Sync now** is disabled with a reason for a push-only provider: *"a webhook
  integration does not pull — it receives."*

Adding a provider is one file plus one line in `providers/registry.ts`. No
core file learns its name.

### Not every system has a modern API

The CSV provider and the import wizard exist because the assumption that an
institution has a REST endpoint is wrong often enough to design around. A
spreadsheet import gets the same validation, the same duplicate detection, the
same field mapping and the same audit row as a REST sync — it is a first-class
path, not a fallback.

---

## 2. Storage, and why it looks like this

**The database schema was frozen for this phase.** No table was added, no
column, no `@@map`. Everything the Hub persists lives in structures that
already existed:

| What | Where | Why there |
| --- | --- | --- |
| Connections, field mappings, schedules | `Institution.settings` JSON, under `"integrations"` | Per-tenant, bounded (a handful of connections), always read together with the institution |
| Sync runs, webhook deliveries, import results | `AuditLog` rows | Append-only and unbounded — exactly what an audit table is, and exactly what a JSON column read on every page load is not |
| API keys | `ApiKey` (existing) | — |
| Webhook endpoints | `WebhookEndpoint` (existing) | — |

`modules/integrations/connections.ts` owns the read/write of that JSON blob and
is a pure module: it takes the parsed settings value and returns a new one.
Nothing about Prisma reaches it, which is what makes it testable without a
database.

---

## 3. Security

### API keys and scopes

A raw key is HMAC-SHA256'd with `API_KEY_PEPPER` and matched against
`ApiKey.hashedKey`. The raw value is shown once, at creation, and is not
recoverable — there is no "reveal" anywhere in the product.

Scopes are listed in `modules/integrations/scopes.ts`. Three decisions worth
knowing:

- **`students:write` does not imply `students:read`.** A credential that
  pushes enrolments from an SIS has no business downloading the roster. Least
  privilege costs one extra checkbox and removes a class of silent
  over-permission.
- **There is no wildcard scope.** A `*` is an unrestricted API with a
  scope-shaped label: it silently widens every time a new resource ships.
  Granting everything is still possible — by listing it, which is a decision
  someone makes rather than one they inherit.
- **Most resources are read-only.** Academic structure is *defined* here or
  imported with a human approving a preview, not overwritten by whatever an
  external system POSTs overnight.

### OAuth2 and service accounts

`/api/v1/oauth/token` is reserved and answers `501` with a sentence naming the
method that works today. This is architecture, not a stub: `ApiKeyContext`
records *how* a caller proved itself (`authMethod` already has
`oauth2_client_credentials` and `service_account` as values), and every
authorization check reads `ctx.apiKey.scopes`. Landing OAuth2 means producing
that same context from a token. No authorization code changes.

### Rate limiting

`modules/integrations/rate-limit.ts` is a token bucket behind a `RateLimiter`
interface. Reads get `DEFAULT_RATE_LIMIT` (burst 240, 120/min); writes get
`WRITE_RATE_LIMIT` (burst 60, 60/min). Every response carries the IETF draft
`RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a rejection is
`429` with `Retry-After` in whole seconds, rounded *up* — rounding down
produces a retry that arrives fractionally early and is denied again, which is
how a well-behaved client ends up looking like an abusive one.

The shipped implementation is in-memory, and the limit is therefore per
process: on *n* instances the real ceiling is *n × limit*. This is stated in
the module's doc comment rather than left for someone to discover under load.
Moving to Redis means implementing `RateLimiter` and swapping the export —
`api-route.ts` does not know which backend it is talking to. See
[ADR 0007](adr/0007-in-process-webhooks-and-in-memory-rate-limiting.md).

### What is never logged

> *"Never log: passwords, secrets, biometric embeddings, sensitive tokens."*

`modules/integrations/redaction.ts` is applied to every audit payload the Hub
writes, on both the `before` and `after` halves. It replaces sensitive values
with a fixed `[redacted]` string — never length-preserving, never a "last 4"
hint, because both of those leak.

Two things follow from this that are easy to get backwards:

1. **An audit log that faithfully records a credential is a credential store
   with worse access controls than the one it copied from.** So the audit row
   for "admin changed the ERP token" records that the token changed, not what
   it changed to.
2. **No face embedding, classroom photo, AI confidence or AI result ever
   crosses an integration boundary.** Not in a webhook payload, not in an API
   response, not in an audit row. `attendance-review/service.test.ts` asserts
   this against the serialized wire format rather than trusting a comment:
   *"no outbound payload carries an AI confidence, AI result or image."*

---

## 4. Outbound webhooks

Events: `student.created`, `student.updated`, `student.deactivated`,
`attendance.created`, `attendance.updated`, `attendance.finalized`,
`attendance.corrected`.

- **Signing.** Each endpoint has its own secret. The body is signed
  HMAC-SHA256 and sent as
  `X-Attendance-Signature: t=<unix>,v1=<hex>`, so a receiver can bind the
  signature to a timestamp and reject a replay. The header carries a *list* of
  `v1=` values, which is what lets a secret be rotated without downtime: both
  the old and the new signature are sent until the receiver has switched
  (`webhook-signature.ts`).
- **Idempotency.** Every delivery carries a stable event id. A receiver that
  gets the same id twice — because we retried after a timeout that actually
  succeeded — can drop the second.
- **Retries.** Exponential backoff, bounded attempts. Delivery status and
  failure reason land in `AuditLog` as
  `webhook.delivery.succeeded` / `webhook.delivery.failed`.
- **Most specific event wins.** A correction emits `attendance.corrected` and
  *not* `attendance.updated`. An endpoint subscribed to both must not receive
  the same change twice — asserted in
  `attendance-review/service.test.ts`.

Dispatch is in-process. See
[ADR 0007](adr/0007-in-process-webhooks-and-in-memory-rate-limiting.md) for
what that means and what it costs.

---

## 5. Field mapping

The external column names are theirs; the target fields are ours. Defaults:

| Their column | Our field |
| --- | --- |
| `student_id` | `student.externalId` |
| `student_name` | `student.name` |
| `class_code` | `class.externalCode` |
| `section_code` | `section.externalCode` |
| `subject_code` | `subject.externalCode` |

Custom mappings are the normal case — `ADM_NO`, `Roll No.` and `PUPIL_NAME`
are all real. So the source side of the editor is free text (or a dropdown of
the file's actual headers, in the import wizard) and the target side is a
fixed list, because those are the fields this platform has. Letting someone
type a target means letting them save a mapping that fails overnight instead
of failing now.

`validateMapping` runs at save **and on every render**. A mapping saved by an
older build can name a target this one no longer has, and an administrator
should see that on the screen rather than in a sync failure.

A mapping with any problem is rejected whole. A half-valid mapping is the
state in which a sync runs and writes the wrong columns.

---

## 6. Import and export

`/dashboard/integrations/import` — upload, preview, map, commit, summary.

- **CSV and Excel (.xlsx)**, both parsed by hand-written readers
  (`csv.ts`, `xlsx.ts`) — the Hub added zero npm dependencies. Format is
  sniffed from the bytes, not the file extension.
- **Preview writes nothing.** It parses, maps, and diffs against the roster,
  then reports create / update / unchanged / duplicate / error counts, with
  the file's own line numbers so someone can open the spreadsheet and go
  straight to the problem.
- **The preview's numbers are the commit's numbers** — both call
  `planStudentImport` over the same bytes. Asserted in
  `center-service.test.ts`.
- **A file whose mapping does not validate is not diffed at all.** A preview
  showing "0 create, 0 update" beside four mapping errors reads as "nothing to
  do" rather than "fix the mapping first".
- **Duplicates inside one file are reported, not resolved.** Last-write-wins
  on a duplicate admission number is how two students become one.
- **A blank column never erases a stored value.** The single most destructive
  thing a well-meaning import can do is blank a field for every student, and
  it looks like a success while doing it.
- **Row by row, not one transaction.** An import of 1,200 rows where row 900
  collides should write 1,199 students and report one failure, not roll back an
  afternoon's work. Every partial outcome is surfaced and lands in a
  downloadable error report.
- **Error reports carry our sentence, not the driver's.** A Prisma message
  names tables, columns and sometimes the conflicting value; an error report
  is a file an administrator emails to a vendor.

---

## 7. Sync

Three modes, one code path:

- **Manual** — the *Sync now* button. Ignores the interval gate; that is what
  the button is for.
- **Scheduled** — a full pull on an interval.
- **Incremental** — only what changed since the last successful run, for
  providers that declare `incremental`.

`planSync` decides whether a run should happen and in which mode; `runSync`
executes it. Manual and scheduled runs take the same path, so "it works when I
click it but not overnight" is not a class of bug here.

Two bounds worth naming: a run walks at most `SYNC_MAX_PAGES` pages, so a
provider whose `nextCursor` never goes null cannot pin the server; and hitting
that ceiling is reported as a **partial** run rather than hidden, because a
truncated sync that claims success is how a roster silently stops at 20,000
students.

Every run writes `integration.sync.started` **before** the work and
`integration.sync.completed` / `.failed` after. A run killed mid-pull leaves a
`started` with no matching `completed` — which is precisely the shape an
operator needs to see. A single row written at the end would make a crashed
sync indistinguishable from one that never began.

---

## 8. The Integration Center

`/dashboard/integrations`, gated on `institution.read`; every control on it is
gated on `institution.update` in the service. A read-only viewer gets a page
that tells them the truth about what is connected rather than a row of buttons
that all fail.

**No new permission key was invented.** `PERMISSIONS` is code, but the
role→permission rows are *data*, seeded once. An `integration.manage` key
would exist in this build and in nobody's database, so every existing
administrator would be locked out of the feature on the day it shipped.

Two gating decisions that look wrong and are not:

- **Test connection needs `institution.update`, not `.read`.** Testing makes
  an outbound request from our server to a URL in the configuration. That is
  an action, not a lookup, and a read-only viewer must not be able to make
  this server call an arbitrary host.
- **Preview needs `student.read`.** Diffing a file against the roster reveals
  which student codes already exist.

Credentials are rendered through `describeConfig`, which masks them, and edited
through `mergeConfig`, where **a blank submitted value means "leave it
alone"** — the form cannot render the stored token, so it cannot echo it back.
Removing one is an explicit *Remove*, not an empty box.

An unknown or cross-tenant connection id returns the same sentence — *"That
integration no longer exists."* — whether it is missing or belongs to another
institution, so ids cannot be probed.

Student writes are delegated to the existing students service rather than
reimplemented. It brings its own authorization, its own audit rows and its own
outbound webhooks, so an imported student is indistinguishable from one typed
into the UI.

---

## 9. What this phase did not do

Stated plainly so nobody has to find out by looking:

- **Sync writes students only.** `SYNCABLE_RESOURCES = ["students"]`, and
  anything else is refused with a sentence. An administrator is never offered
  a checkbox that quietly does nothing.
- **Connections cannot be created over the API**, only read
  (`integrations:read`). An API that let one integration create another would
  let a compromised key establish persistent outbound access to a server of
  its choosing.
- **No scheduler process ships.** `SCHEDULED` and `INCREMENTAL` connections
  are ready to run and the interval gate is enforced, but something external
  has to call the sync. The trigger distinction is already plumbed through
  (`trigger: "scheduled"`).
- **OAuth2 is reserved, not implemented** (§3).
- **Rate limiting is per process** (§3).

---

## 10. Where the code lives

```
modules/integrations/
  types.ts              shapes shared across the module
  scopes.ts             API scope catalogue + resource mapping    (pure)
  api-key-auth.ts       Bearer key → ApiKeyContext
  api-route.ts          the /api/v1 wrapper: auth, scope, rate limit, audit
  rate-limit.ts         token bucket behind a RateLimiter interface (pure)
  pagination.ts         cursor/limit handling                     (pure)
  redaction.ts          what never reaches a log                  (pure)
  connections.ts        the settings blob: read, merge, describe  (pure)
  field-mapping.ts      targets, defaults, validation             (pure)
  csv.ts / xlsx.ts      hand-written readers, zero dependencies   (pure)
  import-pipeline.ts    preview, plan, error report               (pure)
  sync.ts               planSync / summariseRun / describeRun     (pure)
  webhook-signature.ts  HMAC signing + verification               (pure)
  webhook-delivery.ts   retry policy, delivery state              (pure)
  webhook-dispatcher.ts fan-out (touches Prisma)
  repository.ts         thin Prisma reads for the API
  service.ts            /api/v1 endpoints: ApiKeyContext in, envelopes out
  center-service.ts     Integration Center: SessionUser in, view models out
  actions.ts            Server Actions — a boundary, not a decision point
  providers/            provider.ts, registry.ts, and the adapters

app/dashboard/integrations/     the Integration Center UI
app/dashboard/integrations/import/  the import wizard
app/api/v1/                     the public API routes
```

`service.ts` and `center-service.ts` are deliberately separate. One takes an
`ApiKeyContext` authorized by scope and returns wire envelopes; the other
takes a `SessionUser` authorized by permission and returns view models.
Sharing one module would mean every function taking a union of two actor types
and branching on it — which is exactly how an authorization check ends up on
the wrong side of an `if`.
