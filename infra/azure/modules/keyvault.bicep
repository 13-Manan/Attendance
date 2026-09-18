// ATTENDANCE PROJECT — Key Vault
//
// Holds the four secrets apps/web and services/face-ai need at runtime and
// which .env.example says must never be committed:
//   DATABASE_URL, AUTH_SECRET, API_KEY_PEPPER, FACE_AI_SERVICE_TOKEN
// (FACE_AI_AUTH_TOKEN is the same value as FACE_AI_SERVICE_TOKEN — one shared
// secret, two names, one on each side of the internal contract.)
//
// RBAC authorization rather than access policies, so grants are visible in the
// same place as every other permission and can be scoped per-identity.
//
// No secret VALUES appear in this file or in any .bicepparam. Secrets are set
// after deployment (see infra/azure/README.md §Secrets) so they never pass
// through source control or a deployment history that anyone with Reader can
// list.

@description('Azure region.')
param location string

@description('Key Vault name — globally unique, 3-24 chars.')
param keyVaultName string

param tags object

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // Deleting the vault that holds the database credential and the API-key
    // pepper should not be a one-step, unrecoverable action.
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

output keyVaultId string = keyVault.id
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
