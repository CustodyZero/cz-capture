// main.bicep — Declarative IaC for cz-capture (Azure Functions waitlist endpoint)
// Replaces: infra/setup.md (manual runbook)
//
// Linux Consumption Plan retirement notice:
//   Microsoft has announced Linux consumption plan (Y1/Dynamic) retirement on 30 September 2028.
//   No new language runtimes will be added after 30 September 2025, but Node.js 20 is in the
//   supported set. When the retirement date approaches, migrate hostingPlan to Flex Consumption:
//   change sku.name to 'FC1', sku.tier to 'FlexConsumption', and functionApp kind to
//   'functionapp,linux' with the new functionAppConfig block. The app settings structure stays the same.

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

// Linux Consumption plan. sku Y1/Dynamic = consumption pricing.
// reserved: true is required for Linux — without it the plan is provisioned as Windows.
resource hostingPlan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: hostingPlanName
  location: location
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
}

resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  kind: 'functionapp,linux'
  properties: {
    serverFarmId: hostingPlan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|20'
      // WEBSITE_CONTENTAZUREFILECONNECTIONSTRING and WEBSITE_CONTENTSHARE are intentionally
      // excluded. Microsoft documentation confirms these are NOT required for Linux consumption
      // plans and can cause deployment failures if set.
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
