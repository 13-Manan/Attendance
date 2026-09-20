# Security and biometric privacy

This system holds two kinds of data that are not interchangeable with anything
else it holds.

The first is a **face template**: 512 floats derived from a photograph of a
student, stored in `FaceEmbedding.vector`. It is not a password. A student
whose template leaks cannot be issued a new face, and the leak is permanent in
a way a leaked session cookie is not. Everything below follows from that.

The second is a **classroom photograph**: an image of every student present in
a room at a known time. This system does not store them, and the document says
where that is enforced rather than merely asserted.

---

## 1. Biometric data

### Where it lives, and where it does not

| | |
|---|---|
| Stored in | `FaceEmbedding.vector` (pgvector), scoped by `institutionId` |
| Derived by | `services/face-ai`, which holds no database credentials (ADR-0002) |
| Reaches the browser | **Never** |
| Appears in logs | **Never** |
| Reachable over `/api/v1` | **No** — no public endpoint returns or accepts one |

The template is created inside `services/face-ai`, travels once over the
internal contract to apps/web, and is written to the database. No Server
Action, Route Handler or public API response contains a vector. `security.test.ts`
pins both halves: *"a successful enrollment never returns the biometric
template to its caller"* and *"the audit row for an enrollment carries
metadata, never the vector"*, the second using a regex that detects a float
array by its shape rather than by a field name, so renaming the key does not
defeat the assertion.

The one identifier that does cross the boundary is `embeddingId` — a row id,
useful for correlating a `face_enrollment.created` audit row with its
`face_enrollment.deleted` one, and not a biometric.

### Access control

Three keys, all pre-existing, none invented for this work:

- `faceEmbedding.enroll.own` — a student enrolling their own face. The
  service path takes **no** `studentId`; it resolves the student from the
  session, so there is no parameter to point elsewhere.
- `faceEmbedding.manage` — staff enrollment, deactivation, deletion and the
  retention sweep.
- `institution.read` / `institution.update` — reading and changing the
  retention policy, which is institution configuration.

No new `PermissionKey` was introduced. `modules/authorization/permissions.ts`
is code, but the role→permission rows are **seeded data**: a new key would
exist in this build and in nobody's database, locking every current
administrator out of the screen. A biometric control nobody can reach is worse
than no control.

### Institution isolation

Every face-data function resolves the institution from the `SessionUser` and
passes it to every repository call. `modules/privacy/service.ts` has no
signature through which a caller can name the tenant whose biometric data is
about to be deleted. Where an id does arrive from a request — the staff
deletion path — the student is loaded and `requireSameInstitution` is called
*in addition to* the scoped query, so a cross-tenant id is **refused** rather
than silently deleting nothing. Reporting zero deletions to an administrator
who believes they erased a record is the worse of those two failures.

### Encryption

**In transit:** apps/web → face-ai runs over the deployment's own transport.
Both ends must be on a private network or TLS; the service token below is what
still works when that assumption is wrong.

**At rest: not implemented at the application layer.** `FaceEmbedding.vector`
is protected by database and filesystem access control. Encrypting the column
would break the ANN index the recognition path depends on, or require a
key-management dependency; this phase permitted neither a new dependency nor a
schema change. This is a real gap and it is listed as one in `ARCHITECTURE.md`.
What mitigates it: the value never leaves the database except into the matching
path, it is never logged, and the retention policy below bounds how long it
exists at all.

---

## 2. Face data retention

`modules/privacy/` — a pure policy codec (`policy.ts`), a service that
authorizes and enforces it (`service.ts`), and Server Actions behind
Institution Settings.

The policy lives in `Institution.settings` (a Json column — **no schema
change**) under `biometricRetention`, and is configurable per institution
because the right retention period is not a fact about this software. A school
required to erase within thirty days of a pupil leaving and a university that
must keep examination-attendance evidence for an academic year are both right;
a constant compiled into the application is a number one of them has to
violate.

### The settings

| Setting | Default | `0` means |
|---|---|---|
| `faceTemplateRetentionDays` | `0` | No age limit while the student is active |
| `onStudentInactive` | `DEACTIVATE` | — (`DEACTIVATE` or `DELETE`) |
| `deactivatedTemplateGraceDays` | `30` | Never deleted automatically |
| `classroomImageStorage` | `NEVER` | — (`NEVER` or `RETAIN_FOR_DAYS`) |
| `classroomImageRetentionDays` | `0` | Only read under `RETAIN_FOR_DAYS`, where it must be ≥ 1 |

