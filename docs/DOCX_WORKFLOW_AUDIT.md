# Implementation audit against the finalized workflow document

**Source of truth:** `Attendance_System_Architecture.pdf` — *"Finalized Requirement &
Architecture Reference"*, dated 10 September 2026, 15 pages.

**Audited commit:** `b0248538048f69b10d6fb64e9a5067cc66552b51` — the commit
currently deployed to production (`attendance-prod-web--0000008`,
`attendance-prod-face-ai--0000008`).

**Nothing was modified.** No source change, no schema change, no deployment, no
production write. This document is the only file added.

Evidence is labelled with how it was obtained:

| Label | Meaning |
| --- | --- |
| **SOURCE** | Read in the code at the audited commit |
| **TEST** | Proven by an automated test that passes at this commit |
| **BROWSER** | Observed in a real browser against a build of this commit |
| **LIVE** | Observed against the production deployment |
| **NOT TESTED** | Not exercised; stated rather than hidden |

---

## 1. Executive summary

The implemented system does everything the document's **Golden Rule** demands,
and in one respect does *more* than the document's own step-by-step text
describes. That single difference is the most important finding in this audit
and needs a product-owner decision, not an engineering fix.

- The document's §2.2 and Golden Rule say a confident AI match goes
  **directly to the Present list**, automatically confirmed.
- The implementation **never** auto-finalises anything. A 97 %-confidence match
  is recorded as `aiResult = PRESENT` with `finalResult = NEEDS_REVIEW`, and a
  teacher must confirm it before it becomes attendance.

This is stricter than the document, and consistent with the document's own
stated principle ("AI = Assistant, Teacher = Final Authority"). But it is a real
behavioural difference: a teacher must touch every student, not only the
uncertain ones. **Decision required — see §6 and §15.**

Everything else in the document is either implemented, implemented with a
documented deviation, or explicitly absent and named below. Two requirements
cannot be satisfied by engineering at all (face-model licensing, recognition
accuracy) and remain open release blockers.

## 2. Login / test account information

### Production — no usable account exists

**NO SAFE EXISTING DEMO CREDENTIAL FOUND for production.**

- The ten demo accounts live in `apps/web/scripts/dev-fixture.ts`, which carries
  a hard guard — `if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url))` → *"Refusing
  to run: DATABASE_URL does not point at localhost."* It is referenced by **no**
  workflow and no npm script. **SOURCE**
- Production users can only come from `scripts/bootstrap-production.ts`, which
  requires `BOOTSTRAP_TARGET=production` **and**
  `BOOTSTRAP_CONFIRM=WRITE-TO-PRODUCTION`, and is invoked by no CI step. **SOURCE**
- I did **not** attempt a production login. A *failed* login writes an
  `AuditLog` row (`modules/auth-tenancy/service.ts`), which would be creating
  production data for testing. **SOURCE**

**To demo against production you must deliberately create the first account**, by
running the bootstrap job's `system` stage and then `tenant` stage. That is a
human decision with a typed confirmation, and it is outside this audit's scope.

### Local — fully working, identical commit

Everything in §4–§9 below was verified against a build of the **same commit**
that is in production, with the seeded fixture:

- **URL:** `http://localhost:3101/login`
- **Password (all ten accounts):** `Password123!` — from `dev-fixture.ts`, a
  development-only constant, never valid anywhere but localhost.

| Account | Role | Institution |
| --- | --- | --- |
| `superadmin@platform.test` | PLATFORM_SUPER_ADMIN | (platform) |
| `admin@greenwood.test` | INSTITUTION_ADMIN | Greenwood High School |
| `principal@greenwood.test` | SCHOOL_ADMIN | Greenwood High School |
| `teacher@greenwood.test` | FACULTY | Greenwood High School |
| `classteacher@greenwood.test` | CLASS_TEACHER | Greenwood High School |
| `operator@greenwood.test` | ATTENDANCE_OPERATOR | Greenwood High School |
| `student@greenwood.test` | STUDENT | Greenwood High School |
| `admin@northfield.test` | COLLEGE_ADMIN | Northfield Institute of Technology |
| `faculty@northfield.test` | FACULTY | Northfield Institute of Technology |
| `student@northfield.test` | STUDENT | Northfield Institute of Technology |

