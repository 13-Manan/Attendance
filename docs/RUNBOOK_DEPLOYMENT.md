# Deployment runbook — Attendance production

Operational procedures for `attendance-production-rg` (Central India,
subscription *Pay-As-You-Go*). Architecture and rationale live in
[`infra/azure/README.md`](../infra/azure/README.md); this file is what you read
when something needs doing or undoing.

> **Production is live.** Both container apps serve the application from
> commit-pinned image digests, the database is migrated, and every push to
> `main` deploys. See §"Current state" at the end.

---

## The resources this touches, and only these

| Name | Type |
|---|---|
| `attendance-production-rg` | Resource group (all of the below live in it) |
| `attendanceprodacr` | Container registry |
| `attendance-prod-web` | Container app — **external** ingress |
| `attendance-prod-face-ai` | Container app — **internal** ingress only |
| `attendance-prod-migrate` | Container Apps **job**, manual trigger |
| `attendance-prod-psql` | PostgreSQL flexible server, private VNet only |
| `attendance-prod-keyvault` | Key Vault |

Anything not in this table is another project's and is out of scope.

---

## Images

Three images, each tagged with the **full Git commit SHA** and never `latest`:

```
attendanceprodacr.azurecr.io/web:<sha>
attendanceprodacr.azurecr.io/face-ai:<sha>
attendanceprodacr.azurecr.io/migrate:<sha>
```

An immutable tag is what makes rollback a one-line operation: the previous
release is still sitting in the registry under its own SHA, byte-for-byte.
A mutable `latest` would make "roll back" mean "rebuild and hope".

The tag is how a human finds an image. What the pipeline actually deploys is
the **digest** that tag resolved to at build time — `web@sha256:…` — because a
tag is a pointer and a pointer can be moved, whereas a digest is the content.
`deploy.yml` resolves all three digests immediately after building, hands those
to Container Apps, and then reads the running image back and compares. So the
revision that ends up serving is provably the artifact that run validated.

Building by hand (no local Docker needed — ACR Tasks builds inside Azure):

```sh
SHA=$(git rev-parse HEAD)
az acr build -r attendanceprodacr -t web:$SHA      -f apps/web/Dockerfile .
az acr build -r attendanceprodacr -t migrate:$SHA  -f apps/web/Dockerfile.migrate .
az acr build -r attendanceprodacr -t face-ai:$SHA  -f services/face-ai/Dockerfile services/face-ai
```

---

## Which commit is live right now?

```sh
az containerapp show -n attendance-prod-web -g attendance-production-rg \
  --query "properties.template.containers[0].image" -o tsv
# -> attendanceprodacr.azurecr.io/web@sha256:aef0a63...
```

That is a digest, so it names the bytes rather than the commit. One more hop
gets the commit, because the same manifest still carries its SHA tag:

```sh
az acr repository show-tags -n attendanceprodacr --repository web --detail \
  --query "[?digest=='sha256:aef0a63...'].name" -o tsv
# -> ab8ef4358edd6c851d8db1b4fb7fd3e256590f80
```

`git show <sha>` then tells you exactly what is running. The deploying
workflow run records the same commit → tag → digest → revision mapping in its
job summary, which is the faster place to look when you know the run.

Current and previous revisions, newest first:

```sh
az containerapp revision list -n attendance-prod-web -g attendance-production-rg \
  --query "reverse(sort_by([].{name:name, created:properties.createdTime, active:properties.active, state:properties.runningState, image:properties.template.containers[0].image}, &created))" \
  -o table
```

---

## Rolling back the application

Both apps run in **single-revision mode**: exactly one revision is active and
it takes all traffic. There is no traffic split to shift, so a rollback is a
redeploy of the previous image — deterministic, and it works whatever state the
bad revision is in.

```sh
PREV=<previous good sha>

az containerapp update -n attendance-prod-web -g attendance-production-rg \
  --image attendanceprodacr.azurecr.io/web:$PREV

# Only if the Face AI service also changed in the bad release:
az containerapp update -n attendance-prod-face-ai -g attendance-production-rg \
  --image attendanceprodacr.azurecr.io/face-ai:$PREV
```

Confirm it took:

```sh
az containerapp revision list -n attendance-prod-web -g attendance-production-rg \
  --query "[?properties.active].{name:name,state:properties.runningState,image:properties.template.containers[0].image}" -o table
```

### Rolling Face AI back past the recognition change — read this first

The deploy workflow sets `FACE_MODEL_BACKEND=azure_detection_own_recognition`
on every deployment. Any face-ai image built **before** that backend existed
does not know the name, and `build_provider` raises `Unknown
FACE_MODEL_BACKEND` at startup — so rolling the image back on its own takes
the service down rather than restoring it. Roll the variable back in the same
command:

