// =============================================================================
// ATTENDANCE PROJECT — production infrastructure
// =============================================================================
//
// Target resource group : attendance-production-rg
// Target region         : Central India
// Scope                 : ATTENDANCE ONLY.
//
// This template creates nothing outside its own resource group and references
// no pre-existing resource belonging to any other project. In particular it has
// no relationship with `rg-connect-4483-attendance`, which despite the name is
// an Azure AI Foundry resource belonging to a different project.
//
// Deploy with (the resource group must already exist):
//
//   az deployment group create \
//     --resource-group attendance-production-rg \
//     --template-file infra/azure/main.bicep \
//     --parameters infra/azure/parameters/production.bicepparam
//
// Add `--parameters postgresAdministratorPassword="$PGPASS"` ONLY on the very
// first deployment, the one that creates the server. Never on a redeploy: the
// password is write-only, so passing the wrong value silently replaces the
// live credential and nothing in `what-if` can warn you.
//
// Run `what-if` instead of `create` first. Always.
//
// One platform-managed resource group is created OUTSIDE this one, by Azure and
// not by this template: Container Apps provisions `ME_<env>_<rg>_<region>` to
// hold the environment's internal infrastructure. It is unavoidable with
// Container Apps and is not ours to name, tag, or lock.

targetScope = 'resourceGroup'

// --- Naming -----------------------------------------------------------------

@description('Azure region for every resource in this template.')
param location string = 'centralindia'

@description('Prefix for all Attendance resources. Keep it Attendance-specific.')
param namePrefix string = 'attendance-prod'

@description('Key Vault name — globally unique, 3-24 chars. `-kv` was taken.')
param keyVaultName string = '${namePrefix}-keyvault'

@description('Container Registry name — globally unique, alphanumeric only.')
param registryName string = 'attendanceprodacr'

@description('Storage account name — globally unique, lowercase alphanumeric.')
param storageAccountName string = 'attendanceprodsa'

@description('PostgreSQL server name — globally unique.')
param postgresServerName string = '${namePrefix}-psql'

// --- Database ---------------------------------------------------------------

@description('PostgreSQL administrator login.')
param postgresAdministratorLogin string = 'attendance_admin'

@description('''PostgreSQL administrator password. Supply it ONLY on the
deployment that creates the server:
  --parameters postgresAdministratorPassword="$PGPASS"
Leave it unset on every subsequent deployment. The property is then omitted
from the request, so a redeploy cannot reset the password of a live server —
which also means no deployment ever needs to know the existing one.
Never commit it, never put it in the .bicepparam, never echo it.''')
@secure()
param postgresAdministratorPassword string = ''

@description('PostgreSQL major version.')
@allowed([
  '16'
  '17'
])
param postgresVersion string = '17'

@description('Compute SKU — Standard_D2s_v3 is 2 vCore / 8 GiB. Bare VM size, no GP_ prefix.')
param postgresSkuName string = 'Standard_D2s_v3'

@description('Compute tier.')
param postgresSkuTier string = 'GeneralPurpose'

@description('Days of automated backup retention.')
param postgresBackupRetentionDays int = 14

@description('High availability mode — see README §HA before changing.')
param postgresHighAvailabilityMode string = 'Disabled'

// --- Applications -----------------------------------------------------------

@description('Web image. Placeholder until Phase G.')
param webImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Face AI image. Placeholder until Phase G.')
param faceAiImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Prisma migration image. Placeholder until Phase G.')
param migrateImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Pass 2 switch — see modules/app.bicep header.')
param enableKeyVaultSecretRefs bool = false

@description('Face AI backend: "mock", or "azure" for Azure AI Face (docs/AZURE_FACE.md).')
param faceModelBackend string = 'mock'

@description('Azure AI Face endpoint, used when faceModelBackend is "azure".')
param azureFaceEndpoint string = ''

@description('Days before classroom captures are deleted by lifecycle policy.')
param captureRetentionDays int = 30

// --- Tags -------------------------------------------------------------------

@description('Applied to every resource, so ownership is never ambiguous.')
param tags object = {
  Project: 'Attendance'
  Environment: 'Production'
  ManagedBy: 'Bicep'
  Application: 'Attendance'
  Owner: 'QUBRIX'
  Repository: 'attendance-platform'
}

// =============================================================================
// Modules
// =============================================================================

module networking 'modules/networking.bicep' = {
  name: 'attendance-networking'
  params: {
    location: location
    namePrefix: namePrefix
    postgresServerName: postgresServerName
    tags: tags
  }
}

module monitoring 'modules/monitoring.bicep' = {
  name: 'attendance-monitoring'
  params: {
    location: location
    namePrefix: namePrefix
    tags: tags
  }
}

module keyVault 'modules/keyvault.bicep' = {
  name: 'attendance-keyvault'
  params: {
    location: location
    keyVaultName: keyVaultName
    tags: tags
  }
}

module registry 'modules/container-registry.bicep' = {
  name: 'attendance-registry'
  params: {
    location: location
    registryName: registryName
    tags: tags
  }
}