Run `node --import ./scripts/register-test-loader.mjs scripts/dev-fixture.ts`
from `apps/web` with a localhost `DATABASE_URL` to (re)create them.

## 3. Actual system workflow, as implemented

```
Classroom camera  →  up to 3 captures  →  /v1/quality
        ↓
/v1/detect-embed  (detection · alignment · embedding, 128-d)
        ↓
cohort-scoped candidate search   (only students enrolled in THIS class)
        ↓
Confidence engine  →  MATCHED / UNCERTAIN / UNMATCHED
        ↓
every student written as  finalResult = NEEDS_REVIEW
          carrying  aiResult  +  aiConfidence  as a suggestion
        ↓
ATTENDANCE REVIEW BOARD   (teacher sees suggestion, score and reason)
        ↓
teacher decides each student  →  AttendanceCorrection + AuditLog row
        ↓
Confirm attendance   (disabled while any student is unresolved)
        ↓
FINAL ATTENDANCE  →  student portal · faculty portal · reports · webhooks
```

## 4. Requirement traceability matrix

| ID | DOCX requirement | Actual implementation | Evidence | Status | Difference |
| --- | --- | --- | --- | --- | --- |
| REQ-01 | Executive workflow: camera → AI → review → teacher → published | Implemented exactly as drawn, with one extra gate (REQ-11) | BROWSER, SOURCE | MATCH WITH IMPLEMENTATION IMPROVEMENT | AI never auto-publishes |
| REQ-02 | Classroom camera | `capture-client.tsx`, live `getUserMedia` preview, mounts before capture | SOURCE, TEST | MATCH | — |
| REQ-03 | Capture 1 / 2 / 3 photos | `MAX_CAPTURES_PER_SESSION = 3`; UI: "Capture photo N of 3" | SOURCE | MATCH | — |
| REQ-04 | Quality check | `/v1/quality` endpoint; `SessionImage.qualityScore` | SOURCE | MATCH | — |
| REQ-05 | Face detection | YuNet via `/v1/detect`, `/v1/detect-embed` | SOURCE | MATCH | Real model exists but production runs `mock` |
| REQ-06 | Face alignment | In the OpenCV provider pipeline before embedding | SOURCE | MATCH | Same `mock` caveat |
| REQ-07 | Face embedding | SFace, 128-d, unit-normalised | SOURCE, TEST | MATCH | DOCX assumed InsightFace/512-d |
| REQ-08 | Class-specific vector search | `enrollments: { some: { cohortId, status: "ACTIVE" } }` | SOURCE, TEST | MATCH | — |
| REQ-09 | Confidence engine | `decideCandidate` → MATCHED / UNCERTAIN / UNMATCHED + score | SOURCE, BROWSER | MATCH | — |
| REQ-10 | Attendance Review includes "Needs Review" | Review board with three lists; reason text per student | BROWSER | MATCH | — |
| REQ-11 | Confident match → **directly** to Present list | Written `NEEDS_REVIEW`; shown as an AI *suggestion*; needs teacher confirm | BROWSER (97 % student sat in Needs Review), SOURCE | **MISMATCH — stricter** | **Decision needed** |
| REQ-12 | Not detected / below threshold → Absent/Review | Both become `NEEDS_REVIEW` with a reason | BROWSER, SOURCE | MATCH | Never a silent Absent |
| REQ-13 | Teacher roll-call over the list | Review board lists each unresolved student with Present/Absent | BROWSER | MATCH | — |
| REQ-14 | [Mark Present] moves student to Present | Verified: 61 % student → Present | BROWSER | MATCH | — |
| REQ-15 | Manual Present → Absent | Same control set; CAS-guarded write | BROWSER, TEST | MATCH | — |
| REQ-16 | Manual Absent/Review → Present | Verified end to end | BROWSER | MATCH | — |
| REQ-17 | Final Attendance (published) | `Confirm attendance` **disabled** until 0 unresolved; then session → FINALIZED | BROWSER | MATCH WITH IMPLEMENTATION IMPROVEMENT | DOCX does not require the gate |
| REQ-18 | Student portal: instant update, subject-wise %, personal record | `/portal`, `/portal/attendance`, `/portal/subjects/[cohortSubjectId]`, SSE | SOURCE, BROWSER | MATCH | Only finalized sessions are shown |
| REQ-19 | Teacher portal: Present/Absent/Review lists, manual edit, history | Review board + `/dashboard/attendance/[cohortId]/history` | BROWSER | MATCH | — |
| REQ-20 | Permanent audit trail of every manual change | `AttendanceCorrection` (append-only) **and** `AuditLog`, both with actor + timestamp | BROWSER + DB | MATCH | Two independent trails |
| REQ-21 | AI = assistant, teacher = final authority | Structurally enforced: `decideCandidate` has no PRESENT/ABSENT branch | SOURCE, TEST | MATCH | Stronger than DOCX |
| REQ-22 | One-time face enrollment per student | Staff route + student self-enrol route | SOURCE | MATCH | — |
| REQ-23 | Encrypted/protected face template, not raw photos | `FaceEmbedding.embedding vector(128)`; templates never returned to any caller | SOURCE, TEST | PARTIAL | See §11 — classroom images have a `storageUrl`; templates are not separately encrypted at rest beyond DB-level protection |
| REQ-24 | Local/offline AI recognition | Supported via `LOCAL_AI_ENABLED` + a local node; **production has none**, so offline register is marked by hand | SOURCE, BROWSER | PARTIAL | See §12 |
| REQ-25 | Cloud sync after connectivity returns | IndexedDB queue + idempotent sync, owner-bound | SOURCE, TEST | MATCH | — |
| REQ-26 | Benchmark methodology (50 students, 10–20 photos) | Methodology built; **never run on real classroom data** | SOURCE | NOT IMPLEMENTED (data) | Blocker 2 |
| REQ-27 | Threshold benchmarking before locking model | Harness exists; thresholds not validated | SOURCE | NOT IMPLEMENTED (data) | Blocker 2 |
| REQ-28 | School workflow | `attendanceMode = DAILY` when type = SCHOOL | SOURCE | MATCH | — |
| REQ-29 | College workflow | `attendanceMode = SUBJECT_WISE` when type = COLLEGE | SOURCE | MATCH | — |
| REQ-30 | Subject-wise college attendance | `AttendanceSession.cohortSubjectId` set per lecture | SOURCE | MATCH | — |
| REQ-31 | School daily/class attendance | `cohortSubjectId = null` | SOURCE | MATCH | — |
| REQ-32 | Integration Hub | `/dashboard/integrations` Integration Center | SOURCE | MATCH | — |
| REQ-33 | ERP import | `import-pipeline.ts`, CSV + XLSX | SOURCE, TEST | MATCH | — |
| REQ-34 | ERP export / writeback | Outbound webhooks + read APIs | SOURCE, TEST | PARTIAL | Writeback is webhook/API pull, not an SFTP push |
| REQ-35 | Custom field mapping | `field-mapping.ts` | SOURCE, TEST | MATCH | — |
| REQ-36 | Versioned REST API `/api/v1/…` | 27 route files under `/api/v1` | SOURCE | MATCH | — |
| REQ-37 | API keys | HMAC-peppered, prefix, expiry, revocation | SOURCE, TEST | MATCH | — |
| REQ-38 | Scopes | Per-endpoint `scopes: [...]` | SOURCE, TEST | MATCH | — |
| REQ-39 | Rate limiting | Postgres-backed token bucket, shared across replicas | TEST (two-instance) | MATCH WITH IMPLEMENTATION IMPROVEMENT | DOCX only asked for "rate limits" |
| REQ-40 | Audit logs for integrations | `auditApiWrite`, redacted access log | SOURCE, TEST | MATCH | — |
| REQ-41 | Webhooks incl. `attendance.finalized` | All 7 DOCX events present + `attendance.corrected`, `student.deactivated` | SOURCE | MATCH | Superset |
| REQ-42 | Scheduled sync | `SCHEDULED` connection type with an interval gate; **no scheduler ships** | SOURCE | PARTIAL | Something external must call it (ADR-0007) |
| REQ-43 | CSV / Excel | `csv.ts`, `xlsx.ts` both import and export | SOURCE, TEST | MATCH | SFTP absent (see §9) |
| REQ-44 | One shared attendance engine | Single engine; only session shape differs | SOURCE | MATCH | — |
| REQ-45 | Python FastAPI Face-AI service | Separate service, stateless, internal-only | SOURCE, LIVE | MATCH | — |
| REQ-46 | ONNX Runtime | Used by the ONNX provider | SOURCE | MATCH | Production runs `mock` |
| REQ-47 | pgvector | `Unsupported("vector(128)")`, extension installed | SOURCE | MATCH | 128-d not 512-d |
| REQ-48 | PWA + IndexedDB offline queue | Service worker, IndexedDB, owner-bound queue | SOURCE, BROWSER | MATCH | — |
| REQ-49 | Realtime updates | SSE, Postgres `LISTEN/NOTIFY`, cross-instance | TEST, BROWSER | MATCH WITH IMPLEMENTATION IMPROVEMENT | DOCX said WebSocket/SSE |
| REQ-50 | POC workflow (10–20 students, 1 photo, classify, route to teacher) | Every step implemented; never run on real students | SOURCE | NOT TESTED | Needs consented data |
| REQ-51* | OAuth 2.0 | `/api/v1/oauth/token`, client-credentials | SOURCE, TEST | PARTIAL | Client-credentials only; no authorization-code flow |
| REQ-52* | SFTP import/export | — | SOURCE | **NOT IMPLEMENTED** | Listed in DOCX §8 tech stack |
| REQ-53* | `/api/v1/courses` endpoint | Modelled as `AcademicUnit(kind=COURSE)`; exposed as `/programs` and `/subjects` | SOURCE | PARTIAL | Endpoint name differs |