```sh
az containerapp update -n attendance-prod-face-ai -g attendance-production-rg \
  --image attendanceprodacr.azurecr.io/face-ai:$PREV \
  --set-env-vars FACE_MODEL_BACKEND=azure FACE_AI_REQUIRE_PRODUCTION_MODEL=false
```

`false` on the guard because the older backends are not licence-cleared and it
would otherwise refuse to start. That is the guard doing its job, and lowering
it is part of *deliberately* going back to a backend that identifies nobody —
not something to do to make an unrelated deployment pass.

The next deployment from `main` puts both variables back, so a rollback done
this way is temporary by construction. If it needs to stick, revert the commit.

The `alignmentVersion` column added with this change is expand-only — nullable,
with no backfill and no code that requires it — so an older image runs fine
against the newer schema and the database needs no rollback.

### Disabling a bad revision outright

```sh
az containerapp revision deactivate -n attendance-prod-web \
  -g attendance-production-rg --revision <bad-revision-name>
```

Deactivating the only active revision takes the app down. Roll forward or back
to a good image **first**, then deactivate.

### Rolling back the database — read this before assuming

**Database rollback is not automatic, and this pipeline will never attempt
one.** Redeploying an older image reverts *code only*. The schema stays
wherever the last successful migration left it.

`prisma migrate deploy` has no "down". Undoing a migration means writing a new,
reviewed forward migration that reverses it — and if the original dropped a
column, the data in it is gone and no migration brings it back. Restoring the
server from its point-in-time backup is the only true schema-and-data rollback,
and it loses every write since the restore point.

This is why migrations should be **expand/contract**:

1. *Expand* — add the new column/table, nullable or defaulted. Old code ignores
   it; new code starts writing it. Safe to roll back, because the old image
   still runs fine against the new schema.
2. *Migrate data* — backfill separately.
3. *Contract* — only once the new code is proven, a later release drops the old
   column.

A release that expands only is always safely reversible. A release that
contracts is not, so contract in its own deployment and never alongside the
code that depends on it.

---

## Running migrations

Migrations run **inside the VNet**, via `attendance-prod-migrate`. The database
has no public endpoint and is never given a temporary firewall rule for a
deployment.

```sh
SHA=$(git rev-parse HEAD)

az containerapp job update -n attendance-prod-migrate -g attendance-production-rg \
  --image attendanceprodacr.azurecr.io/migrate:$SHA

EXEC=$(az containerapp job start -n attendance-prod-migrate \
  -g attendance-production-rg --query name -o tsv)

az containerapp job execution show -n attendance-prod-migrate \
  -g attendance-production-rg --job-execution-name "$EXEC" \
  --query properties.status -o tsv

az containerapp job logs show -n attendance-prod-migrate \
  -g attendance-production-rg --execution "$EXEC" --container migrate
```

**Never**, against production: `prisma db push`, `prisma migrate dev`,
`prisma migrate reset`. The first two invent schema changes outside review; the
third drops the database. The migration image contains only `schema.prisma` and
the committed migration SQL — `prisma/seed.ts` is deliberately not in it, so the
migration job cannot write application rows even if something tried to make it.

Migrations create the schema and stop there. A migrated database still holds no
roles, no institution and no accounts, and nobody can sign in to it. Those rows
arrive through a separate, explicitly-run bootstrap; see "First bootstrap of a
new database" below.

### A failed migration

The job has `replicaRetryLimit: 0`. It stops and waits for a person — a
half-applied migration retried in a loop is worse than one that halts.

Prisma records the failure in `_prisma_migrations` and refuses further
migrations until it is resolved. Read the logs, decide whether the migration
partially applied, then use `prisma migrate resolve --applied|--rolled-back`
from inside the VNet. The previous application revision keeps serving
throughout: the pipeline halts before `deploy`, so nothing has changed yet.

---

## First bootstrap of a new database

> **Status: built, never executed.** `apps/web/Dockerfile.bootstrap`,
> `infra/azure/modules/bootstrap-job.bicep` and `infra/azure/bootstrap.bicep`
> exist and are validated. The `attendance-prod-bootstrap` job does **not** yet
> exist in `attendance-production-rg`, no bootstrap image has been pushed to the
> registry, and production has not been bootstrapped: it still holds zero roles,
> zero institutions and zero users. Do not run any of this without explicit
> approval.

A freshly migrated database has a complete schema and no rows. Three stages fill
that gap, all from `apps/web/scripts/bootstrap-production.ts`, all explicit:
`system` (roles and permission grants, idempotent), `tenant` (the first
institution, its administrator, and the assignment joining them, once) and
`platform` (the first PLATFORM_SUPER_ADMIN — one user and one assignment, both
institution-less, idempotent).
docs/DATABASE_OPERATIONS.md §4 covers what each writes and why they are separate.

