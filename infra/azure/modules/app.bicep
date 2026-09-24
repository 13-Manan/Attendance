// ATTENDANCE PROJECT — Container Apps environment + the two services
//
// ---------------------------------------------------------------------------
// The shape that matters
// ---------------------------------------------------------------------------
// attendance-prod-web       external ingress   -> reachable from the internet
// attendance-prod-face-ai   INTERNAL ingress   -> reachable only from inside
//                                                 the environment
//
// That second line is the whole point. services/face-ai turns a photograph
// into a 512-float biometric template via POST /v1/enroll; app/config.py calls
// an unauthenticated one "an oracle that converts anybody's face into the exact
// value stored against a student". It is defended twice, deliberately:
//   1. `external: false` — no public FQDN exists.
//   2. FACE_AI_REQUIRE_AUTH=true — the process refuses to start without a
//      shared token, because (config.py again) "a deployment that turns out to
//      be wrong about its own network fails open".
// Neither is a substitute for the other.
//
// ---------------------------------------------------------------------------
// Two-pass deployment
// ---------------------------------------------------------------------------
// A container app's system-assigned identity does not exist until the app does,
// so it cannot hold AcrPull or Key Vault Secrets User on the first pass. Hence
// `enableKeyVaultSecretRefs`:
//   pass 1 (false) — apps come up on a public placeholder image, identities are
//                    created, main.bicep assigns the roles
//   pass 2 (true)  — same template, now resolving secrets from Key Vault and
//                    pulling real images from ACR
// Attempting both in one pass fails at secret resolution, not at role
// assignment, which makes it look like a Key Vault problem.

@description('Azure region.')
param location string

@description('Resource name prefix, e.g. attendance-prod.')
param namePrefix string

@description('Subnet delegated to Microsoft.App/environments.')
param infrastructureSubnetId string

@description('Log Analytics workspace resource id.')
param logAnalyticsWorkspaceId string

@description('Log Analytics workspace customer (workspace) id.')
param logAnalyticsCustomerId string

@description('Application Insights connection string.')
param appInsightsConnectionString string

@description('Key Vault URI used for secret references on pass 2.')
param keyVaultUri string

@description('ACR login server, e.g. attendanceprodacr.azurecr.io.')
param acrLoginServer string

@description('Web image. Placeholder until Phase G pushes a real one.')
param webImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Face AI image. Placeholder until Phase G pushes a real one.')
param faceAiImage string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Pass 2 switch — see header. Requires roles to be assigned first.')
param enableKeyVaultSecretRefs bool = false

@description('''Face AI model backend. "mock" has no weights; "onnx" is a
scaffold with no licence-cleared weights (ADR-0006); "azure" is Azure AI Face
identification (docs/AZURE_FACE.md); "azure_detection_own_recognition" uses
Azure only to detect faces and recognises in-process with dlib
(services/face-ai/docs/RECOGNITION.md). The last two need the Azure Face key
from Key Vault — pass 2 only.''')
@allowed([
  'mock'
  'onnx'
  'azure'
  'azure_detection_own_recognition'
])
param faceModelBackend string = 'mock'

@description('''Azure AI Face endpoint, used when faceModelBackend is "azure". Set
on face-ai only — never on the web app. Not a secret; the key is.''')
param azureFaceEndpoint string = ''

@description('''Refuse to start on a backend whose weights are not cleared for
commercial use. MUST stay false while faceModelBackend is "mock" or "onnx", or
the service will not boot — which is the point: it is what stops an unlicensed
model reaching production by accident.''')
param faceAiRequireProductionModel bool = false

param tags object

var environmentName = '${namePrefix}-cae'
var webAppName = '${namePrefix}-web'
var faceAiAppName = '${namePrefix}-face-ai'

// Key Vault-backed secrets, attached only on pass 2.
var webSecrets = enableKeyVaultSecretRefs ? [
  {
    name: 'database-url'
    keyVaultUrl: '${keyVaultUri}secrets/DATABASE-URL'
    identity: 'system'
  }
  {
    name: 'auth-secret'
    keyVaultUrl: '${keyVaultUri}secrets/AUTH-SECRET'
    identity: 'system'
  }
  {
    name: 'api-key-pepper'
    keyVaultUrl: '${keyVaultUri}secrets/API-KEY-PEPPER'
    identity: 'system'
  }
  {
    name: 'face-ai-service-token'
    keyVaultUrl: '${keyVaultUri}secrets/FACE-AI-SERVICE-TOKEN'
    identity: 'system'
  }
] : []