`*` = requirement present in the document but absent from the supplied checklist.

## 5. Exact differences

1. **Confident match is not auto-published.** DOCX: "Automatically confirmed by
   the Confidence Engine → Added directly to the Present List." Implementation:
   every student is `NEEDS_REVIEW` until a human decides. Observed in the
   browser — a 97 % match sat in Needs Review with Present: 0. **MISMATCH.**
2. **Finalisation is gated.** `Confirm attendance` stays disabled while any
   student is unresolved. The DOCX does not require this. **Improvement.**
3. **Embeddings are 128-d SFace, not InsightFace 512-d.** The DOCX names
   InsightFace as the "first candidate to evaluate"; Phase 5 selected YuNet +
   SFace instead, and Phase 6 recorded why. Both remain unvalidated for
   accuracy.
4. **SFTP is absent.** Listed in the DOCX tech stack; not built.
5. **No scheduler ships.** `SCHEDULED` sync enforces its interval but something
   external must trigger it.
6. **`/api/v1/courses` does not exist by that name** — college course structure
   is `/programs` and `/subjects`.
7. **OAuth 2.0 is client-credentials only.**
8. **Offline recognition is unavailable in production** — see §12.

## 6. Contradictions inside the document

**These are contradictions in the source document, not implementation defects.
I am not resolving them.**

