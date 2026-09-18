// ATTENDANCE PROJECT — observability
//
// One Log Analytics workspace and one Application Insights component. The
// Container Apps environment requires a workspace regardless, so this is not
// optional infrastructure that could be trimmed — it is the environment's
// log sink.
//
// Retention is 30 days. This system logs around biometric processing, and
// docs/SECURITY.md forbids face images, embeddings, tokens and credentials
// from reaching logs at all; a shorter retention is a second line of defence
// for anything that slips through, and keeps ingestion cost predictable.

@description('Azure region.')
param location string

@description('Resource name prefix, e.g. attendance-prod.')
param namePrefix string

param tags object

resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${namePrefix}-law'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${namePrefix}-appi'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logAnalytics.id
    // Keep telemetry ingestion on the private path where possible.
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

output logAnalyticsId string = logAnalytics.id
output logAnalyticsCustomerId string = logAnalytics.properties.customerId
output appInsightsConnectionString string = appInsights.properties.ConnectionString
output appInsightsName string = appInsights.name
