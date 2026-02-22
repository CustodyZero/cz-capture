// main.bicepparam — Parameter values for main.bicep (cz-capture infrastructure)
//
// This file is committed to version control. It contains no secrets.
// The storage connection string is computed inside main.bicep via listKeys() — it is not here.

using './main.bicep'

param location = 'eastus2'
param storageAccountName = 'czcapturestorage'
param functionAppName = 'cz-capture-func'
param allowedOrigins = 'https://custodyzero.com,https://www.custodyzero.com'