### Contradiction A — auto-Present vs. never-silent

| Location | Wording |
| --- | --- |
| §2.2, Present column | *"Automatically confirmed by the Confidence Engine. → Added directly to the Present List."* |
| Golden Rule, line 1 | *"AI-detected → Present"* |
| Golden Rule, line 3 | *"Teacher verification is always the final authority"* |
| §6 Principle | *"AI = Assistant. Teacher = Final Authority."* |

Lines 1 and 3 of the Golden Rule pull in opposite directions: if AI-detected
becomes Present automatically, the teacher is not the authority on that
student — they are only the authority on the uncertain ones.

- **DOCX wording:** confident match → Present, no human step.
- **Current implementation:** confident match → Needs Review with a PRESENT
  suggestion; becomes Present only when a teacher confirms, individually or by
  confirming the register (which records them as the actor either way).
- **Recommended interpretation:** *not mine to choose.* **Product-owner
  clarification required** — see §15, Decision 1.

### Contradiction B — Absent list vs. Review list

§2.2 puts undetected/low-confidence students on the **Absent List** and has the
teacher move them to Present. The Golden Rule and §6 call the same group
**"Absent / Review"** and insist it is never a final Absent. §6's table maps
74 % and 52 % to **REVIEW**, not Absent.

The implementation resolves this as **Review** (`NEEDS_REVIEW`), never writing a
provisional Absent. That matches the Golden Rule and §6 and contradicts §2.2's
literal wording. Flagged because the demo script a client sees will differ
depending on which the owner meant.