`tenant` and `platform` are alternatives, not a sequence. Running `platform`
first closes `tenant` permanently — `tenant` requires a database with no users
at all, and a platform account is a user — which is existing, tested behaviour
and is left alone. It costs nothing: a platform administrator creates
institutions and their administrators in the application, which `tenant` can
only ever do once. **For this deployment, `platform` is the intended path.**

### Why a separate job rather than the migration job

The database has no public endpoint, so a bootstrap has the same reachability
problem a migration has and the same solution: run it inside the VNet as a
Container Apps Job. The question is whether it is *the same* job.

It should not be, for three reasons.

**The deployment pipeline starts the migration job on every deploy.** That is
the whole point of it. If the bootstrap lived in the same image, the only thing
separating a routine deploy from a write to `Institution` would be which command
the container happened to be running — and a command override left behind after
a bootstrap would still be there the next time the pipeline pressed start. The
blast radius of forgetting to undo something should not be "creates a tenant".

**It would undo what makes the migration image trustworthy.** That image holds
`schema.prisma`, the committed migration SQL and the Prisma CLI, and nothing
else — no application source, no generated client, no password hasher. Its
header says there is exactly one place to read to know what runs against
production. Bootstrapping needs the application's own modules, its generated
client and its scrypt implementation, which means the image stops being small
and stops being only about schema.

**The two have different lifetimes.** Migrations run forever, on a schedule set
by the repository. `tenant` runs once, ever. A resource that is meant to be used
once and then deleted should be separately deletable.

Rejected alternatives: `az containerapp exec` into a running web revision (an
unlogged interactive shell against the container currently serving traffic, and
the standalone build has no Prisma CLI or `.ts` runtime anyway); running it from
a laptop (needs the public endpoint and firewall rule this architecture exists to
avoid); creating the job ad hoc at execution time (no reviewed image, no
reproducible definition, no artifact to audit afterwards).

### The shape of it

A `apps/web/Dockerfile.bootstrap` image and an `attendance-prod-bootstrap`
Container Apps Job in the same managed environment, mirroring
`modules/migration-job.bicep`: `triggerType: Manual`, `replicaRetryLimit: 0`,
`parallelism: 1`, `replicaCompletionCount: 1`, system-assigned identity with
`get` on the `DATABASE-URL` secret and nothing more. The identity's Key Vault
grant is scoped to that one secret rather than to the vault, so it cannot read
`AUTH-SECRET`, `API-KEY-PEPPER` or `FACE-AI-SERVICE-TOKEN`.

The job template carries `DATABASE_URL` (a Key Vault reference) and
`BOOTSTRAP_TARGET=production`, and nothing else. In particular it carries no
stage and no confirmation, so starting the job with no overrides runs a
container that refuses twice over and exits non-zero. The stage, the
confirmation and the administrator's details are supplied per execution:

```sh
# Stage A — roles and permissions. Idempotent; safe to repeat.
az containerapp job start -n attendance-prod-bootstrap -g attendance-production-rg \
  --args system \
  --env-vars DATABASE_URL=secretref:database-url \
             BOOTSTRAP_TARGET=production \
             BOOTSTRAP_CONFIRM=WRITE-TO-PRODUCTION
```

`--args` and `--env-vars` on `job start` are execution-scoped overrides: they
apply to that one run and are not written back to the job template. Nothing a
bootstrap sets can be left behind to affect a later one.

**`--env-vars` replaces the environment; it does not merge with it.** This is
why `DATABASE_URL` is repeated above even though the job template already
declares it. Verified in the CLI source rather than assumed — see
`start_containerappsjob` in
`azure/cli/command_modules/containerapp/custom.py`, which builds a fresh
container override and assigns the parsed list to `env` wholesale. Omit it and
the container starts with no connection string and refuses with `DATABASE_URL is
not set`. Harmless, but confusing if you are not expecting it.

Stage B needs the institution and administrator details, and a password. The
password is the one input that must not appear in a command line, a shell
history, a CI log or an activity-log entry, so it does not travel as a literal:

```sh
# Put the initial password in Key Vault, reference it, delete it afterwards.
az keyvault secret set --vault-name <vault> -n BOOTSTRAP-ADMIN-PASSWORD \
  --file <path>        # from a file, not an inline --value

az containerapp job start -n attendance-prod-bootstrap -g attendance-production-rg \
  --args tenant \
  --env-vars DATABASE_URL=secretref:database-url \
             BOOTSTRAP_TARGET=production BOOTSTRAP_CONFIRM=WRITE-TO-PRODUCTION \
             BOOTSTRAP_INSTITUTION_NAME="..." BOOTSTRAP_INSTITUTION_TYPE=SCHOOL \
             BOOTSTRAP_ADMIN_NAME="..." BOOTSTRAP_ADMIN_EMAIL="..." \
             BOOTSTRAP_ADMIN_PASSWORD=secretref:bootstrap-admin-password

az keyvault secret delete --vault-name <vault> -n BOOTSTRAP-ADMIN-PASSWORD
```

