# Deployment runbook — Attendance production

Operational procedures for `attendance-production-rg` (Central India,
subscription *Pay-As-You-Go*). Architecture and rationale live in
[`infra/azure/README.md`](../infra/azure/README.md); this file is what you read
when something needs doing or undoing.

> **Infrastructure is deployed; no application is.** Every resource below
> exists and is empty of application code — the three container resources run a
> Microsoft placeholder image, and no migration has been applied. See
> §"Current state" at the end.

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
# -> attendanceprodacr.azurecr.io/web:9f3c1ab...
```

The tag *is* the commit. `git show <sha>` tells you exactly what is running.

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
the committed migration SQL — `prisma/seed.ts` is deliberately not in it, so
production cannot be seeded even by accident.

### A failed migration

The job has `replicaRetryLimit: 0`. It stops and waits for a person — a
half-applied migration retried in a loop is worse than one that halts.

Prisma records the failure in `_prisma_migrations` and refuses further
migrations until it is resolved. Read the logs, decide whether the migration
partially applied, then use `prisma migrate resolve --applied|--rolled-back`
from inside the VNet. The previous application revision keeps serving
throughout: the pipeline halts before `deploy`, so nothing has changed yet.

---

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

### Deployment is manual. There is no automatic trigger.

`deploy.yml` is **`workflow_dispatch` only**. A commit reaching `main` runs CI
and nothing else — it builds no image, runs no migration, and deploys nothing.
Production moves only when a person starts the workflow deliberately:

```sh
gh workflow run "Deploy (production)" --repo 13-Manan/Attendance --ref main
```

The intended gate was a **required reviewer** on the `production` environment.
That is **not configured and cannot be** — GitHub does not offer environment
protection rules on a private repository under the Free plan, and neither
publishing an attendance system's source nor buying a plan is a reasonable way
to obtain an approval prompt. The manual trigger is the gate instead. Anyone
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
| Federated subject | `repo:13-Manan/Attendance:ref:refs/heads/main` |
| Issuer / audience | `token.actions.githubusercontent.com` / `api://AzureADTokenExchange` |

The subject is a literal with no wildcard: a token from another repository,
branch, tag, fork or pull request does not match it and the exchange fails.

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

As of GATE 4 (deployment `attendance-prod-infra-20260918-102727`, Succeeded):

| | |
|---|---|
| `attendance-production-rg` | **Created**, 13 resources + 7 role assignments |
| Infrastructure (Bicep) | **Deployed** — pass 1 of 2 |
| `attendance-prod-psql` | **Ready**, `publicNetworkAccess: Disabled`, 0 firewall rules |
| `attendance_prod` database | **Created**, **zero tables** — no migration has run |
| pgvector | **Allow-listed** (`azure.extensions=VECTOR`); extension **not yet created** — `CREATE EXTENSION vector` is the first line of the baseline migration |
| `enableKeyVaultSecretRefs` | **false** — pass 2 pending |
| Key Vault secrets | **All four set** — `DATABASE-URL`, `AUTH-SECRET`, `API-KEY-PEPPER`, `FACE-AI-SERVICE-TOKEN` |
| Images built and pushed | **All three**, tag `8acfde96…` — but **not deployed**; all three resources still run `mcr.microsoft.com/k8se/quickstart:latest` |
| Apps serving the application | **None** |
| Production traffic | **None** |
| DNS | **Unchanged** (no custom domain) |
| GitHub OIDC | **Configured** — see above |
| Required reviewer | **Not configured** — unavailable on this plan; see above |

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
