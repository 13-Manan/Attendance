// ATTENDANCE PROJECT — networking
//
// A dedicated VNet. Nothing here is shared with, peered to, or derived from
// any other project's network.
//
// Two delegated subnets, because both platforms require sole ownership of the
// subnet they are injected into:
//   - Container Apps  -> Microsoft.App/environments
//   - PostgreSQL      -> Microsoft.DBforPostgreSQL/flexibleServers
//
// The private DNS zone is what makes the "no public endpoint" database
// reachable by name from inside the VNet. Without the zone link, the server's
// FQDN resolves to nothing from the Container Apps subnet and every Prisma
// connection fails at DNS rather than at auth — which is a confusing way to
// discover the zone is missing.

@description('Azure region. Central India — see infra/azure/README.md.')
param location string

@description('Resource name prefix, e.g. attendance-prod.')
param namePrefix string

@description('PostgreSQL server name; the private DNS zone is derived from it.')
param postgresServerName string

param tags object

var vnetName = '${namePrefix}-vnet'
var containerAppsSubnetName = 'snet-container-apps'
var postgresSubnetName = 'snet-postgres'

// A /23 for Container Apps: the workload-profiles environment requires at least
// a /27, but Azure recommends /23 so the environment can scale without a
// re-provision (the subnet cannot be resized after injection).
var containerAppsSubnetPrefix = '10.20.0.0/23'
var postgresSubnetPrefix = '10.20.2.0/24'

resource vnet 'Microsoft.Network/virtualNetworks@2023-11-01' = {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        '10.20.0.0/16'
      ]
    }
    subnets: [
      {
        name: containerAppsSubnetName
        properties: {
          addressPrefix: containerAppsSubnetPrefix
          delegations: [
            {
              name: 'container-apps-delegation'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: postgresSubnetName
        properties: {
          addressPrefix: postgresSubnetPrefix
          // Azure attaches this endpoint itself the first time a Flexible
          // Server is provisioned into the subnet: it is how the server ships
          // write-ahead log files to Azure Storage, and Microsoft documents
          // that removing it "may disrupt connectivity". Declaring it changes
          // nothing — it makes the template state what the platform already
          // created, so redeploying the VNet (whose inline subnets array is a
          // full PUT) cannot silently strip it back out.
          serviceEndpoints: [
            {
              service: 'Microsoft.Storage'
            }
          ]
          delegations: [
            {
              name: 'postgres-delegation'
              properties: {
                serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers'
              }
            }
          ]
        }
      }
    ]
  }
}

// Must end in .private.postgres.database.azure.com for a VNet-integrated
// flexible server.
resource postgresDnsZone 'Microsoft.Network/privateDnsZones@2020-06-01' = {
  name: '${postgresServerName}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2020-06-01' = {
  parent: postgresDnsZone
  name: '${vnetName}-link'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

output vnetId string = vnet.id
output containerAppsSubnetId string = '${vnet.id}/subnets/${containerAppsSubnetName}'
output postgresSubnetId string = '${vnet.id}/subnets/${postgresSubnetName}'
output postgresDnsZoneId string = postgresDnsZone.id
