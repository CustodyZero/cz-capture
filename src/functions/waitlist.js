'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');

// Validates the structure of an email address.
// Checks: valid local part characters, @ separator, domain with hyphens allowed,
// at least one dot in domain, reasonable TLD. Not full RFC 5321 but covers
// the vast majority of real-world addresses and rejects obvious garbage.
const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const MAX_EMAIL_LENGTH = 254; // RFC 5321 hard limit

// Parse ALLOWED_ORIGINS from env at module load time.
// Format: comma-separated list of origins, e.g. "https://custodyzero.com,https://www.custodyzero.com"
function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  return new Set(raw.split(',').map((o) => o.trim()).filter(Boolean));
}

const ALLOWED_ORIGINS = parseAllowedOrigins();

// Initialize DynamoDB client at module load time — reused across warm invocations.
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Returns true if the given origin is permitted to call this API.
// In development (NODE_ENV=development), requests with no origin or from any
// localhost port are also accepted for local tooling convenience.
function isOriginAllowed(origin) {
  const isDevelopment = process.env.NODE_ENV === 'development';

  if (!origin) {
    // No Origin header: not a CORS request. Allow in development for curl/tools,
    // block in production — all production callers are browsers with a known origin.
    return isDevelopment;
  }

  if (ALLOWED_ORIGINS.has(origin)) return true;

  if (isDevelopment && /^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;

  return false;
}

// SHA-256 hex of the client IP. We never store the raw IP.
function hashIp(ip) {
  return crypto.createHash('sha256').update(ip || 'unknown').digest('hex');
}

// Lambda Function URL sets all header names to lowercase.
function getHeader(headers, name) {
  return headers[name.toLowerCase()] || '';
}

exports.handler = async (event) => {
  const method = event.requestContext.http.method;
  const headers = event.headers || {};
  const origin = getHeader(headers, 'origin');

  // Handle CORS preflight before any other logic.
  if (method === 'OPTIONS') {
    if (!isOriginAllowed(origin)) {
      return { statusCode: 403 };
    }
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    };
  }

  // Enforce POST-only. Other verbs are not part of this API's contract.
  if (method !== 'POST') {
    return {
      statusCode: 405,
      headers: { Allow: 'POST' },
    };
  }

  // CORS origin check for POST requests.
  if (!isOriginAllowed(origin)) {
    console.warn(`Rejected request from unauthorized origin: "${origin}"`);
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: false, error: 'Forbidden' }),
    };
  }

  // All successful responses include CORS headers scoped to the requesting origin.
  const corsHeaders = {
    'Content-Type': 'application/json',
    ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
  };

  // Parse JSON body. Lambda Function URLs may base64-encode the body.
  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64').toString('utf8')
      : event.body;
    body = JSON.parse(raw);
  } catch {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: 'Request body must be valid JSON' }),
    };
  }

  // Honeypot: if the hidden field is populated this is almost certainly a bot.
  // Return 200 silently — do not store, do not signal rejection.
  if (body.honeypot) {
    console.info('Honeypot field populated — silently discarding request');
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ok: true }),
    };
  }

  // Validate email presence and type.
  if (!body.email || typeof body.email !== 'string') {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: 'Email is required' }),
    };
  }

  const email = body.email.trim().toLowerCase();

  if (email.length > MAX_EMAIL_LENGTH) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: 'Please enter a valid email address' }),
    };
  }

  if (!EMAIL_REGEX.test(email)) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: 'Please enter a valid email address' }),
    };
  }

  // Default source to custodyzero.com. Allows reuse of this function for
  // other CustodyZero products (Sentinel, Archon, etc.) by passing a different source.
  const source =
    body.source && typeof body.source === 'string' ? body.source.trim() : 'custodyzero.com';

  const ipHash = hashIp(event.requestContext.http.sourceIp);

  const tableName = process.env.WAITLIST_TABLE;
  if (!tableName) {
    console.error('WAITLIST_TABLE environment variable is not configured');
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: 'Something went wrong' }),
    };
  }

  // Atomic deduplication: PutItem with ConditionExpression fails if the email already
  // exists. This is a single round-trip vs the get-then-put approach — no race condition.
  // ConditionalCheckFailedException = duplicate; return 200 silently (same as before).
  try {
    await ddb.send(new PutCommand({
      TableName: tableName,
      Item: {
        email,
        source,
        timestamp: new Date().toISOString(),
        ipHash,
      },
      ConditionExpression: 'attribute_not_exists(email)',
    }));

    console.info(`Waitlist signup stored — source: ${source}`);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.info('Duplicate signup — returning silent success');
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true }),
      };
    }

    console.error('Error storing signup:', err.message);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: 'Something went wrong' }),
    };
  }
};