In every field `0` means *no time limit*, never *immediately*. The opposite
convention would make a missing or zeroed value destroy data.

**The defaults encode exactly what the system already did.** Enabling this
module changes nothing until an administrator deliberately acts —
`service.test.ts` pins that: *"a sweep under the shipped defaults changes
nothing for an ordinary roster."*

### Lifecycle

```
enrolled ──(age > faceTemplateRetentionDays)──▶ deactivated ──(age > grace)──▶ deleted
   │                                               ▲
   └──(student no longer ACTIVE)───────────────────┘   or straight to deleted,
                                                        under onStudentInactive: DELETE
```

Deactivation before deletion is the default because a student marked inactive
in error is common, and a deleted biometric template cannot be restored — only
re-collected from the person. The grace period is what stops "soft delete"
from being a euphemism for keeping biometric data forever in a row nobody looks
at.

The grace clock starts at `FaceEmbedding.createdAt`, because the schema has no
`deactivatedAt` column and could not gain one. That errs in the conservative
direction: a template deactivated long after enrollment is deleted *sooner*
than a `deactivatedAt` column would have deleted it, never later.

Read and write are deliberately asymmetric. `resolveRetentionPolicy` is total —
`null`, a string, an array, an object with the wrong type in every field all
resolve to the defaults, because a corrupted settings blob must not be able to
express "delete everything". `validateRetentionPolicy` on the write path
*rejects* instead of clamping, so an administrator is told their input was
wrong rather than silently given a different policy. `MAX_RETENTION_DAYS`
(3650) is not an opinion about the right period; it is a guard against a typo,
because the one thing this policy must never express by accident is *forever*.

### Enforcement, and its honest limitation

`runRetentionSweep` applies the policy across an institution: bulk deactivate,
bulk delete, idempotent, and audited **even when every count is zero** — "the
sweep ran on Tuesday and found nothing" is the evidence that the policy is
being enforced, and logging only the runs that deleted something would make an
enforcement gap invisible in exactly the period it mattered.

**No scheduler ships with this build (ADR-0007).** The sweep is a button on
Institution Settings, behind an acknowledgement checkbox — friction against a
misclick before an irreversible bulk deletion, not a security control; the
control is `faceEmbedding.manage`. Until a scheduler exists, retention periods
are enforced when an administrator presses it and not before. This is stated in
`ARCHITECTURE.md`'s not-implemented list rather than implied by a policy screen
that looks automatic.

### Erasure on request

`deleteStudentFaceData` — the workflow behind "delete my face data" — is on the
student's enrollment page, gated by `faceEmbedding.manage`. It **deletes**
rather than deactivates, because a deactivation in answer to an erasure request
is an answer that is not true.

What survives is the attendance register: deletion clears the advisory
`matchedEmbeddingId` pointer and leaves every record's date, `finalResult` and
correction history intact. Erasing a biometric template must not put holes in a
statutory attendance record, and the two are separable precisely because the
register never stored the biometric data itself. Re-enrollment is unaffected —
that is the difference between erasure and a ban.

---

## 3. Classroom images

The capture path holds image bytes in memory for the length of one recognition
call and writes them nowhere. No code path has ever created a `SessionImage`
row. The retention policy turns that implementation detail into a promise:
storage is now something an institution has to switch on deliberately, name a
period for, and see in an audit log.

- Default is `NEVER`. Under `NEVER`, any stored image the sweep finds is
  deleted, because under that policy it should not exist.
- `RETAIN_FOR_DAYS` exists for an institution whose own policy explicitly
  requires keeping the evidence — an examination board, a disciplinary
  process — and requires a period of at least one day.
- **There is no setting that means forever.** "Do not automatically retain
  classroom photos" is enforced by the absence of a value that could express
  it, not by a default somebody can change.

Images captured offline are a separate case: they stay in IndexedDB on the
teacher's own device as their own record and are never uploaded by the sync
engine — only `captureImageCount` is synced (`docs/OFFLINE_SYNC.md`).