### Contradiction C — "illustrative" thresholds

§6 states the confidence figures are illustrative and §5 says thresholds are set
by benchmarking. No benchmark has been run, so **no threshold in the system is
validated**. The shipped defaults are engineering judgement, not measurement.

## 7. Production-verified flows (LIVE)

Against `https://attendance-prod-web.jollymushroom-eaa03ecb.centralindia.azurecontainerapps.io`:

- `GET /` → 200; `GET /api/health` → 200 `{"status":"ok"}`
- Security headers present: HSTS, `X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`
- `/dashboard`, `/dashboard/platform`, `/dashboard/students`, `/portal`,
  `/dashboard/audit-logs` → **307 → /login** when unauthenticated
- `/api/v1/students` → **401** with no key and with a bogus bearer
- Face-AI: `external: false`, `FACE_MODEL_BACKEND=mock`
- Responsive at 390 / 820 / 1440 / 1800: no horizontal overflow, login form
  usable, all inputs labelled, **no console errors**, no sensitive data in DOM

## 8. Source-verified but production-untested flows

Everything authenticated. Verified in a **browser against a build of the same
commit**, not against production, because production has no account and creating
one is a deliberate act:

- Faculty login and role-scoped routing
- Review board rendering, confidence display, per-student decisions
- Manual correction in both directions
- Finalisation gating and completion
- Audit trail writes
- Student portal listing of finalized sessions

## 9. Not implemented

| Requirement | Note |
| --- | --- |
| SFTP import/export | In the DOCX tech stack; absent |
| `/api/v1/courses` | Named differently (`/programs`, `/subjects`) |
| OAuth 2.0 authorization-code | Only client-credentials |
| Sync scheduler | Interval enforced, trigger not shipped |
| Classroom benchmark (REQ-26/27) | Methodology only; no data |
| POC on real students (REQ-50) | Every step exists; never run |

## 10. Security findings

No new defect found. Re-verified at this commit:

| Control | Evidence |
| --- | --- |
| Cross-tenant role assignment | Guard resolves target user's institution first; 19/19 tests |
| Tenant isolation | Foreign student/class 404; foreign SSE channel 403 |
| NUL-byte path | `value.includes("\0")` in `requireParam` |
| CSV formula injection | Leading-apostrophe guard; 11/11 tests |
| API key expiry | Enforced, same 401 as revoked |
| Webhook secret encryption | AES-256-GCM envelope |
| SSRF / DNS rebinding | DNS-pinned; private ranges allowed by documented decision |
| Server-derived identity | URL ids never trusted; SSE resolves student from session |
| HttpOnly cookie | `document.cookie` empty in browser, local and LIVE |
| Biometric non-exposure | No embedding in API, SSE, exports, logs, IndexedDB |
| Offline account binding | Quarantine on account switch |
| Distributed rate limit / realtime | Two-instance proven |
| SSE reconnect | Watchdog + bounded backoff, cross-instance failover proven |

## 11. Face-AI limitations

- **Production runs `FACE_MODEL_BACKEND=mock`.** No real recognition happens in
  production today. Unchanged by this audit.
- `productionEligible = false`, `commercial_use = "unclear"`.
- **REQ-23 is PARTIAL.** Templates are stored as `vector(128)` and are never
  returned to any caller — verified. But `SessionImage.storageUrl` means
  *classroom* images are referenced by URL, and face templates are not
  separately encrypted at rest beyond whatever the database provides. The DOCX
  says "Encrypted / Protected Face Template". Worth an explicit decision about
  what "encrypted" must mean here.
- Recognition accuracy has never been measured. No FAR/FRR/EER exists.

## 12. Offline limitations

The DOCX core requirement is *"Internet nahi hai → attendance phir bhi chalni
chahiye"*, with §4.2 showing **Local AI → Face Recognition → Local Attendance**.

