# Release readiness

**Consolidated 2026-09-21 at commit `0be4364`.** This document is a factual
release picture for a human decision-maker. It does not make the deployment
decision.

Every claim uses one of: **PROVEN**, **PROVEN WITH LIMITATIONS**, **NOT
PROVEN**, **BLOCKED**, **NOT TESTED**. "Configured" is never written as
"verified", and a local measurement is never written as a production
guarantee.

---

## 1. Executive status

The engineering platform is substantially complete and, at HEAD, has no
identified blocking engineering work. It is **not cleared for production
release**, for two reasons that no amount of further engineering resolves:
the face model's training-data provenance is unresolved, and real-world
recognition accuracy has never been measured.

There is also a third fact that outranks both in immediate operational
importance:

> **Production is running Phase-5-era code. None of the last 13 commits —
> including the Phase 14 security fixes — has ever been deployed.**

The deployed web revision `attendance-prod-web--0000007` (created
2026-09-20T10:30:28Z) serves the image built from `cc0c5a0`, which is
`origin/main`. Every commit from Phase 6 onward exists only locally.

## 2. Git state

| | |
| --- | --- |
| HEAD | `0be4364` feat(attendance): verify cross-instance SSE failover |
| Branch | `main` |
| `origin/main` | `cc0c5a0` feat(attendance): production classroom capture and recognition |
| Local commits ahead | **13** |
| Working tree | clean |
| Pushed | **nothing** |

## 3. Phase history (local, unpushed)

| Phase | Commit | Subject |
| --- | --- | --- |
| 6 | `6fe5111` | enforce human-reviewed attendance decisions |
| 7 | `71a30dc` | student and faculty portals |
| 8 | `3c8a9db` | reporting and analytics |
| 9 | `48bcfa3` | offline-first school attendance |
| 10 | `802866e` | integration hub and public API |
| 11 | `e2d17b3` | security and biometric privacy hardening |
| 12 | `0949de4` | real-world face recognition benchmarking |
| 13 | `dbdb685` | platform admin dashboard |
| 14 | `8d66229` | QA, security hardening, regression validation |
| 15 | `d71af07` | distributed production hardening |
| 16 | `b221dee` | resilient SSE reconnect |
| 17 | `0be4364` | cross-instance SSE failover verification |

## 4. Release-readiness matrix

Evidence types are distinguished: *unit* (no I/O), *DB-backed* (real
Postgres), *two-process* / *two-instance* (separate OS processes), *browser*
(real Chrome), *static* (code inspection only).

