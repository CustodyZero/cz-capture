#!/usr/bin/env bash
# deploy.sh — Deploy cz-capture via AWS SAM (infrastructure + function code)
#
# SAM deploys the full CloudFormation stack: DynamoDB table, Lambda function,
# IAM execution role, and Function URL. It will show a changeset before applying.
#
# Prerequisites:
#   - AWS CLI installed: aws --version
#   - SAM CLI installed: sam --version
#   - AWS credentials configured: aws sts get-caller-identity
#
# Usage:
#   bash infra/deploy.sh
#   # or via npm:
#   npm run infra:deploy

set -euo pipefail

# Ensure this script is run from the project root (where package.json lives),
# so that CodeUri and handler paths in the template resolve correctly.
if [[ ! -f "package.json" ]]; then
  echo "Error: run this script from the project root (directory containing package.json)." >&2
  exit 1
fi

echo "==> Validating SAM template..."
sam validate --template infra/template.yaml --lint

echo ""
echo "==> Deploying (SAM will show the changeset for confirmation)..."
sam deploy \
  --template-file infra/template.yaml \
  --stack-name cz-capture \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides "AllowedOrigins=https://custodyzero.com,https://www.custodyzero.com,https://archon.custodyzero.com,https://www.archon.custodyzero.com" \
  --confirm-changeset