`secretref:` resolves against a secret declared on the *job*, so the job's
configuration needs a `bootstrap-admin-password` entry pointing at that Key Vault
URL alongside the existing `database-url` one. That is the one part of this
design to confirm against the API when the job is actually created: a Key Vault
reference whose secret does not exist yet may be rejected at template-update
time, in which case the secret is created first and deleted last, exactly as
ordered above. If it proves awkward, `az containerapp job secret set` holds the
value on the job instead of in Key Vault — same lifetime, one less resource,
and it is removed the same way afterwards.

Stage C takes one required input of its own and reuses the same password secret.
There is deliberately no second password variable to provision and rotate; which
account the password belongs to is decided by `--args`, which is explicit on
every execution:

```sh
az keyvault secret set --vault-name <vault> -n BOOTSTRAP-ADMIN-PASSWORD \
  --file <path>        # from a file, not an inline --value

az containerapp job start -n attendance-prod-bootstrap -g attendance-production-rg \
  --args platform \
  --env-vars DATABASE_URL=secretref:database-url \
             BOOTSTRAP_TARGET=production BOOTSTRAP_CONFIRM=WRITE-TO-PRODUCTION \
             BOOTSTRAP_PLATFORM_ADMIN_EMAIL="..." \
             BOOTSTRAP_ADMIN_PASSWORD=secretref:bootstrap-admin-password

az keyvault secret delete --vault-name <vault> -n BOOTSTRAP-ADMIN-PASSWORD
```

`BOOTSTRAP_PLATFORM_ADMIN_NAME` is optional and defaults to
`Platform Super Admin`. Both rows the stage writes have `institutionId = NULL`;
it creates no institution and grants no institution-scoped role.

Re-running it is safe and does nothing. It reports the existing account and
exits zero, and — worth stating because the opposite is the natural assumption —
it does **not** rotate the password. Anything it did not write itself is refused
rather than repaired: a different address already holding the role, the address
already belonging to somebody inside an institution, a mis-scoped assignment, or
a user left institution-less by a run that stopped between its two writes. Each
refusal names what was found and writes nothing. See
docs/DATABASE_OPERATIONS.md §4.3b for the full table.

Run `inspect` first. It reads and reports — how many institutions, users and
role assignments exist, which system roles are present, whether the tenant
stage would be allowed to proceed, and who currently holds
PLATFORM_SUPER_ADMIN — and writes nothing:

```sh
az containerapp job start -n attendance-prod-bootstrap -g attendance-production-rg \
  --args inspect \
  --env-vars DATABASE_URL=secretref:database-url \
             BOOTSTRAP_TARGET=production \
             BOOTSTRAP_CONFIRM=WRITE-TO-PRODUCTION
```

`inspect` writes nothing but still asks for `BOOTSTRAP_CONFIRM`, because the
confirmation guards the *target* rather than the stage: saying "production" is
what requires the second sentence, regardless of what you then intend to do to
it. Slightly over-strict, deliberately, and in the safe direction.

The script prints the institution id, the administrator's id and the address
they sign in with. It does not print the password, the hash, or `DATABASE_URL`,
and it redacts anything URL-shaped from unexpected errors.

After the first sign-in, the administrator should issue themselves a fresh
password from the faculty directory (Dashboard → Faculty → Reset password),
which replaces the bootstrap password and ends every existing session. Until
that happens, the value that was briefly in Key Vault is a live credential.

A platform administrator bootstrapped by stage C has no faculty directory to do
that in — they belong to no institution. Their next step is Dashboard → Platform
→ Institutions → Add institution, then Administrators → Add administrator on the
institution they just created, which issues that administrator a one-time
password. The bootstrap password stays live for the platform account until it is
changed, so treat the Key Vault value as a credential until then and delete it
as shown above.

### Creating the job

The job is deployed by `infra/azure/bootstrap.bicep`, not by `main.bicep`. That
template references the managed environment, the registry, the vault and the
`DATABASE-URL` secret with `existing` and creates exactly three resources: the
job, an `AcrPull` assignment on the registry, and a `Key Vault Secrets User`
assignment on the one secret. Its `what-if` against a live
`attendance-production-rg` reports 3 × Create, 0 × Modify, 0 × Delete, and
`Ignore` for all fourteen existing resources.

