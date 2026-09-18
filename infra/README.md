# Infrastructure

Production infrastructure-as-code lives in [`azure/`](azure/README.md).

The target production environment is **Microsoft Azure** — a Container Apps
environment in Central India fronting an Azure Database for PostgreSQL Flexible
Server with pgvector. This supersedes the earlier Hostinger VPS plan, which was
never built.

**Nothing is deployed.** The Bicep templates under `azure/` are written and
validated but have not been applied to any Azure subscription: no resource
group, no database, no application. `azure/README.md` carries the architecture,
the security posture for biometric data, and the deployment order.

Local development is unchanged and unaffected — see the root `README.md` and
`docker-compose.yml`, which remain dev-only.
