// ATTENDANCE PROJECT — Azure Container Registry
//
// Holds two images: the Next.js app and the FastAPI Face AI service.
//
// Basic SKU is deliberate. Premium buys geo-replication, private endpoints and
// content trust; none of those are needed for two images pulled by one
// Container Apps environment in one region. Revisit if the registry ever needs
// a private endpoint.
//
// adminUserEnabled is false: pulls are authorised by the container apps'
// managed identities via AcrPull, so there is no registry password to store,
// rotate, or leak into a pipeline log.

@description('Azure region.')
param location string

@description('Registry name — globally unique, alphanumeric only, 5-50 chars.')
param registryName string

param tags object

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

output registryId string = registry.id
output registryName string = registry.name
output loginServer string = registry.properties.loginServer