It is separate from `main.bicep` for a reason worth knowing before you reach for
the obvious alternative: `parameters/production.bicepparam` still carries the
pre-Phase-G placeholders — `mcr.microsoft.com/k8se/quickstart:latest` for the
web, face-ai and migrate images, and `enableKeyVaultSecretRefs = false` — while
live production runs commit-tagged images with Key Vault references on.
Deploying `main.bicep` with that parameter file would roll all three back to the
quickstart image and strip their secret references. Reconciling the parameter
file with reality is worth doing; it is a change to three live production
resources and does not belong to a bootstrap change.

```sh
# 1. Build the image. Tagged by commit, never `latest`.
SHA=$(git rev-parse HEAD)
az acr build -r attendanceprodacr -f apps/web/Dockerfile.bootstrap \
  -t "bootstrap:$SHA" .

# 2. Read the diff. Every line of it.
az deployment group what-if -g attendance-production-rg \
  --template-file infra/azure/bootstrap.bicep \
  --parameters infra/azure/parameters/bootstrap.bicepparam

# 3. Pass 1 — creates the job and its identity, then the role assignments.
az deployment group create -g attendance-production-rg \
  --template-file infra/azure/bootstrap.bicep \
  --parameters infra/azure/parameters/bootstrap.bicepparam

# 4. Pass 2 — now that the identity can read the secret, turn the reference on.
az deployment group create -g attendance-production-rg \
  --template-file infra/azure/bootstrap.bicep \
  --parameters infra/azure/parameters/bootstrap.bicepparam \
  --parameters enableKeyVaultSecretRefs=true
```

Two passes, for the same reason `modules/app.bicep` needs them: the platform
resolves a Key Vault secret reference when the job is created or updated, using
the job's system-assigned identity — which does not exist until the job has been
created once. Pass 1 without the reference, grant, then pass 2 with it.

Creating the job does not run it. Confirm that before going further:

```sh
az containerapp job execution list -n attendance-prod-bootstrap \
  -g attendance-production-rg --query "length(@)" -o tsv   # must be 0
```

### If it refuses

That is the design working. `tenant` will not run unless all eight system roles
are present and the database holds zero institutions, zero users and zero role
assignments. It does not repair a partial state — a database with an institution
but no administrator is something to look at, not something for a script to
guess at. Read the refusal, run `--args inspect`, and decide deliberately.

---

## The Face AI service

`attendance-prod-face-ai` runs `FACE_MODEL_BACKEND=azure_detection_own_recognition`:
Azure AI Face is asked where the faces are, and the service recognises them in
its own process, on weights baked into the image. Identify is never called, so
**no part of production waits on Microsoft's Limited Access approval** and no
face template leaves the container. The design is
[`services/face-ai/docs/RECOGNITION.md`](../services/face-ai/docs/RECOGNITION.md);
what follows is what an operator needs.

Two standing caveats, so that nobody operating this reads "deployed" as
"settled":

- **The recogniser's weights are public domain, and one question about them is
  open.** About half the images they were trained on came from two research
  corpora with non-commercial licences. Whether that restricts commercial use
  of a model trained on them is an unsettled question of law, it has been
  **referred for legal review, and it is not resolved**. The audit is
  [`services/face-ai/docs/MODEL_LICENSES.md`](../services/face-ai/docs/MODEL_LICENSES.md).
  If the review comes back negative, the replacement path is one registry
  entry and a re-enrolment — not a rewrite.
- **The thresholds are provisional.** They were measured on public-domain
  adult portraits, and re-measured end to end through the production path. No
  classroom photograph, no child, and no pair of siblings has been measured
  against this pipeline. Uncertain matches go to a teacher by design; treat
  the automatic decisions as advisory until an institution has validated them
  against its own population
  ([`CALIBRATION.md`](../services/face-ai/docs/CALIBRATION.md)).

### Environment

| Variable | Production value | Set by |
|---|---|---|
| `FACE_MODEL_BACKEND` | `azure_detection_own_recognition` | **the deploy workflow**, re-asserted on every deployment (`.github/workflows/deploy.yml`, the Face AI step); mirrored in `infra/azure/parameters/production.bicepparam` |
| `FACE_AI_REQUIRE_PRODUCTION_MODEL` | `true` | the same. Refuses to start on a backend whose licence is not cleared |
| `FACE_MODEL_DIR` | `/srv/models` | **the image**, not the container app. `ENV` in `services/face-ai/Dockerfile`, alongside the weights it points at |
| `AZURE_FACE_ENDPOINT` | `https://attendance-azure-face.cognitiveservices.azure.com/` | `production.bicepparam` |
| `AZURE_FACE_KEY` | `secretref:azure-face-key` | Container App secret → Key Vault `AZURE-FACE-KEY` |
| `FACE_AI_AUTH_TOKEN` | the shared service token | Container App secret → Key Vault `FACE-AI-SERVICE-TOKEN`; `docs/SECURITY.md` §4 |
| `FACE_AI_REQUIRE_AUTH` | `true` | `modules/app.bicep`, tied to `enableKeyVaultSecretRefs`: the service refuses to start unauthenticated in any environment that has real secrets attached |