| # | Subsystem | Status | Evidence | Blocks release |
| --- | --- | --- | --- | --- |
| 1 | Authentication | PROVEN | DB-backed + browser; unauthenticated routes 307 → `/login` (Ph14) | No |
| 2 | Session security | PROVEN | Cookie `httpOnly`/`sameSite=lax`/`secure` in prod; `document.cookie` empty in browser (Ph14, re-checked Ph18) | No |
| 3 | RBAC | PROVEN | 8 roles; faculty blocked from 9 privileged routes; student blocked from all staff routes (Ph14 browser) | No |
| 4 | Tenant isolation | PROVEN | Cross-tenant read/write 404 over HTTP with a real API key; 403 on foreign SSE channels (Ph14, Ph17) | No |
| 5 | Platform admin | PROVEN | 14 DB-backed access tests, all 6 entry points × 4 unauthorized roles (Ph13) | No |
| 6 | Institution admin | PROVEN | Ph13 suite + browser | No |
| 7 | School workflows | PROVEN WITH LIMITATIONS | Exercised locally; no pilot-school data | No |
| 8 | College workflows | PROVEN WITH LIMITATIONS | Same | No |
| 9 | Student management | PROVEN | Ph14 suite | No |
| 10 | Faculty management | PROVEN | Ph14 suite | No |
| 11 | Academic structure | PROVEN | Ph14 suite | No |
| 12 | Face enrollment | PROVEN WITH LIMITATIONS | Pipeline proven; runs against stub/mock model | No |
| 13 | Face detection | PROVEN WITH LIMITATIONS | YuNet integrated (Ph5); accuracy unmeasured | See #48 |
| 14 | Face alignment | PROVEN WITH LIMITATIONS | Same | See #48 |
| 15 | Face embedding | PROVEN WITH LIMITATIONS | SFace integrated; 128-d, normalised | See #48 |
| 16 | Cohort-scoped candidate search | PROVEN | DB-backed; cross-cohort/-tenant candidates rejected | No |
| 17 | Recognition decision engine | PROVEN | Unit + DB-backed (Ph6) | No |
| 18 | `NEEDS_REVIEW` invariant | PROVEN | Re-verified at HEAD: 7 `NEEDS_REVIEW` branches in `decideCandidate`, **zero** `PRESENT`/`ABSENT`; 6 total write sites | No |
| 19 | Attendance finalization | PROVEN | DB-backed race: 8 concurrent → 1 winner, 7 `session_status_conflict` (Ph14) | No |
| 20 | Attendance correction | PROVEN | CAS via `updateMany` + `count===0` (Ph10, Ph14) | No |
| 21 | Attendance concurrency | PROVEN | Real Postgres, not stubs (Ph14) | No |
| 22 | Student portal | PROVEN | Browser, 4 widths | No |
| 23 | Faculty portal | PROVEN | Browser, 4 widths | No |
| 24 | Reporting | PROVEN | DB-backed; filters narrow, never widen (Ph8) | No |
| 25 | Export | PROVEN | CSV formula injection fixed + regression tests (Ph14) | No |
| 26 | Offline-first workflow | PROVEN | Browser against production build (Ph9, re-checked Ph16/17) | No |
| 27 | Offline account binding | PROVEN | Quarantine observed in browser after account switch (Ph14) | No |
| 28 | Offline sync/idempotency | PROVEN | DB-backed idempotency keys (Ph9/10) | No |
| 29 | Integration API | PROVEN | Real HTTP with a minted key (Ph14) | No |
| 30 | API key security | PROVEN | HMAC-peppered; expiry + revocation enforced (Ph11) | No |
| 31 | Webhook signing | PROVEN | Unit + DB-backed (Ph10/11) | No |
| 32 | Webhook secret encryption | PROVEN | AES-256-GCM envelope, versioned (Ph11) | No |
| 33 | SSRF protection | PROVEN | DNS-pinned; metadata/loopback blocked; scheme + URL credentials rejected. Private ranges allowed **by documented decision** for on-prem ERP | No |
| 34 | API rate limiting | PROVEN | 429 + `Retry-After` + `RateLimit-*` (Ph10) | No |
| 35 | Distributed rate limiting | PROVEN | **Two-instance**: 300 requests → 240 allowed / 60 × 429; control run with `memory` backend allowed all 300 (Ph15, re-run Ph17) | No |
| 36 | Realtime publisher | PROVEN | **Two-instance** LISTEN/NOTIFY, both directions (Ph15) | No |
| 37 | SSE reconnect | PROVEN | Browser; bounded backoff 1s→30s + jitter; silence watchdog (Ph16) | No |
| 38 | SSE reconciliation | PROVEN | DB changed while **no app process existed** → UI corrected on reconnect (Ph16) | No |
| 39 | Cross-instance SSE failover | PROVEN | **nginx + two instances**; routing ledger shows `-> 3101` then `-> 3101, 3102`; both directions, both channels (Ph17) | No |
| 40 | Browser responsiveness | PROVEN | 390/820/1440/1800, no page-level horizontal scroll | No |
| 41 | Accessibility | PROVEN WITH LIMITATIONS | Labels, accessible names, `role="status"`, non-colour-only status. **No screen-reader or axe audit run** | No |
| 42 | XSS protection | PROVEN | Stored payloads inert in browser; no `dangerouslySetInnerHTML` (Ph14) | No |
| 43 | Security headers | PROVEN | Verified on real responses incl. HSTS. **CSP deliberately limited to `frame-ancestors`** — documented, not an oversight | No |
| 44 | Biometric data handling | PROVEN | No embeddings in API/SSE/exports/logs/IndexedDB (Ph11, Ph14, Ph16) | No |
| 45 | Logging / redaction | PROVEN | Header allowlist; `embedding` denylist; `authorization: [present]` | No |
| 46 | Face-AI statelessness | PROVEN | Static: no DB driver, no file writes, no module state (Ph14) | No |
| 47 | Face-model production eligibility | **BLOCKED** | `productionEligible=false`; `commercial_use="unclear"` | **YES** |
| 48 | Recognition accuracy | **BLOCKED** | Never measured; no consented dataset | **YES** |
| 49 | Performance | PROVEN WITH LIMITATIONS | Measured on a **local Apple Silicon laptop**, not Azure | No |
| 50 | Database migrations | PROVEN | 10 migrations apply from zero (26 tables, pgvector 0.8.6); existing DB no drift | No |
| 51 | Production build | PROVEN | `next build` succeeds at HEAD | No |
| 52 | Docker images | NOT TESTED | **Docker is not installed on this machine.** CI builds all four images on every push/PR | No |
| 53 | CI | PROVEN WITH LIMITATIONS | Every CI step reproduced locally and passes; the workflow itself not executed | No |
| 54 | CD | NOT PROVEN | Never run against this commit. Deliberately not triggered | No |
| 55 | Azure infrastructure | PROVEN WITH LIMITATIONS | Read-only inspection; Bicep compiles; params parse. Not deployed | No |
| 56 | Production observability | PROVEN WITH LIMITATIONS | Log Analytics + App Insights + a Failure-Anomalies rule exist. **No alert routing verified** | No |
| 57 | Backup / recovery | PROVEN WITH LIMITATIONS | 14-day retention, geo-redundant **Enabled**, HA **Disabled**. **Restore never tested** | No |
| 58 | Deployment rollback | PROVEN WITH LIMITATIONS | App revisions roll back; **migrations do not** | No |
| 59 | Production smoke testing | NOT TESTED | Checklist below, unexecuted | No |
| 60 | Operational runbook | PROVEN WITH LIMITATIONS | `docs/RUNBOOK_DEPLOYMENT.md` exists; not rehearsed end-to-end | No |

