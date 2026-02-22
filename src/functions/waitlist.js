'use strict';

const { app } = require('@azure/functions');
const { TableClient } = require('@azure/data-tables');
const crypto = require('crypto');

// Validates the structure of an email address.
// Checks: valid local part characters, @ separator, domain with hyphens allowed,
// at least one dot in domain, reasonable TLD. Not full RFC 5321 but covers
// the vast majority of real-world addresses and rejects obvious garbage.
const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;

const TABLE_NAME = 'waitlist';
const MAX_EMAIL_LENGTH = 254; // RFC 5321 hard limit

// Parse ALLOWED_ORIGINS from env at module load time.
// Format: comma-separated list of origins, e.g. "https://custodyzero.com,https://www.custodyzero.com"
function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  return new Set(raw.split(',').map((o) => o.trim()).filter(Boolean));
}

const ALLOWED_ORIGINS = parseAllowedOrigins();

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

// Transforms a normalized email into a valid Azure Table Storage row key.
// PartitionKey/RowKey cannot contain /, \, #, ?. We also replace @ and . to
// keep the key readable and unambiguous.
function emailToRowKey(normalizedEmail) {
  return normalizedEmail.replace(/@/g, '_AT_').replace(/\./g, '_DOT_');
}

// SHA-256 hex of the client IP. We never store the raw IP.
function hashIp(ip) {
  return crypto.createHash('sha256').update(ip).digest('hex');
}

// Best-effort extraction of the real client IP from the request headers.
// Azure routes traffic through its infrastructure and sets x-forwarded-for.
function getClientIp(request) {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return 'unknown';
}

// Returns a function-scoped TableClient. Creating per-request is acceptable at
// this call volume and avoids shared state across invocations.
function getTableClient() {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (!connectionString) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING is not configured');
  }
  return TableClient.fromConnectionString(connectionString, TABLE_NAME);
}

app.http('waitlist', {
  // No methods restriction here — we handle method dispatch manually so that
  // we can return proper 405 for non-POST and handle OPTIONS preflight explicitly.
  authLevel: 'anonymous',
  route: 'waitlist',

  handler: async (request, context) => {
    const origin = request.headers.get('origin') || '';

    // Handle CORS preflight before any other logic.
    if (request.method === 'OPTIONS') {
      if (!isOriginAllowed(origin)) {
        return { status: 403 };
      }
      return {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
        },
      };
    }

    // Enforce POST-only. Other verbs are not part of this API's contract.
    if (request.method !== 'POST') {
      return {
        status: 405,
        headers: { Allow: 'POST' },
      };
    }

    // CORS origin check for POST requests.
    if (!isOriginAllowed(origin)) {
      context.log.warn(`Rejected request from unauthorized origin: "${origin}"`);
      return {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Forbidden' }),
      };
    }

    // All successful responses include CORS headers scoped to the requesting origin.
    const corsHeaders = {
      'Content-Type': 'application/json',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
    };

    // Parse JSON body. An unparseable body is a client error.
    let body;
    try {
      body = await request.json();
    } catch {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: 'Request body must be valid JSON' }),
      };
    }

    // Honeypot: if the hidden field is populated this is almost certainly a bot.
    // Return 200 silently — do not store, do not signal rejection.
    if (body.honeypot) {
      context.log.info('Honeypot field populated — silently discarding request');
      return {
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true }),
      };
    }

    // Validate email presence and type.
    if (!body.email || typeof body.email !== 'string') {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: 'Email is required' }),
      };
    }

    const email = body.email.trim().toLowerCase();

    if (email.length > MAX_EMAIL_LENGTH) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: 'Please enter a valid email address' }),
      };
    }

    if (!EMAIL_REGEX.test(email)) {
      return {
        status: 400,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: 'Please enter a valid email address' }),
      };
    }

    // Default source to custodyzero.com. Allows reuse of this function for
    // other CustodyZero products (Sentinel, Archon, etc.) by passing a different source.
    const source =
      body.source && typeof body.source === 'string' ? body.source.trim() : 'custodyzero.com';

    const ipHash = hashIp(getClientIp(request));
    const partitionKey = email[0];
    const rowKey = emailToRowKey(email);

    let client;
    try {
      client = getTableClient();
    } catch (err) {
      context.log.error('Storage configuration error:', err.message);
      return {
        status: 500,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: 'Something went wrong' }),
      };
    }

    // Deduplication: check whether this email is already in the table.
    // A 404 from getEntity means it does not exist — proceed to store.
    // Any other error is unexpected and surfaces as 500.
    // An existing entity returns 200 silently — we do not reveal whether
    // the email was already registered.
    try {
      await client.getEntity(partitionKey, rowKey);
      context.log.info('Duplicate signup — returning silent success');
      return {
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true }),
      };
    } catch (err) {
      if (err.statusCode !== 404) {
        context.log.error('Error checking table for existing entity:', err.message);
        return {
          status: 500,
          headers: corsHeaders,
          body: JSON.stringify({ ok: false, error: 'Something went wrong' }),
        };
      }
      // 404 = not found = new signup, fall through to store.
    }

    // Store the new signup.
    try {
      await client.createEntity({
        partitionKey,
        rowKey,
        email,
        source,
        timestamp: new Date().toISOString(),
        ipHash,
      });

      context.log.info(`Waitlist signup stored — source: ${source}`);

      return {
        status: 200,
        headers: corsHeaders,
        body: JSON.stringify({ ok: true }),
      };
    } catch (err) {
      context.log.error('Error storing entity:', err.message);
      return {
        status: 500,
        headers: corsHeaders,
        body: JSON.stringify({ ok: false, error: 'Something went wrong' }),
      };
    }
  },
});
