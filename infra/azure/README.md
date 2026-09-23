# Azure production infrastructure — ATTENDANCE

Infrastructure-as-code for the Attendance platform's production environment on
Microsoft Azure. Everything here is Attendance-only.

**Status: nothing is deployed.** These templates are written and validated
(`az bicep build` passes) but have never been applied to Azure. No resource
group, no database, no application. See [Deployment status](#deployment-status).

---

## Scope boundary — read this first

All Attendance production resources live in one resource group:

```
attendance-production-rg        (Central India)
```

This subscription contains **41 resource groups** belonging to other projects.
None of them are referenced, reused, modified, or peered to by anything in this
directory.

One of them needs naming out loud:

> **`rg-connect-4483-attendance`** (eastus2) contains
> `connect-4483-attendance-resource`, a `Microsoft.CognitiveServices/accounts`
> resource of kind **AIServices**, plus a Foundry project. Despite the word
> "attendance" in its name it is an **Azure AI Foundry** resource belonging to a
> different project, matching the `rg-connect-XXXX` pattern of ~12 other
> auto-provisioned RGs in this subscription. **It is not part of this platform
> and must not be touched.**

### The one resource Azure creates outside our boundary

Azure Container Apps provisions a platform-managed resource group named
`ME_<environment>_<resource-group>_<region>` to hold the environment's internal
infrastructure. It is created by Azure, not by these templates; it cannot be
renamed, relocated, tagged or locked by us; and it is unavoidable when using
Container Apps. Azure App Service does not have this behaviour — that was the
trade-off accepted when Container Apps was chosen.

---

## Architecture

```
                         Internet
                            │ HTTPS
                            ▼
              ┌──────────────────────────────┐
              │  attendance-prod-web         │   Container App
              │  Next.js 16 · external       │   external ingress
              └───────┬──────────────┬───────┘
                      │              │
   internal ingress   │              │  private VNet
   (no public FQDN)   │              │
                      ▼              ▼
   ┌──────────────────────────┐   ┌────────────────────────────┐
   │ attendance-prod-face-ai  │   │ attendance-prod-psql       │
   │ FastAPI · ONNX Runtime   │   │ PostgreSQL Flexible Server │
   │ FaceModelProvider        │   │ PG 17 · pgvector           │
   │ NO database credentials  │   │ attendance_prod            │
   └──────────────────────────┘   └────────────────────────────┘

   Supporting:  attendance-prod-keyvault (Key Vault) · attendanceprodacr (ACR)
                attendanceprodsa (Blob) · attendance-prod-law / -appi
                attendance-prod-vnet
```

The arrow that is *absent* matters as much as the ones present: **face-ai has no
line to Postgres.** Per ADR-0002 and `ARCHITECTURE.md`, the Python service is a
pure function — image in, embedding out — and holds no database credential at
all. Class-scoped vector search happens in `apps/web` via Prisma `$queryRaw`.
The infrastructure enforces that rather than trusting it: face-ai's managed
identity is granted no database role and no storage role.

---

## Resources

| Resource | Name | Why |
| --- | --- | --- |
| Resource group | `attendance-production-rg` | The Attendance boundary |
| Virtual network | `attendance-prod-vnet` | `10.20.0.0/16`, dedicated, unpeered |
| PostgreSQL | `attendance-prod-psql` | `attendance_prod` + pgvector |
| Container Apps env | `attendance-prod-cae` | Hosts both services |
| Web app | `attendance-prod-web` | Next.js, external ingress |
| Face AI | `attendance-prod-face-ai` | FastAPI, **internal ingress only** |
| Container registry | `attendanceprodacr` | Two images; ACR names allow no hyphens |
| Key Vault | `attendance-prod-keyvault` | Four runtime secrets |
| Storage | `attendanceprodsa` | Classroom captures; storage names allow no hyphens |
| Log Analytics | `attendance-prod-law` | Required by the Container Apps env |
| App Insights | `attendance-prod-appi` | Application telemetry |

Global-uniqueness of `attendanceprodacr` and `attendanceprodsa` was confirmed
available on 2026-09-18. `attendance-prod-psql` cannot be checked before create.

---

## Region: Central India

| Capability | Central India | South India |
| --- | --- | --- |
| Postgres Flexible Server versions | 11–18 | 11–18 |
| Editions | Burstable / GP / MemoryOptimized | same |
| Geo-backup | Enabled | Enabled |
| **ZoneRedundantHA + GeoBackup** | **Enabled** | **Disabled** |
| Container Apps | Available | Available |

Central India is the only one of the two offering zone-redundant HA together
with geo-backup, it is the primary India region for latency, and South India is
its Azure-paired region — which makes it the geo-backup target rather than the
primary. Cost was not the deciding factor; the two are priced alike.

### <a name="ha"></a>HA — an unresolved contradiction

The capability API reports `zoneRedundantHaSupported: Disabled` **and**
`zoneRedundantHaAndGeoBackupSupported: Enabled` for Central India. Those cannot
both be straightforwardly true. `postgresHighAvailabilityMode` is therefore
`Disabled` in `production.bicepparam`, and **no runbook should promise HA** until
the real behaviour is confirmed against a provisioned server.

---

## Database

### Local and production are separate. Permanently.

```
LOCAL                                PRODUCTION
Mac                                  Azure
 └ PostgreSQL (docker-compose)        └ PostgreSQL Flexible Server
    └ attendance_dev                     └ attendance_prod
```

Rules that do not bend:

- Local development **never** points at the production database.
- Production biometric data is **never** copied to a laptop.
- Production is **never** seeded with fake students or fake face data.
- The two databases are **never** synchronised.

`docker-compose.yml` pins `pgvector/pgvector:pg16` locally while production is
PG **17**. Both support everything the schema uses; if strict parity is wanted,
change the local image — do not downgrade production.

### Configuration and why

| Setting | Value | Reasoning |
| --- | --- | --- |
| Tier | GeneralPurpose `Standard_D2s_v3` | 2 vCore / 8 GiB. pgvector similarity search is CPU- and memory-bound, and load arrives in bursts at period boundaries. Burstable would throttle on exhausted credits during exactly that rush |
| Version | PostgreSQL 17 | Supported in-region; pgvector available |
| Storage | 64 GiB, autogrow on | Embeddings are 512 floats/student; the volume is attendance rows, which grow linearly per session |
| Backup | 14 days, geo-redundant | Attendance is a legal record. 14 days covers a reporting cycle; geo-redundancy survives a regional failure |
| Network | Private VNet, delegated subnet | No public endpoint at all |
| Auth | Password + Entra enabled | Entra available for humans; Prisma uses the password path |

### pgvector

`prisma/schema.prisma` declares `FaceEmbedding.embedding` as
`Unsupported("vector(512)")`, and `migrations/20260917000000_init/migration.sql`
opens with `CREATE EXTENSION vector`.

On Azure that `CREATE` **fails** unless the extension is allow-listed on the
server first. `modules/postgres.bicep` sets the `azure.extensions` server
parameter to `VECTOR` for exactly this reason. Without it the first migration
dies with `extension "vector" is not allow-listed`.

Allow-listing makes the extension *creatable*; the existing baseline migration
is still what creates it. **Not yet verified against a live server** — there is
no server.

No ANN (HNSW/IVFFlat) index is created, matching the schema's deliberate choice:
nothing in the codebase uses the `<=>` operator, so an index would have no
reader and only add write cost (`docs/BENCHMARKS.md` §4).

### <a name="running-migrations-against-production"></a>Running migrations against production

The private-networking choice has a real cost: **you cannot run
`prisma migrate deploy` from your Mac.** There is no public endpoint to reach.

Use one of:

1. A Container Apps **job** in the same environment running `prisma migrate deploy`
   (preferred — same network, same image, auditable).
2. A jumpbox VM inside `attendance-prod-vnet`.
3. Azure Cloud Shell with VNet integration.

Never permitted against production:

- `prisma db push` — bypasses migration history
- `prisma migrate reset` — destroys data
- `prisma migrate dev` — authors migrations; it is a development command

---

## Secrets

Four secrets, all in Key Vault, all resolved by managed identity. None appear in
git, in a Bicep file, in a `.bicepparam`, in a container image, or in logs.

| Key Vault secret | Consumer |
| --- | --- |
| `DATABASE-URL` | web |
| `AUTH-SECRET` | web |
| `API-KEY-PEPPER` | web |
| `FACE-AI-SERVICE-TOKEN` | web (sends) **and** face-ai (verifies) |

The last one is a single shared value with two names — `FACE_AI_SERVICE_TOKEN`
in `apps/web`, `FACE_AI_AUTH_TOKEN` in `services/face-ai` — on the two sides of
the internal contract.

Set them after deployment, never through a template parameter:

```sh
az keyvault secret set --vault-name attendance-prod-keyvault \
  --name AUTH-SECRET --value "$(openssl rand -base64 32)"
```

> ⚠️ `production.bicepparam` reads the database password via
> `readEnvironmentVariable('ATTENDANCE_PG_ADMIN_PASSWORD')`. That keeps the value
> out of git, but Bicep **inlines it into the compiled JSON at build time**. So
> never run `az bicep build-params --outfile` on it — that writes the password to
> disk. `az deployment group create` compiles in memory, which is safe.

---

## Networking

```
attendance-prod-vnet  10.20.0.0/16
├── snet-container-apps  10.20.0.0/23  → delegated Microsoft.App/environments
└── snet-postgres        10.20.2.0/24  → delegated Microsoft.DBforPostgreSQL/flexibleServers
```

Plus a private DNS zone, `attendance-prod-psql.private.postgres.database.azure.com`,
linked to the VNet. Without that link the database FQDN resolves to nothing from
the app subnet and every connection fails at DNS rather than at auth.

- Postgres has **no public endpoint and no firewall rule**.
- face-ai has **no public FQDN** (`ingress.external = false`).
- Only the web app is internet-reachable, over HTTPS, with `allowInsecure` off.
- The VNet is dedicated and unpeered. No existing VNet was reused or examined
  for reuse.

`/23` for Container Apps is not arbitrary: a workload-profiles environment needs
at least a `/27`, but the subnet **cannot be resized after injection**, so it is
sized for growth up front.

---

## Security posture for biometric data

| Requirement | How it is met |
| --- | --- |
| Embeddings not exposed publicly | `modules/face-enrollment` never returns raw embeddings; face-ai has no public ingress |
| DB credentials not in git | Key Vault + managed identity; `.env` is gitignored |
| Secrets not in source or images | No secret in any Bicep/param file or Dockerfile |
| DB not casually internet-exposed | Private VNet injection, no public endpoint |
| Face AI has no DB credentials | Granted no database role — enforced, not assumed |
| Classroom images not permanent | Lifecycle policy deletes after 30 days |
| Images not in public storage | `allowBlobPublicAccess: false`, container `publicAccess: None` |
| No account-key access to blobs | `allowSharedKeyAccess: false` — identity only |
| Tenant isolation intact | Application-level; unchanged by this work |

Not solved here, and still true from `ARCHITECTURE.md`: **face embeddings are
not encrypted at rest** beyond database and disk-level protection. Azure's
storage encryption applies, but there is no application-level envelope
encryption — that would break the vector index path or require a new dependency.

---

## Hosting decision: Azure Container Apps

Chosen over App Service because:

- **Internal-only ingress** makes face-ai unreachable from the internet as a
  platform property, not an application check. This is the single strongest
  reason, given what `POST /v1/enroll` does.
- Native VNet integration to a private-only Postgres.
- Both services are containers; one environment hosts both.
- Log Analytics wiring is built in.

Accepted costs: the `ME_*` managed resource group described above, and
containerization work that does not exist yet.

**No Dockerfiles exist in this repository.** Both services need production
Dockerfiles (multi-stage, non-root, minimal) before Phase G. The Next.js image
will also want `output: "standalone"` in `apps/web/next.config.ts`, which is not
set today.

---

## Face AI: a blocker infrastructure cannot solve

`services/face-ai/app/config.py` ships three backends:

- `mock` — a deterministic hash stub. No weights, **no real recognition**:
  a real re-capture of an enrolled student never matches, so every register
  shows the class as "no match found".
- `opencv` — YuNet + SFace. Real recognition, but commercial use is
  **unclear** (see `services/face-ai/app/models/LICENSING.md`), and the
  weights are not baked into the image.
- `onnx` — a scaffold with **no weights and no verified licence**.

Per ADR-0006, InsightFace's pretrained weights are confirmed **non-commercial
research only**. `config.py` refuses to start when
`FACE_AI_REQUIRE_PRODUCTION_MODEL=true` on a backend that is not licence-cleared.

So: this infrastructure can be provisioned and the services can run, but
**real face recognition cannot legally run in production until a
commercially-licensed model is obtained.** That is a procurement decision.
`faceModelBackend` stays `mock` and `FACE_AI_REQUIRE_PRODUCTION_MODEL` stays
false until it is resolved.

Moving production to a real backend is three changes plus a data step:
weights in the image (`scripts/fetch_models.py` at build time, with
`FACE_MODEL_DIR` set — see the Dockerfile comment), `faceModelBackend` in
`parameters/production.bicepparam`, and a redeploy. Every template enrolled
under `mock` is then outside the candidate pool (recognition filters by
model), so every student must be re-enrolled.

---

## Monitoring

One Log Analytics workspace (30-day retention) and one Application Insights
component. The Container Apps environment requires a workspace regardless, so
this is its log sink rather than optional tooling.

`docs/SECURITY.md` forbids face images, embeddings, passwords, tokens and
unnecessary personal data from reaching logs. The 30-day retention is a second
line of defence for anything that slips past that, and keeps ingestion
predictable.

---

## Backup and recovery

**Not yet configured — nothing is deployed.** What the templates *specify*:

| | |
| --- | --- |
| Automated backups | 14 days, geo-redundant to South India |
| PITR | Any point within the retention window |
| Blob soft-delete | 7 days |
| Key Vault soft-delete | 90 days, purge protection **on** |

Restore is `az postgres flexible-server restore` to a **new** server — Azure
never restores in place. Nothing below is verified until a real restore drill is
run against a real server, which has not happened.

---

## RBAC

Each container app gets a system-assigned managed identity, scoped to individual
resources:

| Identity | Role | Scope |
| --- | --- | --- |
| web | AcrPull | `attendanceprodacr` |
| web | Key Vault Secrets User | `attendance-prod-keyvault` |
| web | Storage Blob Data Contributor | `attendanceprodsa` |
| face-ai | AcrPull | `attendanceprodacr` |
| face-ai | Key Vault Secrets User | `attendance-prod-keyvault` |

No grant is at subscription or resource-group scope. No RBAC assignment
belonging to any other project is read, modified or removed. face-ai receives no
database and no storage role.

---

## Resource locks

After Phase E verification, apply **`CanNotDelete`** to `attendance-production-rg`.

- **What:** delete protection on the resource group and its contents.
- **Why:** the database holds attendance records that are a legal record, and
  biometric templates that cannot be regenerated without re-enrolling every
  student.
- **Deployments still work.** `CanNotDelete` blocks deletion, not creation or
  update, so `az deployment group create` and container image updates are
  unaffected.
- **Not `ReadOnly`** — that would block routine operations including revision
  updates and scaling.
- **Removal for maintenance:** `az lock delete --name <lock> --resource-group
  attendance-production-rg`, then re-apply. Requires Owner or User Access
  Administrator.
- Locks are applied **only** to Attendance resources.

---

## Layout

```
infra/azure/
├── README.md                          this file
├── main.bicep                         orchestration + RBAC
├── parameters/
│   └── production.bicepparam          no secrets
└── modules/
    ├── networking.bicep               VNet, subnets, private DNS
    ├── postgres.bicep                 Flexible Server, pgvector, attendance_prod
    ├── keyvault.bicep                 Key Vault (RBAC mode)
    ├── container-registry.bicep       ACR
    ├── storage.bicep                  Blob + lifecycle expiry
    ├── app.bicep                      Container Apps env + both services
    └── monitoring.bicep               Log Analytics + App Insights
```

---

## Deploying

### Prerequisites (not done)

Two resource providers are **`NotRegistered`** on this subscription. Registration
is a **subscription-scoped** change, so it needs explicit approval:

```sh
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.DBforPostgreSQL
```

### Order

```sh
# 1. Resource group
az group create -n attendance-production-rg -l centralindia \
  --tags project=attendance environment=production managedBy=bicep

# 2. Preview. Always.
export ATTENDANCE_PG_ADMIN_PASSWORD="$(openssl rand -base64 32)"
az deployment group what-if \
  --resource-group attendance-production-rg \
  --template-file infra/azure/main.bicep \
  --parameters infra/azure/parameters/production.bicepparam

# 3. Apply
az deployment group create \
  --resource-group attendance-production-rg \
  --template-file infra/azure/main.bicep \
  --parameters infra/azure/parameters/production.bicepparam

# 4. Store the password, then forget it
az keyvault secret set --vault-name attendance-prod-keyvault \
  --name POSTGRES-ADMIN-PASSWORD --value "$ATTENDANCE_PG_ADMIN_PASSWORD"
unset ATTENDANCE_PG_ADMIN_PASSWORD
```

Pass 1 runs with `enableKeyVaultSecretRefs = false` and placeholder images, so
identities exist and roles can be assigned. Pass 2 flips it to `true` with real
images. Doing both at once fails at secret resolution — see the header of
`modules/app.bicep`.

### <a name="deployment-status"></a>Deployment status

| | |
| --- | --- |
| Resource group created | **No** |
| Infrastructure provisioned | **No** |
| Production database provisioned | **No** |
| Application deployed | **No** |
| Production traffic enabled | **No** |
| DNS changed | **No** |
| Templates validated (`az bicep build`) | **Yes** |
| Templates deployed to Azure | **No** |