## 5. The two blockers

### BLOCKER 1 — Face-model training-data provenance / commercial clearance

**Status: UNRESOLVED.**

What the repository already establishes (`services/face-ai/app/models/LICENSING.md`,
ADR-0005, ADR-0006), verified against the projects' own published terms:

| Component | Licence | Commercial use |
| --- | --- | --- |
| InsightFace source code | MIT | Permitted |
| InsightFace training data + pretrained models | Non-commercial research only | **Not permitted** |
| ONNX Runtime | MIT | Permitted |

The MIT licence on the code does not extend to the weights. `buffalo_l`,
`antelopev2` and the other pretrained packs are **not** cleared for commercial
use here. The `OpenCVFaceModelProvider` (YuNet + SFace) that performs real
recognition is marked `commercial_use = "unclear"`, and
`FACE_AI_REQUIRE_PRODUCTION_MODEL=true` refuses to start on it — a guard that
is still in place and must not be removed.

**Missing:** an authoritative licence determination for the exact weights
intended for production, and a recorded decision that they may be used
commercially in this product.

**Who must provide it:** the product owner, with legal input — either by
obtaining a commercial licence from the model's publisher, selecting
differently-licensed weights, or training on a licensed dataset. **This is not
an engineering task.**

### BLOCKER 2 — Real-world recognition accuracy

**Status: UNMEASURED.**

Phase 12 measured *pipeline* performance and correctness. It did not measure
recognition accuracy, and no FAR, FRR, EER, ROC/AUC, precision, recall,
per-demographic figure or validated threshold exists anywhere in this
repository. **None is asserted here.**

