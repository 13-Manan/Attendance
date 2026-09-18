# Deployment runbook — Attendance production

Operational procedures for `attendance-production-rg` (Central India,
subscription *Pay-As-You-Go*). Architecture and rationale live in
[`infra/azure/README.md`](../infra/azure/README.md); this file is what you read
when something needs doing or undoing.

> **Nothing described here has been run yet.** At the time of writing the
> resource group exists and is empty. See §"Current state" at the end.

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
| `attendance-prod-kv` | Key Vault |

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

## One-time setup you must approve — GitHub OIDC

`.github/workflows/deploy.yml` authenticates with **federated credentials**, so
no Azure client secret ever exists in GitHub. Setting it up creates an Entra
app registration, which is a **tenant-level object outside the resource
group** — it is listed here rather than done silently.

1. Create the app registration and service principal.
2. Add a federated credential for `repo:13-Manan/Attendance:ref:refs/heads/main`
   (and one for `repo:13-Manan/Attendance:pull_request` only if PRs ever need
   Azure access — with this pipeline they do not).
3. Grant it, **scoped to `attendance-production-rg` and nothing wider**:
   - `AcrPush` on `attendanceprodacr`
   - `Contributor` on the resource group, or narrower roles covering
     `Microsoft.App/containerApps/write` and `Microsoft.App/jobs/write`
4. Add three GitHub repository secrets — none of which is a credential, all
   three are identifiers:
   - `AZURE_CLIENT_ID`
   - `AZURE_TENANT_ID`
   - `AZURE_SUBSCRIPTION_ID`
5. Create a GitHub environment named **`production`** and add yourself as a
   required reviewer. Every Azure-touching job in `deploy.yml` declares
   `environment: production`, so this is what makes a push to `main` pause for
   human approval instead of deploying on its own.

Until step 5 exists, do not merge to `main` expecting a safe no-op.

---

## Current state

| | |
|---|---|
| `attendance-production-rg` | **Created**, empty |
| Infrastructure (Bicep) | **Not deployed** |
| `attendance-prod-psql` | **Does not exist** |
| Images built or pushed | **None** |
| Apps deployed | **None** |
| Production traffic | **None** |
| DNS | **Unchanged** |
| GitHub OIDC | **Not configured** — see above |
