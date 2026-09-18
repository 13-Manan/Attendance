// ATTENDANCE PROJECT — Blob storage for classroom captures
//
// Required because the schema stores URLs, not bytes:
//   SessionImage.storageUrl      (prisma/schema.prisma)
//   FaceEmbedding.sourceImageUrl
//
// Three properties below are the security requirement, not tuning:
//
//   allowBlobPublicAccess = false
//       A classroom photograph is a room full of identifiable minors. There is
//       no configuration in which anonymous read is acceptable, so the account
//       refuses it rather than relying on every future container being created
//       correctly.
//
//   allowSharedKeyAccess = false
//       Forces managed-identity access. An account key is a bearer credential
//       for every blob, cannot be scoped, and would have to live somewhere.
//
//   a lifecycle rule that DELETES captures after `captureRetentionDays`
//       docs/SECURITY.md: classroom images are not stored permanently. A
//       retention policy that depends on application code remembering to
//       delete is a policy that eventually stops being true; this one is
//       enforced by the platform.

@description('Azure region.')
param location string

@description('Storage account name — globally unique, lowercase alphanumeric, 3-24 chars.')
param storageAccountName string

@description('Days before a classroom capture blob is deleted by the platform.')
@minValue(1)
@maxValue(365)
param captureRetentionDays int = 30

param tags object

var captureContainerName = 'classroom-captures'

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: 7
    }
  }
}

resource captureContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: captureContainerName
  properties: {
    publicAccess: 'None'
  }
}

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'expire-classroom-captures'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
              prefixMatch: [
                captureContainerName
              ]
            }
            actions: {
              baseBlob: {
                delete: {
                  daysAfterCreationGreaterThan: captureRetentionDays
                }
              }
            }
          }
        }
      ]
    }
  }
}

output storageAccountId string = storage.id
output storageAccountName string = storage.name
output captureContainerName string = captureContainerName
output blobEndpoint string = storage.properties.primaryEndpoints.blob