A defensible evaluation requires, at minimum:

- a consented, authorised, labelled dataset with documented provenance;
- enrolment and test sets that are **disjoint** by identity capture;
- representative classroom conditions: lighting, pose, distance, partial
  occlusion, multiple faces per frame, small/far faces;
- genuine non-match cases, including look-alikes and non-enrolled people;
- acceptance criteria agreed **before** evaluation, not chosen to fit results;
- threshold selection methodology stated up front, with FAR/FRR/EER reported
  at the chosen operating point;
- explicit handling of the `UNCERTAIN` band, which exists precisely so the
  system can decline to decide.

**No biometric data has been collected for this, and none should be gathered
without a consent and retention basis agreed first.**

## 6. Newly discovered in this phase

**Production is running undeployed-from code.** The newest ACR tag for `web`
is `cc0c5a0eb805…`, matching `origin/main`; the active revision was built from
it. Consequences, stated plainly:

- The Phase 14 **cross-tenant role-assignment privilege escalation is present
  in the deployed revision.** An institution admin there can grant roles —
  including INSTITUTION_ADMIN — to a user in another tenant. Fixed locally in
  `8d66229`; **not in production**.
- The Phase 14 CSV formula injection and NUL-byte 500 are likewise unfixed in
  production.
- Production runs the **in-memory** rate limiter and realtime publisher, at
  `maxReplicas: 5` (confirmed read-only). So the API's real ceiling there is
  up to 5× the configured limit, and realtime events reach roughly one replica's
  worth of connected clients.

**Migration ordering observation (not a defect):**
`20260920181329_rate_limit_bucket` sorts before three migrations authored in
earlier phases. Prisma tracks applied migrations by name, so `migrate deploy`
applies pending ones regardless of order; the table is standalone with no
foreign keys, and a fresh-database run applied all 10 cleanly. No action
required.

**Environment observation:** `RATE_LIMIT_BACKEND` and `REALTIME_BACKEND` are
validated by the app but are **not set** on the Container App. They default to
`postgres`, which is the correct production value, so this is safe — but the
correct behaviour currently depends on a default rather than on explicit
configuration.

## 7. Distributed runtime evidence

| Property | How proven |
| --- | --- |
| Shared rate limit across instances | Two OS processes, one Postgres: 240 allowed / 60 × 429 against burst 240. Control with `RATE_LIMIT_BACKEND=memory` allowed all 300 |
| Limiter atomicity | 40 concurrent `consume` on one key → exactly 10 allowed against burst 10 |
| Limiter survives restart | Spend 200, restart instance, 80 more → 76 allowed then refused |
| Cross-instance event delivery | `pg_notify` A→B and B→A, browser SSE on the other instance |
| Reconnect after instance death | Browser recovered with no reload; second `EventSource` created, exactly two ever |
| Reconciliation without an event | DB changed while **no app process existed**; UI corrected on reconnect |
| Cross-instance failover | nginx ledger: `-> 3101`, then `-> 3101, 3102`, then back to `3101` |
| Terminal auth on reconnect | Role revoked while disconnected → 2 × 403 then silence for 63 s |

Delivery remains **at-most-once**; ordering is per-listener; PostgreSQL is
authoritative. No exactly-once, zero-loss or replay guarantee is claimed.

## 8. Performance — local development machine only

Measured 2026-09-17 on an Apple Silicon laptop, Node v26. **These are not
Azure production figures and must not be quoted as such.**

| Measurement | Value |
| --- | --- |
| Candidate scan, 100 candidates | 1.68 ms mean / 1.93 ms p95 (≈16.8 µs each) |
| Candidate scan, 2000 candidates | 29.67 ms mean / 34.99 ms p95 |
| detect-embed, 1 image (949 KB) | 3.09 ms mean / 3.49 ms p95 |
| Rate-limit decision (Postgres) | 0.126 ms mean / 0.201 ms p95 / 0.323 ms p99 |
| 200 concurrent limiter decisions | 21.9 ms total (0.110 ms/op) |
| `pg_notify` publish | 0.098 ms mean |
| Cross-instance publish → deliver | 0.487 ms mean / 0.768 ms p95 |

