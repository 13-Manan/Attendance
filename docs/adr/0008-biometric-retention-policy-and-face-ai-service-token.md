# ADR-0008: Biometric retention as institution configuration, and a shared token on the face-AI service

## Status

Accepted (security phase). Both decisions are additive: the retention defaults
encode the behaviour that already existed, and the service token is optional
until a deployment demands it.

## Context

The system stores face templates and processes classroom photographs. Two
questions had no answer in code.

**1. How long may a face template be kept?** The system had one erasure
mechanism — `FaceEmbedding.isActive = false`, a soft delete — and no concept of
a retention period at all. A student who left in 2024 still had a live
biometric template in 2026. "Soft delete" without a deletion schedule is a
euphemism for keeping biometric data indefinitely in a row nobody looks at.

The obvious fix is a constant: delete after N days. But the right N is not a
fact about this software. A school under a data protection authority that
requires erasure within thirty days of a pupil leaving, and a university that
must retain examination-attendance evidence for a full academic year, are both
right, and a compiled-in number is a number one of them has to violate.

**2. Who may call the face-AI service?** ADR-0002 describes it as private and
"never internet-facing". That sentence describes a network the code cannot see.
A process does not know whether the port it bound is behind a firewall, on a
shared Docker network, on a laptop joined to a café Wi-Fi, or published by a
`docker-compose` line somebody added in a hurry. `POST /v1/enroll` returns the
512-float template that identifies a person and `POST /v1/match` answers "is
this person in this list", neither of which requires a database or a session.
If reachability was the only control, then the first deployment mistake was
also a biometric breach.

Both had to be solved under the phase's standing constraints: **no database
schema change**, **zero new npm dependencies**, and no change to existing
functionality, UI or workflows.

## Decision

### Retention policy in `Institution.settings`

A per-institution policy stored as Json under `biometricRetention`, resolved in
exactly one place (`modules/privacy/policy.ts`), enforced in exactly one place
(`modules/privacy/service.ts`), and edited from Institution Settings.

Four decisions inside that shape, each of which could reasonably have gone the
other way:

- **Defaults encode current behaviour exactly.** `classroomImageStorage:
  "NEVER"`, `faceTemplateRetentionDays: 0`, `onStudentInactive: "DEACTIVATE"`.
  Enabling the module changes nothing for any existing institution until an
  administrator deliberately acts. A test pins it.
- **`0` means "no time limit", never "immediately"**, in every field. The
  opposite convention would make a missing or zeroed value — a corrupted
  settings blob, a cleared input box — destroy biometric data.
- **The read path clamps; the write path rejects.** `resolveRetentionPolicy`
  is total: `null`, a string, an array, an object with the wrong type in every
  field all resolve to the defaults, so no stored value can express "delete
  everything". `validateRetentionPolicy` refuses bad input instead of clamping
  it, so an administrator is told they were wrong rather than silently given a
  different policy than the one they typed.
- **There is no value meaning "keep classroom photographs forever."** The
  requirement was "do not automatically retain classroom photos forever";
  enforcing it by the absence of an expressible value is stronger than
  enforcing it with a default somebody can change.

`MAX_RETENTION_DAYS` (3650) is not an opinion about the right period. It is a
guard against a typo: an administrator who means 30 and types 3000000 has
expressed "forever" by accident, and the one thing this policy must never
express by accident is forever.

No new `PermissionKey` was introduced — reads use `institution.read`, policy
changes `institution.update`, and the sweep and erasure `faceEmbedding.manage`.
`PERMISSIONS` is code, but the role→permission rows are seeded *data*, so a new
key would exist in this build and in nobody's database, locking every current
administrator out of the screen.

### A shared service token on `services/face-ai`

Every `/v1/*` endpoint except `/v1/health` requires
`Authorization: Bearer <FACE_AI_AUTH_TOKEN>`, compared with
`hmac.compare_digest`. apps/web sends it from `FACE_AI_SERVICE_TOKEN`.

- Applied at the **router** level, so a new endpoint on a guarded router is
  protected by default rather than by somebody remembering a decorator.
- Checked **before** body validation — an anonymous caller with a malformed
  body gets 401, not 422, because otherwise the validation errors themselves
  become an unauthenticated API.
- A single shared secret with no identity, institution or scope. There is
  nothing here to scope: the service holds no data, performs no lookups, and
  can only act on what the caller hands it (ADR-0002). Per-tenant credentials
  would be ceremony around a service that cannot tell tenants apart.
- **Unset is permitted**, warned about loudly on every boot, and `uvicorn
  app.main:app` on an empty environment keeps working — it is the first command
  in the README. `FACE_AI_REQUIRE_AUTH=true` turns the warning into a refusal
  to start, the same shape as `FACE_AI_REQUIRE_PRODUCTION_MODEL`.

## Alternatives considered

**A `RetentionPolicy` table, and `FaceEmbedding.deactivatedAt`.** The correct
modelling, and forbidden: no schema change. The consequence is that the grace
clock starts at `createdAt` instead of at deactivation, which errs
conservatively — a template deactivated long after enrollment is deleted
*sooner* than a `deactivatedAt` column would have deleted it, never later. That
is recorded in the field's doc comment so the next reader finds a decision
rather than a bug.

**Encrypting `FaceEmbedding.vector` at rest.** Would break the ANN index the
recognition path depends on, or require a key-management dependency. Neither
was available. Listed as a known gap in `docs/SECURITY.md` §7 rather than
quietly omitted.

**mTLS between apps/web and face-ai.** Stronger, and a certificate lifecycle,
a CA and a rotation runbook for a two-process system whose deployment story is
not yet written. A shared token is the control that can actually be configured
correctly today; mTLS remains the upgrade, and it replaces one dependency
function.

**A cron for the retention sweep.** No scheduler ships (ADR-0007). Rather than
implying automation that does not exist, the sweep is a button, and its absence
is named in `ARCHITECTURE.md`'s not-implemented list.

## Consequences

- **Retention periods are not enforced until somebody presses the button.**
  This is the significant limitation of the retention work and it is stated in
  three places rather than one. `runRetentionSweep` takes a `SessionUser` and
  resolves the institution from it, so whatever eventually runs it on a timer
  will need a service account — which is the right thing to need before it is
  allowed to delete biometric templates.
- The sweep is idempotent: every decision is a function of the row's current
  state, so a cron, a retry after a timeout and an impatient administrator all
  converge on the same result.
- An audit row is written for every sweep **even when every count is zero**.
  "It ran on Tuesday and found nothing" is the evidence that the policy is being
  enforced; logging only the destructive runs would make an enforcement gap
  invisible in exactly the period it mattered.
- Three `AuditAction` members were added (`face_enrollment.deleted`,
  `face_data.retention_purged`, `face_data.retention_policy_updated`). The
  union is a TypeScript type over a `String` column, so no migration is
  involved and no existing row changes meaning.
- Any deployment that sets `FACE_AI_AUTH_TOKEN` on one side and not the other
  gets a uniform 401 on every inference call. `scripts/integration-test.sh` now
  runs with `FACE_AI_REQUIRE_AUTH=true` and the token set on both sides, so the
  documented end-to-end path is the authenticated one and a broken credential
  wiring fails in CI rather than in a classroom.
- `docs/API_CONTRACTS.md` §A no longer claims there is no authentication on the
  internal contract. ADR-0002's statelessness claim is unaffected: the token
  authenticates the caller and gives the service nothing to store.
