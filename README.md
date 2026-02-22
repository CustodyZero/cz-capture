# cz-capture

**Private — not open source.**

Azure Functions app that receives email signups from CustodyZero landing pages, validates them, deduplicates, and stores them in Azure Table Storage. No third-party email services. No marketing platforms. Data stays in our Azure account.

---

## What this is

An HTTP endpoint at `/api/waitlist` that accepts a POST with an email address, validates it, checks for duplicates, and stores the result. That's it. Simple by design.

The `source` field makes this reusable across CustodyZero products — the same function can accept signups from custodyzero.com, Sentinel, Archon, or any other product by passing a different source identifier. See [Source field pattern](#source-field-pattern) below.

---

## Local development

### Prerequisites

- Node.js 20+
- Azure Functions Core Tools v4: `npm install -g azure-functions-core-tools@4 --unsafe-perm true`
- Either [Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite) (local Azure Storage emulator) or a real Azure Storage account

### Setup

```bash
# Install dependencies
npm install

# Copy the example settings file and fill in real values
cp local.settings.json.example local.settings.json
# Edit local.settings.json — see Environment variables below

# Start the function
npm start
```

The function will be available at `http://localhost:7071/api/waitlist`.

### Test locally

```bash
curl -s -X POST http://localhost:7071/api/waitlist \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{"email":"test@example.com"}' | jq .
```

Expected response: `{"ok":true}`

---

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AZURE_STORAGE_CONNECTION_STRING` | Yes | Connection string for the Azure Storage account that holds the `waitlist` table |
| `ALLOWED_ORIGINS` | Yes | Comma-separated list of allowed CORS origins, e.g. `https://custodyzero.com,https://www.custodyzero.com` |
| `NODE_ENV` | Yes | Set to `development` locally (enables localhost CORS, no-origin requests). Set to `production` in Azure. **Never set `development` in Azure.** |

All variables are documented with placeholder values in `local.settings.json.example`.

---

## Deploying to Azure

Infrastructure is managed as code using Bicep (`infra/main.bicep`). There is no manual runbook.

### Prerequisites

- Azure CLI installed: `az --version`
- Logged in: `az login`
- Correct subscription selected: `az account show`

### First-time and subsequent deployments

```bash
# From the project root:
npm run infra:deploy
```

This will:
1. Ensure the resource group exists (idempotent)
2. Run a **what-if preview** showing exactly what will change
3. Prompt for confirmation before applying anything

All Azure resources — storage account, waitlist table, hosting plan, and function app with all settings — are declared in `infra/main.bicep`. The `allowedOrigins` and other non-secret parameters are in `infra/main.bicepparam`. The storage connection string is computed inside the template from `listKeys()` and is never stored in the params file or committed anywhere.

### Deploy function code

After infrastructure exists:

```bash
npm run deploy
```

This publishes to the `cz-capture-func` Function App in Azure.

### Linux Consumption Plan retirement

Microsoft has announced Linux consumption plan retirement on **30 September 2028**. No new language runtimes will be added after 30 September 2025, but Node.js 20 is in the supported set. When the time comes, migrate to Flex Consumption — the `main.bicep` file has a comment describing the required changes.

---

## API reference

### `POST /api/waitlist`

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

## Table storage schema

Table name: `waitlist`

| Property | Type | Description |
|---|---|---|
| `PartitionKey` | String | First character of the normalized email (for distribution across partitions) |
| `RowKey` | String | Normalized email with `@` → `_AT_` and `.` → `_DOT_` |
| `email` | String | Normalized email address |
| `source` | String | Which product or form submitted the signup |
| `timestamp` | String | ISO 8601 UTC timestamp of the signup |
| `ipHash` | String | SHA-256 hash of the client IP. Raw IP is never stored. |

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
az storage entity query \
  --table-name waitlist \
  --account-name czcapturestorage \
  --output table
```

### Export as JSON

```bash
az storage entity query \
  --table-name waitlist \
  --account-name czcapturestorage \
  --output json | jq '.[]'
```

### Filter by source

```bash
az storage entity query \
  --table-name waitlist \
  --account-name czcapturestorage \
  --filter "source eq 'custodyzero.com'" \
  --output json | jq '[.[] | .email]'
```

### Export just email addresses

```bash
az storage entity query \
  --table-name waitlist \
  --account-name czcapturestorage \
  --output json | jq -r '.[].email'
```