## 9. Database readiness

- 10 migrations, `migrate deploy` only. **No destructive DDL**: the 12 `DROP`
  statements are all `DROP INDEX`.
- Fresh database: all 10 apply → 26 tables, pgvector 0.8.6, status clean.
- Existing local database: up to date, no drift.
- Production migration runs as a dedicated Container Apps Job inside the VNet,
  `replicaRetryLimit: 0`, `parallelism: 1`, 1800 s timeout.
- `Dockerfile.migrate` pins `CMD ["npx","prisma","migrate","deploy"]`.
  `migrate dev`, `db push` and `migrate reset` are excluded by construction.
- **Not executed against production.**

## 10. Bootstrap safety

`scripts/bootstrap-production.ts` has three stages (`inspect`, `system`,
`tenant`), requires `BOOTSTRAP_TARGET=production` **and**
`BOOTSTRAP_CONFIRM=WRITE-TO-PRODUCTION`, and is invoked by no CI step — it runs
only when a person runs it. **Not executed.** Order: migrate → `inspect` →
`system` → `tenant`, with human approval before each writing stage.

## 11. CI / CD dry-run

Every CI step reproduced locally at HEAD, all passing (counts in §13). The
workflow itself was **not** triggered.

`deploy.yml` job graph: `validate` → `guard` → `build` → `migrate` → `deploy`
→ `verify`. Every Azure-touching job declares `environment: production`, so
each requires the environment's approval gate. `guard` refuses any ref except
`main` and asserts subscription, resource group and ownership tags before
anything is built.

Locally verified without deploying:

- `az bicep build infra/azure/main.bicep` → compiles (64,633 bytes ARM).
- `az bicep build-params production.bicepparam` → parses, 20 parameters.
- Both workflow YAML files parse; jobs enumerate as expected.

**DRY-RUN NOT EXECUTED FOR:** `az deployment group create`, `az containerapp
update`, `az containerapp job start`, `az acr build`, image push — all
state-changing.

**Docker image build: NOT TESTED.** Docker is not installed here. CI's `images`
job builds all four images on every push and PR, so buildability is covered
there, but not by this phase.

## 12. Rollback analysis

| Failure | Behaviour | Automated? |
| --- | --- | --- |
| Web image fails to build | `build` fails; nothing deployed | Yes (halt) |
| Face-AI image fails to build | Same | Yes (halt) |
| **Migration fails** | Job has `replicaRetryLimit: 0`; workflow halts; **previous revision keeps serving** | Halt only |
| Migration times out (>20 min) | Halts, explicitly not retried | Halt only |
| Health check fails | `verify` fails **after** traffic has shifted | **No automatic rollback** |
| Bad application revision | Container Apps revisions allow manual reactivation of the prior revision | **Manual** |
| DB migration incompatible with old revision | Not handled | **No** |

**Migrations are not reversible.** There is no down-migration path. A schema
change incompatible with the previously deployed revision cannot be undone by
rolling back the application — recovery would be a restore from backup, which
**has never been tested**. Migrations to date are additive, which limits but
does not eliminate this exposure.

## 13. Test counts at HEAD

| Suite | Result |
| --- | --- |
| `npm test --workspace=web` | 1865 tests, **1758 pass, 0 fail**, 107 skipped |
| `INTEGRATION_DB_TEST=1 REPORTING_DB_TEST=1` | 1865 tests, **1856 pass, 0 fail**, 9 skipped |
| `FACE_AI_INTEGRATION=1` | 1865 tests, **1767 pass, 0 fail**, 98 skipped |
| `scripts/integration-test.sh` (real FastAPI process) | **1767 pass, 0 fail** |
| `pytest` (face-ai) | **169 passed** |
| `ruff check` | clean |
| `tsc --noEmit` | 0 errors |
| `eslint --max-warnings=0` | clean |
| `prisma validate` / `migrate status` | valid / up to date |
| `next build` | succeeds |