---

## 4. The AI service

`services/face-ai` used to accept every caller that could reach the port.
ADR-0002 describes it as private and "never internet-facing", but that sentence
describes a network the code cannot see. A process does not know whether the
port it bound is behind a firewall, on a shared Docker network, on a laptop
joined to a café Wi-Fi, or published by a `docker-compose` line somebody added
in a hurry. If reachability is the only control, the first deployment mistake
is also a biometric breach — `POST /v1/enroll` returns the template that
identifies a person, and `POST /v1/match` answers "is this person in this
list", neither of which needs a database or a session.

**Every `/v1/*` endpoint except `/v1/health` now requires
`Authorization: Bearer <FACE_AI_AUTH_TOKEN>`**, compared with
`hmac.compare_digest` — a short-circuiting `==` leaks the length of the common
prefix through timing, and this secret is reusable forever.

| | |
|---|---|
| Guarded | `/v1/enroll`, `/v1/embed`, `/v1/quality`, `/v1/detect`, `/v1/detect-embed`, `/v1/match`, `/v1/model-info` |
| Open | `/v1/health` — a liveness probe returning the model name and embedding dimension, which the README already curls |

The guard is applied at the **router** level, so an endpoint added to a guarded
router is protected by default rather than by somebody remembering a decorator.
Authentication is checked before body validation, so an anonymous caller with a
malformed body gets `401` and not `422` — otherwise the validation errors
become an unauthenticated API. A wrong token and a missing header produce the
identical response: the service must not tell a caller how close they were.

The token carries no identity, institution or scope, because there is nothing
here to scope — the service holds no data and can only act on what the caller
hands it. It answers one question: *is the caller apps/web?*

### Configuration

```
services/face-ai   FACE_AI_AUTH_TOKEN=<secret>    FACE_AI_REQUIRE_AUTH=true
apps/web           FACE_AI_SERVICE_TOKEN=<same secret>
```

With `FACE_AI_AUTH_TOKEN` empty the service accepts anonymous callers and logs
a warning naming the exposure on every boot, because `uvicorn app.main:app` on
an empty environment is the first command in the README and has to keep
working. `FACE_AI_REQUIRE_AUTH=true` turns that into a refusal to start — the
same shape as `FACE_AI_REQUIRE_PRODUCTION_MODEL`. **Set both in any environment
holding real faces.** `scripts/integration-test.sh` sets them, so the
documented end-to-end path is the authenticated one.

---

## 5. API surfaces

| Surface | Authentication | Authorization |
|---|---|---|
| Server Actions | Session cookie | `PermissionKey` + institution scope, in the service |
| `/api/internal/*` | Session | Same |
| `/api/v1/*` | `Authorization: Bearer <ApiKey>`, peppered hash | **Scope**, not role; per-key rate limit; audited |
| face-ai `/v1/*` | Shared service token | None needed — stateless (ADR-0002) |

Authorization lives in the service layer, not in the route or the action, which
is what makes the rules identical whether a request arrives from a form, a
Route Handler or a future scheduler. Every action and handler is a boundary:
parse untrusted input, call the service, render the result.

### Upload validation

`lib/image-validation.ts` guards every path that accepts an image, at the zod
schema boundary so no action has to remember to call it:

- **Magic bytes**, not a declared MIME type or a file extension. JPEG, PNG and
  WebP only — and WebP is checked at offset 8, because `RIFF` alone is also
  WAV and AVI.
- Rejected with a named reason: zip, gzip, pdf, ELF, Mach-O, shell scripts,
  HTML, **SVG** (an image format that executes script), GIF, BMP, TIFF, ICO,
  `data:` URLs, non-base64, embedded whitespace, and a ZIP/JPEG polyglot —
  judged by its actual first bytes, not a signature buried later.
- **Size bounded on the string length**, before anything is decoded or
  allocated. Enforced independently on *both* sides: apps/web rejects it, and
  face-ai rejects it again via Pydantic, along with too many images per request
  and unbounded match-candidate lists. A caller is not trusted to have been
  validated by another caller.

### IDOR

