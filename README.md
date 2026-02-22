<img src="custodyzero-wordmark-dark.svg" alt="CustodyZero" width="260" />

# cz-capture

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

AWS Lambda function that receives email signups from CustodyZero landing pages, validates them, deduplicates, and stores them in DynamoDB. No third-party email services. No marketing platforms. Data stays in our AWS account.

---

## What this is

An HTTP endpoint (Lambda Function URL) that accepts a POST with an email address, validates it, checks for duplicates atomically, and stores the result. That's it. Simple by design.

The `source` field makes this reusable across CustodyZero products — the same function can accept signups from custodyzero.com, Sentinel, Archon, or any other product by passing a different source identifier. See [Source field pattern](#source-field-pattern) below.

---

## Local development

Local development requires [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html) and Docker for `sam local start-api`. Alternatively, test directly against the deployed function URL.

### Setup

```bash
# Install dependencies
npm install

# Copy the example env file and fill in values
cp .env.example .env
# Edit .env — see Environment variables below
```

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `WAITLIST_TABLE` | Yes | DynamoDB table name (default: `cz-capture-waitlist`) |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed CORS origins |
| `NODE_ENV` | Yes | Set to `development` locally (enables localhost CORS, no-origin requests). Set to `production` in Lambda. **Never set `development` in production.** |

---

## Deploying to AWS

Infrastructure is managed as code using AWS SAM (`infra/template.yaml`). There is no manual runbook.

### Prerequisites

- AWS CLI installed: `aws --version`
- SAM CLI installed: `sam --version`
- AWS credentials configured: `aws sts get-caller-identity`

### First-time and subsequent deployments

```bash
# From the project root:
npm run infra:deploy
```

This will:
1. Validate the SAM template
2. Show a **changeset** of what will be created or changed
3. Prompt for confirmation before applying

All AWS resources — DynamoDB table, Lambda function, IAM execution role, and Function URL — are declared in `infra/template.yaml`. Parameters are in `infra/samconfig.toml`. No secrets are committed anywhere.

The DynamoDB table has `DeletionPolicy: Retain` — it will not be deleted if the CloudFormation stack is removed.

---

## API reference

### `POST {FUNCTION_URL}`

The Function URL is shown in the CloudFormation outputs after deploy, or in the AWS console under Lambda → Functions → cz-capture-func → Function URL.

**Request body (JSON):**

```json
{
  "email": "user@example.com",
  "source": "custodyzero.com",
  "honeypot": ""
}
```

| Field | Required | Description |
|---|---|---|
| `email` | Yes | Email address to register. Normalized to lowercase before storage and deduplication. |
| `source` | No | Identifies which form submitted the signup. Defaults to `custodyzero.com`. |
| `honeypot` | No | Bot trap. If this field is populated, the request is silently discarded. |

**Responses:**

| Status | Body | Meaning |
|---|---|---|
| 200 | `{"ok":true}` | Stored, or already registered (indistinguishable by design) |
| 400 | `{"ok":false,"error":"..."}` | Missing or invalid email |
| 403 | `{"ok":false,"error":"Forbidden"}` | Origin not in allowlist |
| 405 | — | Method not POST |
| 500 | `{"ok":false,"error":"Something went wrong"}` | Internal error (details logged, never exposed) |

---

## DynamoDB schema

Table name: `cz-capture-waitlist`

| Attribute | Type | Description |
|---|---|---|
| `email` | String | Partition key. Normalized email address (lowercase). |
| `source` | String | Which product or form submitted the signup |
| `timestamp` | String | ISO 8601 UTC timestamp of the signup |
| `ipHash` | String | SHA-256 hash of the client IP. Raw IP is never stored. |

Deduplication is enforced atomically: `PutItem` with `ConditionExpression: attribute_not_exists(email)` — a single round-trip with no race condition.

---

## Source field pattern

The `source` field allows this single function to serve multiple CustodyZero products. When building a signup form for a new product, pass a distinct source value:

| Product | Source value |
|---|---|
| CustodyZero main | `custodyzero.com` |
| Sentinel waitlist | `sentinel.custodyzero.com` |
| Archon waitlist | `archon.custodyzero.com` |

To query signups for a specific product, filter by `source` when exporting (see below).

---

## Exporting the waitlist

### Export all signups

```bash
aws dynamodb scan \
  --table-name cz-capture-waitlist \
  --output json
```

### Export just email addresses

```bash
aws dynamodb scan \
  --table-name cz-capture-waitlist \
  --output json | jq -r '.Items[].email.S'
```

### Filter by source

```bash
aws dynamodb scan \
  --table-name cz-capture-waitlist \
  --filter-expression "source = :s" \
  --expression-attribute-values '{":s":{"S":"custodyzero.com"}}' \
  --output json | jq -r '[.Items[].email.S]'
```

---

## License

The source code in this repository is licensed under [Apache 2.0](LICENSE).

CustodyZero brand assets — including all wordmarks, logomarks, and product
marks — are all rights reserved and explicitly excluded from this license.
See the [custodyzero/brand](https://github.com/custodyzero/brand) repository
for the brand usage policy.