| | |
| --- | --- |
| **DOCX requirement** | Local AI performs recognition offline |
| **Implementation** | Supports it: `LOCAL_AI_ENABLED` + a local recognition node. The UI reports AVAILABLE/UNAVAILABLE honestly and never pretends |
| **Production reality** | `LOCAL_AI_ENABLED=false`, no on-premise node deployed → offline recognition **unavailable**; the register is marked **by hand** |
| **Status** | **PARTIAL** — capability built, topology not deployed |

Offline attendance itself works in full: cached rosters, local register,
IndexedDB queue, owner binding, idempotent sync. Only the *recognition* half is
unavailable, and the UI says so rather than guessing.

## 13. School vs college verification

| Aspect | DOCX | Implementation | Status |
| --- | --- | --- | --- |
| School basis | Class-based | `attendanceMode = DAILY`, `cohortSubjectId = null` | MATCH |
| College basis | Subject-based | `attendanceMode = SUBJECT_WISE`, `cohortSubjectId` set | MATCH |
| School frequency | One daily session | Daily session per cohort | MATCH |
| College frequency | Each lecture | Session per `CohortSubject` | MATCH |
| Shared engine | One engine | One engine; only session shape differs | MATCH |

Defaults derive from `Institution.type` and are overridable per institution.

## 14. Integration / API verification

| Capability | Status |
| --- | --- |
| REST API `/api/v1` | IMPLEMENTED — 27 routes |
| API keys | IMPLEMENTED |
| Scopes | IMPLEMENTED |
| Rate limiting | IMPLEMENTED (distributed) |
| Audit logs | IMPLEMENTED |
| Webhooks | IMPLEMENTED — superset of the DOCX event list |
| CSV import/export | IMPLEMENTED |
| Excel import/export | IMPLEMENTED |
| External IDs | IMPLEMENTED |
| Field mapping | IMPLEMENTED |
| OAuth 2.0 | PARTIAL — client-credentials only |
| Scheduled sync | PARTIAL — no scheduler |
| SFTP | NOT IMPLEMENTED |

DOCX endpoint list: `/students` ✓ `/classes` ✓ `/sections` ✓ `/courses` ✗ (as
`/programs` + `/subjects`) `/faculty` ✓ `/attendance` ✓
`/attendance/sessions` ✓ `/reports` ✓ `/integrations` ✓.

## 15. Recommended product-owner decisions

**Decision 1 — auto-Present, or confirm every student? (blocks demo script)**
The DOCX says a confident match is Present automatically; the build requires a
teacher tap for everyone. Options: (a) keep current behaviour and update the
document; (b) auto-confirm above a threshold, keeping Review for the rest —
which reopens "what threshold?", and no threshold is validated. I recommend
deciding this before any client demonstration, because the two produce visibly
different demos.

**Decision 2 — what "encrypted face template" must mean.** REQ-23 is partial
until the standard is stated.

**Decision 3 — is an on-premise AI node in scope?** Without one, the DOCX's
headline offline-recognition promise is not met in production.

**Decision 4 — SFTP, OAuth authorization-code, scheduler: in or out?** All three
are in the document and absent from the build.

**Decision 5 — the two standing blockers.** Face-model licensing and a consented
accuracy dataset. Neither is an engineering task.

## 16. Corrective work queue

Nothing here has been implemented. Listed for a future, approved phase.

### P0 — production / security mismatch
*None identified.* No security control in the document is missing or weaker than
described.

### P1 — functional mismatch
1. **REQ-11 auto-Present** — resolve Decision 1, then align either code or
   document. Blocks a faithful demo.
2. **REQ-24 offline recognition** — deploy an on-premise node or amend the
   document's core requirement.
3. **REQ-23 template protection** — define and then meet the encryption standard.
4. **REQ-42 scheduler** — ship one, or document that the ERP must call the sync.

### P2 — UX / documentation mismatch
5. `/api/v1/courses` — add an alias or correct the document.
6. Document Contradictions A and B in the source document itself.
7. Record that thresholds are unvalidated wherever they are surfaced.
8. Correct the document's InsightFace/512-d assumption to YuNet + SFace/128-d.

### P3 — future enhancement
9. SFTP import/export.
10. OAuth 2.0 authorization-code flow.
11. Real-classroom benchmark (REQ-26/27) — gated on Blocker 2.
12. POC on consented students (REQ-50).