The weights are **in the image**, fetched and checksum-verified at build time
and never downloaded at runtime. There is no volume to mount and no model
directory to provision: a face-ai revision either has the right bytes baked
in or fails to start.

The first two are declared in the deploy workflow rather than carried forward
from whatever the previous revision happened to have, because they are the
difference between a service that recognises faces and one that does not.
Everything else on the template — the Key Vault secret references above,
ingress, identity, scale — is carried forward by `az containerapp update`
untouched. Changing the backend is therefore an edit to the workflow and a
deployment, not a console action somebody has to remember to repeat.

Rotating the Azure key is the same shape as any other: write the new value to
`AZURE-FACE-KEY` in `attendance-prod-keyvault` and restart the face-ai
revision. Nothing in git changes. See `docs/AZURE_FACE.md`.

### Startup, and what each failure means

Startup is fail-fast and strictly ordered. Each step exists because its
failure mode is otherwise silent:

1. **Verify the recogniser weights' SHA-256** against the pin in
   `app/models/model_files.py`.
2. **Load the network.**
3. **Run the golden self-test** — the network on a fixed synthetic chip,
   compared against pinned values.
4. **Build the Azure client.**
5. **One Detect call on a synthetic pattern**, to prove the credential.

A successful boot records which model it loaded, on one line:

```
INFO app.main face-ai model loaded: backend=azure_detection_own_recognition
  version=dlib-models-2a61575+pp1+al1.detection_03 runtime=dlib+azure-face-detect
  commercial_use=permitted production_eligible=True
```

That line is the answer to "which recogniser is this container running?", and
it is worth checking after any deployment. `FACE_AI_LOG_LEVEL` controls the
threshold and defaults to `INFO`; set it to `WARNING` only if something is
flooding, and know that you lose that line by doing so. A backend that is not
cleared for production logs a warning on every boot as well — deliberately
loud, because a stub running where people believe real recognition is
happening is the failure worth shouting about.

| Symptom in the logs | What it means | What to do |
|---|---|---|
| Weights checksum mismatch | The image's model layer is not the one that was built and verified | Roll back to the previous face-ai digest; rebuild. Do not "re-pull" |
| Golden self-test failure | This build of dlib computes different descriptors — a different BLAS, a miscompiled SIMD path, substituted weights. Templates written by it would not match templates written by any other build | Roll back. The same check runs in the image build (`scripts/verify_recognizer.py`), so an image that fails here should never have been pushed — find out why it was |
| Startup fails naming the backend's commercial-use status | `FACE_AI_REQUIRE_PRODUCTION_MODEL=true` and `FACE_MODEL_BACKEND` selects an uncleared backend | Fix the parameter. Do not clear the guard |
| Startup fails on the Azure probe, credential rejected | The key is wrong, revoked, or points at the wrong resource | Check `AZURE-FACE-KEY` in Key Vault, then restart the revision |
| **Warning** at startup, service running, requests answering `503` | Azure was merely unreachable at boot. The service starts deliberately in this case | Treat as an Azure incident, not a deployment one. It recovers without a redeploy |
| `503` from `/v1/detect-embed` under load | An Azure outage propagating. **It is never reported as "no faces found"** — a classroom with nobody in it is a claim, and an outage is not evidence for it | Teachers fall back to roll-call; the capture wizard already does this |

A wrong key stops the service; an unreachable Azure does not. The distinction
is deliberate: one is a deployment mistake that should never serve traffic,
and the other is somebody else's incident that will pass.

### Checking what a revision is actually running

Both scripts ship in the image. Neither needs the network, an Azure
credential, or the service to be answering requests — only a replica to exec
into:

```sh
az containerapp exec -n attendance-prod-face-ai -g attendance-production-rg \
  --command "python scripts/verify_recognizer.py --dir /srv/models"
# weights SHA-256 + the golden self-test. Exits non-zero, loudly, on any
# mismatch. Prints no vector.

az containerapp exec -n attendance-prod-face-ai -g attendance-production-rg \
  --command "python scripts/sbom.py --pretty"
# CycloneDX inventory: the pinned model artefacts with their checksums and
# source URLs, plus the installed distribution versions. Generated rather
# than committed so it cannot drift from what the build actually reads.
```

`verify_recognizer.py` is the first thing to run against a container that is
behaving oddly — it answers "is this the recogniser we calibrated?" without
touching Azure. `sbom.py` answers "what is actually in this image?", which is
the question an audit asks and which a requirements file cannot answer,
because a range is what was asked for and not what was installed.

