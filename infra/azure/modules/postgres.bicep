// ATTENDANCE PROJECT — Azure Database for PostgreSQL Flexible Server
//
// This is the production counterpart of the local `attendance_dev` database.
// The two are never connected, never synchronised, and never share data;
// see infra/azure/README.md §"Local vs production".
//
// ---------------------------------------------------------------------------
// pgvector
// ---------------------------------------------------------------------------
// prisma/schema.prisma declares FaceEmbedding.embedding as
// Unsupported("vector(512)"), and migrations/20260917000000_init/migration.sql
// opens with CREATE EXTENSION vector. On Azure that CREATE fails unless the
// extension is first allow-listed on the SERVER, which is what the
// `azure.extensions` configuration below does. Without it the very first
// migration dies with `extension "vector" is not allow-listed`.
//
// Allow-listing is necessary but not sufficient — CREATE EXTENSION still has
// to run, and it runs as part of the existing baseline migration. Nothing here
// creates the extension; this only makes it creatable.
//
// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
// Private access (VNet injection). There is no public endpoint and no firewall
// rule, so the server is unreachable from the internet by construction rather
// than by allow-list. The cost of that choice is real: migrations cannot be run
// from a laptop. See README §"Running migrations against production".

@description('Azure region.')
param location string

@description('PostgreSQL server name — globally unique, lowercase, 3-63 chars.')
param serverName string

@description('Administrator login. Not a secret, but not a guessable default either.')
param administratorLogin string

@description('''Administrator password. Required only when the server is being
created. Leave it unset when redeploying an existing server: the property is
then omitted from the request entirely, so ARM has nothing to reset the live
password to and the running credential survives the deployment.''')
@secure()
param administratorPassword string = ''

@description('Delegated subnet for VNet injection.')
param delegatedSubnetId string

@description('Private DNS zone resource id for name resolution inside the VNet.')
param privateDnsZoneId string

@description('PostgreSQL major version.')
@allowed([
  '16'
  '17'
])
param postgresVersion string = '17'

// The ARM API wants the bare VM size here and takes the tier from `skuTier`.
// The `GP_` / `B_` / `MO_` prefixes belong to `az postgres flexible-server`,
// not to Microsoft.DBforPostgreSQL — passing one fails with ParameterOutOfRange
// and a 400-entry list of what it wanted instead.
@description('Compute SKU. Standard_D2s_v3 = 2 vCore / 8 GiB.')
param skuName string = 'Standard_D2s_v3'

@description('Compute tier.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param skuTier string = 'GeneralPurpose'

@description('Storage in MB. 65536 = 64 GiB.')
param storageSizeGB int = 64

@description('Days of automated backup retention (7-35).')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 14

@description('Geo-redundant backup to the paired region (South India).')
@allowed([
  'Enabled'
  'Disabled'
])
param geoRedundantBackup string = 'Enabled'

@description('High availability mode. Left Disabled by default — see README §HA.')
@allowed([
  'Disabled'
  'SameZone'
  'ZoneRedundant'
])
param highAvailabilityMode string = 'Disabled'

@description('Application database name.')
param databaseName string = 'attendance_prod'

param tags object

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: skuTier
  }
  properties: union({
    version: postgresVersion
    administratorLogin: administratorLogin
    storage: {
      storageSizeGB: storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup
    }
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
    }
    highAvailability: {
      mode: highAvailabilityMode
    }
    authConfig: {
      passwordAuth: 'Enabled'
      activeDirectoryAuth: 'Enabled'
      tenantId: subscription().tenantId
    }
  }, empty(administratorPassword) ? {} : {
    administratorLoginPassword: administratorPassword
  })
}

// Allow-list pgvector. Without this the baseline migration's CREATE EXTENSION
// vector is rejected. `azure.extensions` is a dynamic parameter — no restart.
resource vectorExtension 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: postgres
  name: 'azure.extensions'
  properties: {
    value: 'VECTOR'
    source: 'user-override'
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: postgres
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  // The server rejects concurrent control-plane writes; sequence them.
  dependsOn: [
    vectorExtension
  ]
}

output serverId string = postgres.id
output serverName string = postgres.name
output fullyQualifiedDomainName string = postgres.properties.fullyQualifiedDomainName
output databaseName string = databaseName
