// ATTENDANCE PROJECT — Prisma migration runner (Container Apps Job)
//
// ---------------------------------------------------------------------------
// Why this exists
// ---------------------------------------------------------------------------
// attendance-prod-psql has no public endpoint and no firewall rule. That is
// deliberate (modules/postgres.bicep), and it has a consequence: nothing
// outside the VNet can reach the database — not a laptop, and not a GitHub
// Actions runner.
//
// The tempting fix is to add a temporary firewall rule for the duration of a
// deployment. That would mean the production biometric database is briefly
// reachable from the public internet on every single deploy, gated only by a
// password, at the exact moment a deployment is most likely to be going wrong.
// It is not a shortcut this project takes.
//
// Instead the migration runs *inside* the network. A Container Apps Job lands
// in the same managed environment as the two apps, which is injected into
// snet-container-apps, which is in attendance-prod-vnet — the same VNet the
// database's private DNS zone is linked to. So the job resolves and reaches
// the server exactly the way the web app does, and the database's exposure
// does not change at any point in the deployment.
//
// ---------------------------------------------------------------------------
// Failure behaviour
// ---------------------------------------------------------------------------
// replicaRetryLimit is 0 on purpose. A half-applied migration that is retried
// automatically is strictly worse than one that stops and waits for a human:
// Prisma records a failed migration in _prisma_migrations and refuses to
// continue until it is resolved, and a retry loop would just reproduce the
// failure while making the logs harder to read. The job fails, the deployment
// halts, and nobody's schema gets repaired by guesswork.
//
// triggerType is Manual, never Schedule. This job runs when a deployment
// explicitly starts it and at no other time. Creating it does not run it.
//
// ---------------------------------------------------------------------------
// What runs
// ---------------------------------------------------------------------------
// The image owns the command (`prisma migrate deploy` — see
// apps/web/Dockerfile.migrate). It is deliberately NOT overridden here, so
// there is exactly one place to read to know what executes against production.
// `migrate deploy` only applies committed migration files; it never generates
// one, never resets, and never prompts.

@description('Azure region.')
param location string

@description('Resource name prefix, e.g. attendance-prod.')
param namePrefix string

@description('Container Apps managed environment — the same one the apps use.')
param environmentId string

@description('ACR login server, e.g. attendanceprodacr.azurecr.io.')
param acrLoginServer string

@description('Key Vault URI used for the DATABASE_URL secret reference.')
param keyVaultUri string

@description('''Migration image. Placeholder until Phase G. The placeholder is
harmless because the trigger is manual — an un-run job runs nothing.''')
param migrateImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Pass 2 switch — see modules/app.bicep header.')
param enableKeyVaultSecretRefs bool = false

@description('''Seconds before a replica is killed. Generous: the baseline
migration creates 24 tables plus the vector extension on a cold server.''')
param replicaTimeoutSeconds int = 1800

param tags object

var jobName = '${namePrefix}-migrate'

var jobSecrets = enableKeyVaultSecretRefs ? [
  {
    name: 'database-url'
    keyVaultUrl: '${keyVaultUri}secrets/DATABASE-URL'
    identity: 'system'
  }
] : []

var jobSecretEnv = enableKeyVaultSecretRefs ? [
  {
    name: 'DATABASE_URL'
    secretRef: 'database-url'
  }
] : []

resource migrationJob 'Microsoft.App/jobs@2024-03-01' = {
  name: jobName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: replicaTimeoutSeconds
      // Zero. A failed migration waits for a person. See header.
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        // Two concurrent migrations against one database is never correct;
        // Prisma takes an advisory lock, so the second would block and then
        // time out. One replica, one completion.
        replicaCompletionCount: 1
      }
      secrets: jobSecrets
      registries: enableKeyVaultSecretRefs ? [
        {
          server: acrLoginServer
          identity: 'system'
        }
      ] : []
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: migrateImage
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          // DATABASE_URL arrives as a Key Vault secret reference and is the
          // only variable this container gets. It has no storage access, no
          // Face AI token, and no application configuration, because applying
          // DDL needs none of those.
          env: jobSecretEnv
        }
      ]
    }
  }
}

output jobName string = migrationJob.name
output jobId string = migrationJob.id
output principalId string = migrationJob.identity.principalId