module storage 'modules/storage.bicep' = {
  name: 'attendance-storage'
  params: {
    location: location
    storageAccountName: storageAccountName
    captureRetentionDays: captureRetentionDays
    tags: tags
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'attendance-postgres'
  params: {
    location: location
    serverName: postgresServerName
    administratorLogin: postgresAdministratorLogin
    administratorPassword: postgresAdministratorPassword
    delegatedSubnetId: networking.outputs.postgresSubnetId
    privateDnsZoneId: networking.outputs.postgresDnsZoneId
    postgresVersion: postgresVersion
    skuName: postgresSkuName
    skuTier: postgresSkuTier
    backupRetentionDays: postgresBackupRetentionDays
    highAvailabilityMode: postgresHighAvailabilityMode
    tags: tags
  }
}

module apps 'modules/app.bicep' = {
  name: 'attendance-apps'
  params: {
    location: location
    namePrefix: namePrefix
    infrastructureSubnetId: networking.outputs.containerAppsSubnetId
    logAnalyticsWorkspaceId: monitoring.outputs.logAnalyticsId
    logAnalyticsCustomerId: monitoring.outputs.logAnalyticsCustomerId
    appInsightsConnectionString: monitoring.outputs.appInsightsConnectionString
    keyVaultUri: keyVault.outputs.keyVaultUri
    acrLoginServer: registry.outputs.loginServer
    webImage: webImage
    faceAiImage: faceAiImage
    enableKeyVaultSecretRefs: enableKeyVaultSecretRefs
    faceModelBackend: faceModelBackend
    azureFaceEndpoint: azureFaceEndpoint
    tags: tags
  }
}

// The database is private, so migrations run from inside the VNet rather than
// from a laptop or a GitHub runner. See modules/migration-job.bicep.
module migrationJob 'modules/migration-job.bicep' = {
  name: 'attendance-migration-job'
  params: {
    location: location
    namePrefix: namePrefix
    environmentId: apps.outputs.environmentId
    acrLoginServer: registry.outputs.loginServer
    keyVaultUri: keyVault.outputs.keyVaultUri
    migrateImage: migrateImage
    enableKeyVaultSecretRefs: enableKeyVaultSecretRefs
    tags: tags
  }
}

// =============================================================================
// RBAC — least privilege, scoped to individual Attendance resources
// =============================================================================
//
// Every grant below is on ONE Attendance resource, for ONE managed identity
// created by this template. Nothing is granted at subscription or resource
// group scope, and no assignment anywhere else in the tenant is touched.
//
// Note what face-ai does NOT get: no database role, no storage role, no
// connection string. ADR-0002 keeps it a pure function of its input, and the
// infrastructure is what makes that enforceable rather than aspirational.

var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// Assignment names are seeded from the app NAMES, not their principal ids.
// A principal id is only known once the app exists, and ARM requires a role
// assignment's name at the start of the deployment. The names are stable, so
// the resulting GUIDs are stable too — a redeploy updates the same assignment
// instead of creating a duplicate.
var webAppName = '${namePrefix}-web'
var faceAiAppName = '${namePrefix}-face-ai'
var migrateJobName = '${namePrefix}-migrate'

resource acrExisting 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
  dependsOn: [
    registry
  ]
}

resource keyVaultExisting 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
  dependsOn: [
    keyVault
  ]
}

resource storageExisting 'Microsoft.Storage/storageAccounts@2023-05-01' existing = {
  name: storageAccountName
  dependsOn: [
    storage
  ]
}

resource webAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acrExisting
  name: guid(acrExisting.id, webAppName, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: apps.outputs.webPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource faceAiAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acrExisting
  name: guid(acrExisting.id, faceAiAppName, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: apps.outputs.faceAiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource webKeyVaultSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVaultExisting
  name: guid(keyVaultExisting.id, webAppName, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: apps.outputs.webPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// face-ai reads exactly one secret: the token it uses to authenticate its
// caller. Same vault, same role, far less to read because the vault holds
// nothing else it is granted.
resource faceAiKeyVaultSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVaultExisting
  name: guid(keyVaultExisting.id, faceAiAppName, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: apps.outputs.faceAiPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The migration job pulls its own image and reads exactly one secret. It gets
// no storage role: applying DDL has nothing to do with classroom captures.
resource migrateAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: acrExisting
  name: guid(acrExisting.id, migrateJobName, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: migrationJob.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

resource migrateKeyVaultSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: keyVaultExisting
  name: guid(keyVaultExisting.id, migrateJobName, keyVaultSecretsUserRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: migrationJob.outputs.principalId
    principalType: 'ServicePrincipal'
  }
}

// Only the web app writes classroom captures. face-ai never touches storage.
resource webStorageBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storageExisting
  name: guid(storageExisting.id, webAppName, storageBlobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: apps.outputs.webPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// =============================================================================
// Outputs — no secrets, no connection strings with credentials in them.
// =============================================================================

output resourceGroupName string = resourceGroup().name
output locationDeployed string = location
output postgresFqdn string = postgres.outputs.fullyQualifiedDomainName
output postgresDatabaseName string = postgres.outputs.databaseName
output acrLoginServer string = registry.outputs.loginServer
output keyVaultName string = keyVault.outputs.keyVaultName
output storageAccountName string = storage.outputs.storageAccountName
output webAppFqdn string = apps.outputs.webAppFqdn
output faceAiInternalFqdn string = apps.outputs.faceAiInternalFqdn
output webPrincipalId string = apps.outputs.webPrincipalId
output faceAiPrincipalId string = apps.outputs.faceAiPrincipalId
output migrationJobName string = migrationJob.outputs.jobName
output migrationJobPrincipalId string = migrationJob.outputs.principalId
