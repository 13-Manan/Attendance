// =============================================================================
// ATTENDANCE PROJECT — production bootstrap job (standalone deployment)
// =============================================================================
//
// Target resource group : attendance-production-rg
// Scope                 : ATTENDANCE ONLY, and within it, only the new job.
//
// This template creates exactly three things:
//
//   1. attendance-prod-bootstrap          a manual Container Apps Job
//   2. AcrPull                            for that job's identity, on the ACR
//   3. Key Vault Secrets User             for that job's identity, on ONE secret
//
// Everything else it names — the managed environment, the registry, the vault,
// the DATABASE-URL secret — is referenced with `existing`. ARM reads those to
// resolve their ids and writes nothing to them. No app, no revision, no job, no
// secret, no network and no database is touched.
//
// ---------------------------------------------------------------------------
// Why this is not simply a module wired into main.bicep
// ---------------------------------------------------------------------------
// It eventually should be. Today it cannot be deployed that way safely:
// parameters/production.bicepparam still carries the pre-Phase-G placeholders
// (`mcr.microsoft.com/k8se/quickstart:latest` for all three images, and
// enableKeyVaultSecretRefs = false), while live production runs commit-tagged
// images with Key Vault references switched on. Deploying main.bicep with that
// parameter file would roll the web app, face-ai and the migration job back to
// the quickstart image and strip their secret references — a production outage,
// produced by an entirely unrelated change.
//
// Reconciling the parameter file with what is actually deployed is a real and
// worthwhile change. It is also a change to three live production resources,
// which is not this one's business. So the bootstrap job is composed here
// against existing resources instead, its what-if diff contains only the three
// resources above, and main.bicep is left exactly as it is.
//
// Deploy with:
//
//   az deployment group what-if \
//     --resource-group attendance-production-rg \
//     --template-file infra/azure/bootstrap.bicep \
//     --parameters infra/azure/parameters/bootstrap.bicepparam
//
// Read every line of the diff, then repeat with `create`. Twice — see the
// enableKeyVaultSecretRefs note below.

targetScope = 'resourceGroup'

// --- Naming — must match what main.bicep already deployed -------------------

@description('Azure region for the new job.')
param location string = 'centralindia'

@description('Prefix for all Attendance resources.')
param namePrefix string = 'attendance-prod'

@description('Existing Container Apps managed environment.')
param environmentName string = '${namePrefix}-cae'

@description('Existing Key Vault holding DATABASE-URL.')
param keyVaultName string = '${namePrefix}-keyvault'

@description('Existing Container Registry.')
param registryName string = 'attendanceprodacr'

@description('''Name of the existing Key Vault secret this job may read. It is
named here so the role assignment below can be scoped to this one secret rather
than to the whole vault.''')
param databaseUrlSecretName string = 'DATABASE-URL'

// --- The job ----------------------------------------------------------------

@description('''Bootstrap image, tagged by commit. Never `latest`: the point of
an immutable tag is that the thing that wrote the first administrator into
production can be identified exactly, afterwards, from the job definition.''')
param bootstrapImage string

@description('''Pass 2 switch. The platform resolves a Key Vault secret
reference when the job is created or updated, using the job's system-assigned
identity — which does not exist until the job has been created once. So:

  pass 1   deploy with false. The job and its identity are created; the role
           assignments below are created against that identity.
  pass 2   deploy with true. The job is updated to carry the reference, which
           now resolves because the identity already has access.

Same mechanism and same reason as modules/app.bicep. Leaving it false forever
yields a job with no DATABASE_URL, which fails closed.''')
param enableKeyVaultSecretRefs bool = false

@description('Applied to the new job, matching every other Attendance resource.')
param tags object = {
  Project: 'Attendance'
  Environment: 'Production'
  ManagedBy: 'Bicep'
  Application: 'Attendance'
  Owner: 'QUBRIX'
  Repository: 'attendance-platform'
}

// =============================================================================
// Existing resources — read, never written
// =============================================================================

resource environmentExisting 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource acrExisting 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource keyVaultExisting 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// Referencing the secret as a resource, rather than building its URI as a
// string, is what makes the narrow role assignment below possible: a role
// assignment needs a scope, and a scope needs a resource id.
resource databaseUrlSecretExisting 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: keyVaultExisting
  name: databaseUrlSecretName
}

// =============================================================================
// The bootstrap job
// =============================================================================

module bootstrapJob 'modules/bootstrap-job.bicep' = {
  name: 'attendance-bootstrap-job'
  params: {
    location: location
    namePrefix: namePrefix
    environmentId: environmentExisting.id
    acrLoginServer: acrExisting.properties.loginServer
    keyVaultUri: keyVaultExisting.properties.vaultUri
    bootstrapImage: bootstrapImage
    enableKeyVaultSecretRefs: enableKeyVaultSecretRefs
    tags: tags
  }
}

// =============================================================================
// RBAC — two grants, both on one resource each, both for one identity
// =============================================================================

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

// Seeded from the job NAME, not its principal id, for the reason main.bicep
// gives: the principal id does not exist at the start of the deployment that
// creates it, and ARM needs the assignment's name up front. The name is stable,
// so a redeploy updates this assignment rather than adding a second one.
var bootstrapJobName = '${namePrefix}-bootstrap'

// Pull, and nothing else. No push, no delete, no token management. ACR's
// built-in roles are registry-wide — there is no repository-scoped variant of
// AcrPull on a registry without ABAC enabled — so this is the narrowest
// supported grant, and it is the same one the three existing identities hold.
resource bootstrapAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acrExisting
  name: guid(acrExisting.id, bootstrapJobName, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: bootstrapJob.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// Note the scope: the SECRET, not the vault. Key Vault's RBAC model accepts a
// scope of .../vaults/<vault>/secrets/<secret>, so this identity can read
// DATABASE-URL and is not a member of any role that can enumerate or read
// AUTH-SECRET, API-KEY-PEPPER or FACE-AI-TOKEN. That is strictly narrower than
// the vault-wide grants the web app, face-ai and the migration job hold — those
// predate this and are not changed here.
//
// Key Vault Secrets User is read-only by definition: get and list on secrets,
// no set, no delete, no purge. This job cannot rewrite the connection string it
// reads.
resource bootstrapKeyVaultSecret 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: databaseUrlSecretExisting
  name: guid(databaseUrlSecretExisting.id, bootstrapJobName, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: bootstrapJob.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// What this identity deliberately does NOT get: no storage role (bootstrapping
// has nothing to do with classroom captures), no database control-plane role
// (it reaches PostgreSQL over the network as an ordinary client, with the
// credential in the connection string), and nothing at resource group or
// subscription scope.

// =============================================================================
// Outputs — no secrets, no connection strings.
// =============================================================================

output bootstrapJobName string = bootstrapJob.outputs.jobName
output bootstrapJobId string = bootstrapJob.outputs.jobId
output bootstrapJobPrincipalId string = bootstrapJob.outputs.principalId
output bootstrapImageDeployed string = bootstrapImage
