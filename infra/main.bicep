// main.bicep — Declarative IaC for cz-capture (Azure Functions waitlist endpoint)
// Replaces: infra/setup.md (manual runbook)
//
// Hosting plan: Windows B1 Basic App Service Plan.
// Consumption (Y1/Dynamic) plans are blocked by a Dynamic VM quota of 0 on this subscription.
// B1 is always-on (~$13/month), no quota restrictions, no cold starts. At waitlist scale the
// cost difference vs consumption is negligible. Can switch back to consumption if quota is ever
// granted — two-line change in the hostingPlan sku block.

targetScope = 'resourceGroup'

// --- Parameters ---

@description('Azure region for all resources.')
param location string = 'eastus2'

@description('Storage account name. Must be globally unique, 3-24 lowercase alphanumeric characters.')
@minLength(3)
@maxLength(24)
param storageAccountName string = 'czcapturestorage'

@description('Function App name.')
param functionAppName string = 'cz-capture-func'

@description('Comma-separated list of allowed CORS origins. Example: https://custodyzero.com,https://www.custodyzero.com')
param allowedOrigins string

// --- Variables ---

var hostingPlanName = '${functionAppName}-plan'

// Connection string is computed from storage keys — never passed as a parameter or stored in the params file.
var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storageAccount.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storageAccount.listKeys().keys[0].value}'

// --- Resources ---

resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
  }
}

// tableServices/default must be declared before child tables can reference it as a parent.
resource tableService 'Microsoft.Storage/storageAccounts/tableServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
}

// Nested child: creates the waitlist table inside the storage account.
// This eliminates the post-deployment `az storage table create` step that was in setup.md.
resource waitlistTable 'Microsoft.Storage/storageAccounts/tableServices/tables@2023-05-01' = {
  parent: tableService
  name: 'waitlist'
}

// B1 Basic App Service Plan (Windows).
resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: hostingPlanName
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp'
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    siteConfig: {
      // use32BitWorkerProcess: false — Node.js 20 requires 64-bit on Windows.
      use32BitWorkerProcess: false
      appSettings: [
        {
          name: 'AzureWebJobsStorage'
          value: storageConnectionString
        }
        {
          name: 'FUNCTIONS_EXTENSION_VERSION'
          value: '~4'
        }
        {
          name: 'FUNCTIONS_WORKER_RUNTIME'
          value: 'node'
        }
        {
          name: 'WEBSITE_NODE_DEFAULT_VERSION'
          value: '~20'
        }
        {
          name: 'AZURE_STORAGE_CONNECTION_STRING'
          value: storageConnectionString
        }
        {
          name: 'ALLOWED_ORIGINS'
          value: allowedOrigins
        }
        {
          name: 'NODE_ENV'
          value: 'production'
        }
      ]
    }
  }
}

// --- Outputs ---

output functionAppHostname string = functionApp.properties.defaultHostName
output storageAccountName string = storageAccount.name