The structural defence is preferred over the checked one wherever it fits:
`getOwnAttendance` has no `studentId` parameter, self-enrollment has no
`studentId` parameter, and no retention function takes an `institutionId`.
Where an id must come from a request it is checked against the session's
institution before use. `security.test.ts` is organised by attacker rather than
by module for exactly this: it asks *what could a student have done?*, and a
`Writes` ledger asserts that each refusal happened **before** the side effect,
not merely that an error was thrown. One test injects dependencies that throw
if reached, so a pass proves the permission check preceded the first lookup.

### CSRF

Server Actions are POST-only with the framework's action-id indirection and are
not invocable cross-origin as a simple form post. The public API is Bearer-token
authenticated and stateless, so there is no ambient credential for a
cross-site request to ride.

---

## 6. Audit log

`AuditAction` is a closed TypeScript union over a `String` column — adding a
member needs no migration and changes no existing row's meaning.

Sensitive operations recorded: `face_enrollment.created`,
`face_enrollment.deactivated`, `face_enrollment.deleted`,
`face_data.retention_purged`, `face_data.retention_policy_updated`,
`attendance.corrected`, `attendance.finalized`, `user.role_changed`,
`api.request.denied`, and the integration lifecycle.

Two rules the rows follow:

- **Never** a password, a secret, a token, or an embedding. The retention sweep
  logs counts and the policy in force — a log recording *which* students lost
  templates would reconstruct the biometric roster it was written to protect.
  `service.test.ts` asserts this by shape: *"no audit payload from this module
  contains anything resembling an embedding."*
- Policy changes log **before and after**. Shortening a retention period is an
  instruction to destroy data on the next sweep, and the question afterwards is
  always "who shortened it, and from what" — a row holding only the new value
  cannot answer the second half.

---

## 7. Known gaps

Stated here rather than left for someone to find.

- **No encryption at rest for embeddings.** §1. Would require a new dependency
  or a schema change; this phase permitted neither.
- **No scheduler for the retention sweep.** §2. It is a button until one
  exists (ADR-0007).
- ~~`WebhookEndpoint.secret` is stored in plaintext.~~ **Resolved** — see §9.
- **`api_key.created` and `api_key.revoked` are declared but never emitted.**
  No API-key management surface ships in this build; keys are provisioned
  directly. The actions are reserved so that the screen, when it lands, audits
  from its first commit.
- **The rate limiter is per-process and in-memory** (ADR-0007). It bounds a
  single instance; behind more than one, the effective limit multiplies by the
  instance count. Redis behind the same interface is the fix.
- **`/api/v1` has no unauthenticated-flood protection**, by design — the limit
  is keyed on the authenticated `apiKeyId`, so a request with no valid key is
  rejected before it consumes an allowance. That tradeoff is documented in
  `modules/integrations/api-route.ts`; an edge rate limit is the deployment's
  responsibility.
- ~~No end-to-end browser verification.~~ **Resolved** — a pgvector-capable
  Postgres now exists locally and the flows in this document are exercised in
  a real browser (Phases 7–11).

---

## 9. Secrets, outbound requests, and credential lifecycle

Added in Phase 11.

### Webhook signing secrets are encrypted at rest

**IMPLEMENTED.** `lib/secret-box.ts`. AES-256-GCM, random 12-byte IV per
value, authentication tag, versioned envelope:

```
v1.<keyVersion>.<base64url iv>.<base64url tag>.<base64url ciphertext>
```

One string, so it fits the existing `WebhookEndpoint.secret` column — no
schema change. A stored value **without** the `v1.` prefix is a legacy
plaintext secret and is returned unchanged, which is what allows the rollout
to be gradual instead of a flag day that breaks every live endpoint at once.

A signing secret must be *readable* (a hash cannot produce an HMAC), so this
is encryption, not hashing. The plaintext exists in exactly two places: the
one response that shows it to the administrator, and the dispatcher's memory
while it signs.

**CONFIGURATION REQUIRED.** The key-encryption key comes from
`WEBHOOK_SECRET_KEK` — 32 bytes, base64:

```bash
WEBHOOK_SECRET_KEK="$(head -c 32 /dev/urandom | base64)"
```

When it is unset, the KEK is derived from `AUTH_SECRET` via HKDF-SHA256 with
the label `attendance:webhook-secret-kek:v1`. That keeps a development
checkout and CI working with no extra configuration and does not weaken the
deployment — anyone holding `AUTH_SECRET` can already forge a session. An
explicit key is still preferred in production because it can be rotated
independently.