## Health checks

```sh
# Web — external, public FQDN
FQDN=$(az containerapp show -n attendance-prod-web -g attendance-production-rg \
  --query "properties.configuration.ingress.fqdn" -o tsv)
curl -sS -o /dev/null -w '%{http_code}\n' "https://$FQDN/"

# Face AI — MUST be false. If this ever returns true, treat it as an incident:
# POST /v1/enroll turns a photograph into a stored biometric template.
az containerapp show -n attendance-prod-face-ai -g attendance-production-rg \
  --query "properties.configuration.ingress.external" -o tsv

# Database — MUST be Disabled. Never "temporarily" enable this.
az postgres flexible-server show -n attendance-prod-psql -g attendance-production-rg \
  --query "network.publicNetworkAccess" -o tsv
```

Face AI's `/v1/health` is reachable only from inside the environment, which is
the point. Check it from the web app's console (`az containerapp exec`) or via
the internal FQDN from another app in the same environment — not by exposing it.

### Logs

```sh
az containerapp logs show -n attendance-prod-web -g attendance-production-rg --tail 100
```

Never paste `DATABASE_URL`, an access token, a face embedding, or a classroom
image into a ticket, a chat, or this repository.

---

## How production is deployed, and what stops it happening by accident

### Deployment is automatic on `main`.

`deploy.yml` runs on **every push to `main`**, and `main` is the deployable
line: merging into it is the deliberate act. The normal bug-fix loop is

```
code change -> git push origin main -> production
```

`workflow_dispatch` is kept alongside it for controlled redeploys — rolling a
build forward without a new commit, or re-running a deploy after fixing
something in Azure:

```sh
gh workflow run "Deploy (production)" --repo 13-Manan/Attendance --ref main
```

Nothing reaches Azure without passing CI first: `deploy.yml` calls `ci.yml` as
a reusable workflow and the build job `needs` it, so a failing lint, type,
test, integration or image check stops the run before an image is built.

The intended gate was additionally a **required reviewer** on the `production`
environment. That is **not configured and cannot be** — GitHub does not offer
environment protection rules on a private repository under the Free plan, and
neither publishing an attendance system's source nor buying a plan is a
reasonable way to obtain an approval prompt. CI plus the branch is the gate
instead, and that trade-off is accepted deliberately. Anyone
who can run workflows in this repository can start a production deployment;
there is no second pair of eyes enforced by the platform.

The branch restriction *is* enforced, twice:

- the `production` environment has a deployment branch policy permitting only
  `main`, and every Azure-touching job declares `environment: production`;
- `guard` re-checks `GITHUB_REF` itself, so deleting that policy does not
  silently re-open deployment from an arbitrary branch.

### OIDC — configured

Authentication is **GitHub federated credentials**. No Azure client secret
exists, and none was ever created — the app registration has empty
`passwordCredentials` and `keyCredentials`.

| | |
|---|---|
| Entra app | `attendance-prod-github-deploy` |
| Client ID | `cdb3ff1c-a376-435b-aff2-1000cdd11795` |
| SP object ID | `74ced053-72b1-4295-94cf-936dbf01d84f` |
| Credential name | `github-13-Manan-Attendance-environment-production` |
| Federated subject | `repo:13-Manan@125882404/Attendance@1375678405:environment:production` |
| Issuer / audience | `token.actions.githubusercontent.com` / `api://AzureADTokenExchange` |

The subject is a literal with no wildcard: a token from another repository,
branch, tag, fork or pull request does not match it and the exchange fails.

Two things about its shape are easy to get wrong, and both were, originally:

- **It is scoped to the environment, not the branch.** A job that declares
  `environment: production` gets a `:environment:production` subject; only a
  job without an environment gets `:ref:refs/heads/main`. Every Azure-touching
  job in `deploy.yml` declares the environment, so `:ref:` never appears. A
  credential registered for the ref form authenticates none of them.
- **This repository has GitHub's immutable subject claims enabled**, so the
  prefix is qualified by numeric owner and repository IDs rather than by name —
  `13-Manan@125882404`, `Attendance@1375678405`. A credential written with the
  plain `repo:13-Manan/Attendance` prefix matches nothing at all.

Confirm the live values rather than trusting this table:

```sh
gh api repos/13-Manan/Attendance/actions/oidc/customization/sub
az ad app federated-credential list --id cdb3ff1c-a376-435b-aff2-1000cdd11795 \
  --query "[].{name:name, subject:subject}" -o table
```

A superseded credential for the old `repo:13-Manan/Attendance:ref:refs/heads/main`
subject was removed on 2026-09-19. It authenticated nothing — with immutable
subject claims enabled GitHub cannot emit that subject for this repository — so
the list above should now show exactly one credential. A second one appearing
is worth investigating rather than assuming it is this one returning.