Skips are gated integration tests, not failures: they require
`INTEGRATION_DB_TEST`, `REPORTING_DB_TEST` or `FACE_AI_INTEGRATION`.

## 14. Production environment variables

**No values appear in this document.** All secrets are Key Vault–backed and
injected as Container App `secretRef`s.

| Variable | Secret | Consumer | Source | Provisioned |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` | Yes | web, migrate, bootstrap | Key Vault → `database-url` | Yes |
| `AUTH_SECRET` | Yes | web | Key Vault → `auth-secret` | Yes |
| `API_KEY_PEPPER` | Yes | web | Key Vault → `api-key-pepper` | Yes |
| `FACE_AI_SERVICE_TOKEN` | Yes | web | Key Vault → `face-ai-service-token` | Yes |
| `FACE_AI_AUTH_TOKEN` | Yes | face-ai | Key Vault → `face-ai-auth-token` | Yes |
| `FACE_AI_SERVICE_URL` | No | web | Bicep (internal FQDN) | Yes |
| `FACE_AI_REQUIRE_AUTH` | No | face-ai | Bicep — currently `true` | Yes |
| `FACE_AI_REQUIRE_PRODUCTION_MODEL` | No | face-ai | Bicep — currently `False` | Yes |
| `FACE_MODEL_BACKEND` | No | face-ai | Bicep — currently `mock` | Yes |
| `LOCAL_AI_ENABLED` | No | web | Bicep — `false` | Yes |
| `NODE_ENV` | No | web | Bicep — `production` | Yes |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | Yes | web | Bicep / App Insights | Yes |
| `RATE_LIMIT_BACKEND` | No | web | **Not set — relies on `postgres` default** | No |
| `REALTIME_BACKEND` | No | web | **Not set — relies on `postgres` default** | No |

Rotation: the five Key Vault secrets are rotatable without code change;
`API_KEY_PEPPER` cannot be rotated without invalidating every issued API key,
and `WEBHOOK_SECRET_KEK` (where used) requires re-encryption of stored webhook
secrets. Neither rotation has been rehearsed.

## 15. Azure — read-only inspection

Subscription Pay-As-You-Go; resource group `attendance-production-rg`
(centralindia, Succeeded). **Nothing was created, updated or deleted.**

Present: `attendance-prod-web`, `attendance-prod-face-ai` (Container Apps),
`attendance-prod-migrate`, `attendance-prod-bootstrap` (Jobs),
`attendance-prod-psql`, `attendance-prod-keyvault`, `attendanceprodacr`,
`attendance-prod-cae`, `attendance-prod-vnet` + private DNS zone,
`attendance-prod-law`, `attendance-prod-appi`, `attendanceprodsa`, and a
Failure-Anomalies smart-detector rule.

| Observation | Value |
| --- | --- |
| Web ingress | external **true**, min 1 / **max 5** replicas |
| Face-AI ingress | external **false** (biometric boundary intact), min 1 / max 3 |
| Face-AI model backend | **`mock`** — production is not running real recognition |
| PostgreSQL | v17, GeneralPurpose, public access **Disabled**, state Ready |
| Backup | 14 days, geo-redundant **Enabled** |
| High availability | **Disabled** |

## 16. Deployment sequence (documented, not executed)

1. Resolve **Blocker 1** and **Blocker 2**, or deploy with face recognition
   left on the `mock` backend.
2. Human review of the 13 local commits.
3. Push `main` → `deploy.yml` runs `validate` (full CI).
4. `guard` — approval gate; refuses non-`main`; asserts subscription, RG and
   ownership tags.
5. `build` — three images to ACR, tagged with the commit SHA, digests resolved.
6. `migrate` — Container Apps Job runs `prisma migrate deploy` inside the VNet.
   **Halts the deployment on failure; previous revision keeps serving.**
7. `deploy` — Face-AI first, then web.
8. `verify` — revision digests match the commit, `/` and `/api/health` return
   200, PostgreSQL still private, security posture unchanged.
9. Manual smoke checklist (§17).
10. On failure after traffic shift: **manual** revision rollback.

No change to this order is recommended; the migrate-before-deploy ordering is
correct for additive migrations and is what the current set requires.

## 17. Production smoke checklist — NOT EXECUTED

Unauthenticated: `GET /` 200 · `GET /api/health` 200 · protected route
redirects to `/login` · security headers present · face-AI has no public FQDN.

Auth: login · logout · session survives a revision change · invalid password
refused.

Platform admin: dashboard counts are DB-derived · institution list · release
readiness shows outstanding blockers.

Faculty: class list · session create · capture · review board loads · single
correction · finalization · realtime update on a second client.

Student: portal loads · own attendance only · realtime update on correction.

Security: cross-tenant student 404/403 · foreign SSE channel 403 · unauthorized
route blocked · API key scope enforced · expired key refused.

Offline: shell loads offline · cached roster available · register usable ·
queue survives reload · sync on reconnect.

Face-AI: `/v1/health` · `/v1/model-info` reports `productionEligible` honestly.

> **Do not run biometric production testing until Blockers 1 and 2 are
> formally resolved.**

## 18. Monitoring and backup

**Monitoring — PROVEN WITH LIMITATIONS.** Log Analytics workspace,
Application Insights and a Failure-Anomalies smart-detector rule exist, and the
web app receives `APPLICATIONINSIGHTS_CONNECTION_STRING`. **Not verified:**
whether any alert routes to a human, dashboards, SLOs, or on-call. Existence of
a resource is not evidence that anyone would be told.

**Backup — PROVEN WITH LIMITATIONS.** 14-day retention with geo-redundant
backup Enabled; PITR is available within retention by virtue of Flexible
Server. High availability is **Disabled**, so a zone failure is an outage, not
a failover. **No restore has ever been performed or timed.** Recovery time
objective is therefore unknown.

## 19. Decision gates

| Gate | Meaning | State |
| --- | --- | --- |
| **A — Engineering** | Tests, build, lint, typecheck, migrations, distributed runtime | **PASSED** at `0be4364` |
| **B — Face-model legal/provenance** | Authoritative clearance for the exact weights | **NOT PASSED** |
| **C — Accuracy** | Measured against a consented dataset, criteria agreed first | **NOT PASSED** |
| **D — Production deployment** | Explicit human approval | **NOT REQUESTED** |

Gate A passing means the software builds and its behaviour is tested. It does
**not** imply B, C or D. Deploying with face recognition on the `mock` backend
is possible without B and C, and would carry the Phase 14 security fixes into
production — but that is a decision for the owner, not an engineering default.

## 20. Exact next actions

**For the product owner (non-engineering, blocking):**

1. Obtain an authoritative licence determination for the production face-model
   weights, and record the decision. (Blocker 1)
2. Decide whether to fund a consented, labelled accuracy dataset, and agree
   acceptance criteria before any evaluation. (Blocker 2)
3. Decide whether to deploy the 13 local commits **now with the `mock` face
   backend** — which would fix a live cross-tenant privilege escalation — or
   to hold everything until B and C resolve.

**For engineering, once a decision exists:**

4. Set `RATE_LIMIT_BACKEND=postgres` and `REALTIME_BACKEND=postgres`
   explicitly in `app.bicep` rather than relying on defaults.
5. Rehearse a PostgreSQL restore into a scratch server and record the timing.
6. Verify that an Application Insights alert actually reaches a person.
7. Consider enabling PostgreSQL HA if the availability target requires it.

**Engineering feature queue: no additional blocking work identified.**