**PRODUCTION DEPLOYMENT REQUIRED.** The KEK should be delivered from the same
secret path as every other production secret. Phase 11 made no Azure or Key
Vault change; wiring the variable is a deployment step.

**Rotation.** `keyVersion` is written into every ciphertext. A second key
means adding it and bumping `CURRENT_KEY_VERSION`; existing values keep
opening under their own version until re-sealed. No key was rotated here.

**Migration.** `scripts/seal-webhook-secrets.ts`, idempotent and
verify-before-replace: each row is sealed, opened again, compared against the
original, and only then written. A round-trip failure stops the run with the
remaining rows untouched. `--dry-run` reports without writing.

### Outbound requests

**IMPLEMENTED.** `modules/integrations/safe-fetch.ts` is the only way this
application makes an outbound HTTP call.

Phase 10 resolved a hostname, validated the answer, then called `fetch` —
which resolved it *again*. That second lookup is the DNS-rebinding window.
`safeRequest` closes it by making resolution and validation the same act: it
resolves once, refuses the bad answers, and hands the surviving address to the
agent's `lookup`. Node connects to exactly what that returns, so the real
resolver is never consulted a second time.

TLS still validates against the hostname (`servername` keeps SNI and
certificate checking pointed at the configured name). Pinning changes *where*
we dial, never *who* we are willing to believe we reached.

Also enforced: a timeout covering connect **and** response (an unreachable
private address previously sat on the OS default for 75 seconds — measured), a
bounded response body, no redirect following, and only the headers the caller
passed. Nothing ambient — no cookie jar, no environment, no internal service
token — can attach itself to a request built this way.

**Trust model.** Private and on-premises addresses are *allowed*: a school ERP
on `10.0.0.5` is the case these integrations exist for. Refused are loopback,
link-local (every cloud's instance-metadata service) and the unspecified
address. The boundary relied on is that only an institution administrator can
configure a connection — this guards against a malicious *destination*, not a
malicious administrator.

A refusal is a **permanent** delivery failure, never retried: retrying is a
scheduled, repeating attempt to post signed student data somewhere it must not
go.

### API key lifecycle

**IMPLEMENTED.** Keys are hashed (never stored or recoverable in plaintext),
scoped, institution-owned, shown once, and revocable. Phase 11 added
`expiresAt`.

Expiry is nullable and null for every key issued before the column existed —
back-filling a date would have switched off live integrations to tidy up a
schema. An expired key and a revoked key both return the same `401`, so a
caller cannot learn that a key they hold was once real.

Rotation is issue-then-revoke with an overlap window; both keys are valid
until the old one is revoked.

### Security headers

`X-Frame-Options`, `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy`,
`Permissions-Policy` (camera `self`; microphone and geolocation denied), and —
**in production builds only** — `Strict-Transport-Security` for two years
including subdomains, without `preload` (submitting to the preload list is
irreversible on a browser timescale and belongs to whoever owns the domain).

**POLICY DECISION REQUIRED.** A full `script-src` Content-Security-Policy is
still deferred. A policy strict enough to be worth having needs per-request
nonces threaded through the framework's inline bootstrap; a half-strict one
with `unsafe-inline` buys nothing. That is its own piece of work.

### Dependency advisory

`deepmerge-ts` < 8.0.0 (GHSA-ggr8-5vv4-36mx, stack exhaustion) is reachable
only through the Prisma **CLI**, a devDependency. It is **not present in the
production image** — the runtime stage copies only `.next/standalone`,
`.next/static` and `public`, and the package appears in none of them
(verified). Fixing it means a major Prisma upgrade, which is not a change to
make inside a security phase whose rule is to break nothing. Tracked, not
runtime-reachable.

---

## 8. Running the security tests

```bash
# The attack suite, the retention policy, and upload validation
cd apps/web && node --import ./scripts/register-test-loader.mjs --test "src/**/*.test.ts"

# Everything, against a live authenticated face-ai
./scripts/integration-test.sh

# The service token and request bounds
cd services/face-ai && .venv/bin/python -m pytest -q
```