Its complete Azure footprint — six assignments, verified subscription-wide:

| Role | Scope |
|---|---|
| `Reader` | `attendance-production-rg` |
| `Contributor` | `attendance-prod-web` |
| `Contributor` | `attendance-prod-face-ai` |
| `Contributor` | `attendance-prod-migrate` |
| `Container Registry Tasks Contributor` | `attendanceprodacr` |
| `AcrPush` | `attendanceprodacr` |

`Contributor` is pinned to three individual resources, never the subscription
and never the resource group — no built-in role other than `Contributor`/`Owner`
grants the bare `Microsoft.App/containerApps/write` that `az containerapp
update` needs (`Container Apps Contributor` grants only
`containerApps/*/write`, which does not match it). The identity has **no** Key
Vault access, **no** PostgreSQL access, and cannot assign roles.

`Container Registry Tasks Contributor` is required because `AcrPush` alone
lacks `registries/scheduleRun/action` and therefore cannot run `az acr build`.

### GitHub repository secrets

Three, all **identifiers rather than credentials**: `AZURE_CLIENT_ID`,
`AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`.

---

## Current state

As of the first end-to-end CI/CD deployment — GitHub Actions run
[`35444452111`](https://github.com/13-Manan/Attendance/actions/runs/35444452111),
commit `9c8b305972d527c0047aa221eb9ee700efac9b7f`, Succeeded:

| | |
|---|---|
| `attendance-production-rg` | **Created**, 15 resources + 6 role assignments on the deploy identity |
| Infrastructure (Bicep) | **Deployed** — both passes (`attendance-bootstrap-pass2`, Succeeded) |
| `attendance-prod-psql` | **Ready**, `publicNetworkAccess: Disabled`, 0 firewall rules |
| `attendance_prod` database | **Migrated** — both migrations applied by `prisma migrate deploy` (`20260917000000_init`, `20260917000100_query_pattern_indexes`) |
| pgvector | **Created** — `CREATE EXTENSION IF NOT EXISTS vector` runs in the baseline migration, which has now been applied |
| `enableKeyVaultSecretRefs` | **true** — web resolves 4/4 secrets and face-ai 1/1 through Key Vault references |
| Key Vault secrets | **All four set** — `DATABASE-URL`, `AUTH-SECRET`, `API-KEY-PEPPER`, `FACE-AI-SERVICE-TOKEN` |
| Images built and pushed | **All three**, tag `9c8b305…`; earlier `ab8ef435…` and `8acfde96…` retained for rollback |
| `attendance-prod-web` | **Serving** `web@sha256:a0850e5a…`, revision `attendance-prod-web--0000002`, Running |
| `attendance-prod-face-ai` | **Serving** `face-ai@sha256:a233d1a8…`, revision `attendance-prod-face-ai--0000002`, Running/Healthy, ingress **internal-only** |
| Production traffic | **Live** — `/` and `/api/health` both return 200 |
| DNS | **Unchanged** (no custom domain) |
| GitHub OIDC | **Configured** — one credential, `:environment:production`; see above |
| Required reviewer | **Not configured** — unavailable on this plan; see above |

The deployed digests are what the pipeline handed to Container Apps and read
back; the SHA tags above resolve to them in `attendanceprodacr`.

`attendance-prod-bootstrap` is a separate manually-triggered job and is not part
of this pipeline. Its execution history is not evidence of tenant contents —
verify those through the application, not from here.

### Secrets

All four runtime secrets exist in `attendance-prod-keyvault`. List them by
**name only** — never by value:

```sh
az keyvault secret list --vault-name attendance-prod-keyvault \
  --query "[].{name:name, enabled:attributes.enabled}" -o table
```

Writing them requires a **Key Vault Secrets Officer** assignment on the vault.
Owner is not enough: the vault uses RBAC authorization, which grants Owner the
management plane only, so `az keyvault secret list` returns `ForbiddenByRbac`
without a data-plane role.

#### Rotating the PostgreSQL password

The administrator password is held only in `DATABASE-URL`. Rotation does not
require knowing the old value, so a lost password is recoverable:

```sh
# Generate, rotate and store in one step, so the value never lands anywhere else
PGPASS="$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)Aa9"
az postgres flexible-server update -n attendance-prod-psql \
  -g attendance-production-rg --admin-password "$PGPASS"
az keyvault secret set --vault-name attendance-prod-keyvault --name DATABASE-URL \
  --value "postgresql://attendance_admin:$PGPASS@attendance-prod-psql.postgres.database.azure.com:5432/attendance_prod?sslmode=require&schema=public" \
  --output none
unset PGPASS
```

`--output none` matters: without it the CLI prints the secret it just set.
Restart the web app afterwards so it picks up the new secret version.