// Both Azure-backed backends need the endpoint and the key: one calls Detect
// and Identify, the other calls Detect and recognises in-process. Neither can
// start without them, so the secret reference is attached for both.
var useAzureFace = enableKeyVaultSecretRefs && (faceModelBackend == 'azure' || faceModelBackend == 'azure_detection_own_recognition')

var faceAiSecrets = concat(enableKeyVaultSecretRefs ? [
  {
    name: 'face-ai-auth-token'
    keyVaultUrl: '${keyVaultUri}secrets/FACE-AI-SERVICE-TOKEN'
    identity: 'system'
  }
] : [], useAzureFace ? [
  {
    name: 'azure-face-key'
    keyVaultUrl: '${keyVaultUri}secrets/AZURE-FACE-KEY'
    identity: 'system'
  }
] : [])

var webSecretEnv = enableKeyVaultSecretRefs ? [
  {
    name: 'DATABASE_URL'
    secretRef: 'database-url'
  }
  {
    name: 'AUTH_SECRET'
    secretRef: 'auth-secret'
  }
  {
    name: 'API_KEY_PEPPER'
    secretRef: 'api-key-pepper'
  }
  {
    name: 'FACE_AI_SERVICE_TOKEN'
    secretRef: 'face-ai-service-token'
  }
] : []

var faceAiSecretEnv = concat(enableKeyVaultSecretRefs ? [
  {
    name: 'FACE_AI_AUTH_TOKEN'
    secretRef: 'face-ai-auth-token'
  }
] : [], useAzureFace ? [
  {
    name: 'AZURE_FACE_ENDPOINT'
    value: azureFaceEndpoint
  }
  {
    name: 'AZURE_FACE_KEY'
    secretRef: 'azure-face-key'
  }
] : [])

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    // false = the environment gets a public load balancer, so the web app can
    // have external ingress. Individual apps still choose their own exposure,
    // and face-ai chooses none.
    vnetConfiguration: {
      infrastructureSubnetId: infrastructureSubnetId
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logAnalyticsCustomerId
        sharedKey: listKeys(logAnalyticsWorkspaceId, '2023-09-01').primarySharedKey
      }
    }
  }
}

resource faceAiApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: faceAiAppName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        // No public FQDN. This is the biometric boundary.
        external: false
        targetPort: 8000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: faceAiSecrets
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
          name: 'face-ai'
          image: faceAiImage
          resources: {
            // ONNX inference is CPU-bound; 1 vCPU / 2 GiB is the smallest
            // valid pairing that leaves room for a loaded model.
            cpu: json('1.0')
            memory: '2.0Gi'
          }
          env: concat([
            {
              name: 'FACE_MODEL_BACKEND'
              value: faceModelBackend
            }
            {
              name: 'FACE_AI_REQUIRE_AUTH'
              value: enableKeyVaultSecretRefs ? 'true' : 'false'
            }
            {
              name: 'FACE_AI_REQUIRE_PRODUCTION_MODEL'
              value: string(faceAiRequireProductionModel)
            }
          ], faceAiSecretEnv)
        }
      ]
      scale: {
        // Not zero: a cold start pays for loading the model, and the traffic
        // pattern is a rush at every period boundary.
        minReplicas: 1
        maxReplicas: 3
      }
    }
  }
}

resource webApp 'Microsoft.App/containerApps@2024-03-01' = {
  name: webAppName
  location: location
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      secrets: webSecrets
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
          name: 'web'
          image: webImage
          resources: {
            cpu: json('0.5')
            memory: '1.0Gi'
          }
          env: concat([
            {
              name: 'NODE_ENV'
              value: 'production'
            }
            {
              // Internal FQDN — resolvable only inside the environment.
              name: 'FACE_AI_SERVICE_URL'
              value: 'https://${faceAiApp.properties.configuration.ingress.fqdn}'
            }
            {
              // A cloud deployment is not an on-premises inference node, and
              // .env.example is explicit that claiming otherwise is "a lie told
              // to a teacher with no signal".
              name: 'LOCAL_AI_ENABLED'
              value: 'false'
            }
            {
              name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
              value: appInsightsConnectionString
            }
          ], webSecretEnv)
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 5
      }
    }
  }
}

output environmentId string = environment.id
output webAppName string = webApp.name
output webAppFqdn string = webApp.properties.configuration.ingress.fqdn
output webPrincipalId string = webApp.identity.principalId
output faceAiAppName string = faceAiApp.name
output faceAiInternalFqdn string = faceAiApp.properties.configuration.ingress.fqdn
output faceAiPrincipalId string = faceAiApp.identity.principalId
