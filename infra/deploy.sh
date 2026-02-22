#!/usr/bin/env bash
# deploy.sh — Deploy or update cz-capture infrastructure using Bicep
#
# This script is idempotent. Re-running it is safe — it will show a what-if diff
# of any changes and prompt before applying them.
#
# Prerequisites:
#   - Azure CLI installed: az --version
#   - Logged in: az login
#   - Correct subscription selected: az account show
#
# Usage:
#   bash infra/deploy.sh
#   # or via npm:
#   npm run infra:deploy

set -euo pipefail

RESOURCE_GROUP="cz-capture-rg"
LOCATION="eastus2"
TEMPLATE="infra/main.bicep"
PARAMS="infra/main.bicepparam"

# Ensure this script is run from the project root (where package.json lives),
# so that the template and params paths resolve correctly.
if [[ ! -f "package.json" ]]; then
  echo "Error: run this script from the project root (directory containing package.json)." >&2
  exit 1
fi

echo "==> Ensuring resource group exists: $RESOURCE_GROUP"
az group create \
  --name "$RESOURCE_GROUP" \
  --location "$LOCATION" \
  --output none

echo ""
echo "==> What-if preview (no changes applied yet):"
az deployment group what-if \
  --resource-group "$RESOURCE_GROUP" \
  --template-file "$TEMPLATE" \
  --parameters "@$PARAMS"

echo ""
read -r -p "Apply the above changes? [y/N] " confirm

if [[ "$confirm" =~ ^[Yy]$ ]]; then
  echo ""
  echo "==> Deploying..."
  az deployment group create \
    --resource-group "$RESOURCE_GROUP" \
    --template-file "$TEMPLATE" \
    --parameters "@$PARAMS" \
    --output table
  echo ""
  echo "==> Infrastructure deployed. Deploy function code with: npm run deploy"
else
  echo "Aborted — no changes applied."
fi
