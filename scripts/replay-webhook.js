/**
 * Webhook Replay Tool for MediStock Production Verification
 *
 * Reads Razorpay webhook payload JSON, computes HMAC-SHA256 signature using
 * RAZORPAY_WEBHOOK_SECRET, and dispatches to /api/billing/webhook.
 *
 * Usage:
 *   node scripts/replay-webhook.js [path-to-payload.json] [event-id]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 1. Load .env if present
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
if (!SECRET) {
  console.error('❌ ERROR: RAZORPAY_WEBHOOK_SECRET is not set in environment or .env');
  console.error('Set it via PowerShell: $env:RAZORPAY_WEBHOOK_SECRET="your_secret_here"');
  process.exit(1);
}

const TARGET_URL = process.env.API_URL || 'https://medistock-api.vercel.app/api/billing/webhook';

// 2. Read payload JSON
let payloadRaw = null;
const argFile = process.argv[2];
const defaultFile = path.resolve(__dirname, 'webhook-payload.json');

if (argFile && fs.existsSync(argFile)) {
  payloadRaw = fs.readFileSync(argFile, 'utf8');
  console.log(`📄 Loaded payload from: ${argFile}`);
} else if (fs.existsSync(defaultFile)) {
  payloadRaw = fs.readFileSync(defaultFile, 'utf8');
  console.log(`📄 Loaded payload from: ${defaultFile}`);
} else if (process.env.PAYLOAD_JSON) {
  payloadRaw = process.env.PAYLOAD_JSON;
  console.log('📄 Loaded payload from PAYLOAD_JSON environment variable');
} else {
  console.error('❌ ERROR: No payload file found.');
  console.error('Please either:');
  console.error('  1. Save Razorpay request JSON to scripts/webhook-payload.json, OR');
  console.error('  2. Pass file path: node scripts/replay-webhook.js [path-to-payload.json], OR');
  console.error('  3. Set $env:PAYLOAD_JSON=\'{"event": ...}\'');
  process.exit(1);
}

let parsedPayload;
try {
  parsedPayload = JSON.parse(payloadRaw);
} catch (e) {
  console.error('❌ ERROR: Payload is not valid JSON:', e.message);
  process.exit(1);
}

// 3. Determine Event ID
const eventId = process.argv[3] ||
  process.env.EVENT_ID ||
  parsedPayload.id ||
  parsedPayload.event_id ||
  'TbA3U9IGViHQfM';

// 4. Compute HMAC-SHA256 signature
const rawBuffer = Buffer.from(payloadRaw, 'utf8');
const signature = crypto.createHmac('sha256', SECRET).update(rawBuffer).digest('hex');

const paymentEntity = parsedPayload.payload?.payment?.entity || {};
const payId = paymentEntity.id || 'N/A';
const amount = paymentEntity.amount ? `${paymentEntity.amount / 100} INR (${paymentEntity.amount} paise)` : 'N/A';
const maskedSecret = SECRET.slice(0, 3) + '****' + SECRET.slice(-3);

console.log('\n=== Webhook Replay Details ===');
console.log(`Target URL : ${TARGET_URL}`);
console.log(`Event ID   : ${eventId}`);
console.log(`Event Type : ${parsedPayload.event || 'unknown'}`);
console.log(`Payment ID : ${payId}`);
console.log(`Amount     : ${amount}`);
console.log(`Secret     : ${maskedSecret}`);
console.log(`Signature  : ${signature.slice(0, 6)}...${signature.slice(-6)}`);
console.log('==============================\n');

// 5. POST to target endpoint
(async () => {
  try {
    console.log(`🚀 Dispatching replay POST to ${TARGET_URL}...`);
    const startTime = Date.now();
    const res = await fetch(TARGET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-razorpay-signature': signature,
        'x-razorpay-event-id': eventId,
      },
      body: rawBuffer,
    });
    const elapsed = Date.now() - startTime;
    const bodyText = await res.text();
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch {
      json = bodyText;
    }

    console.log(`\nHTTP Status: ${res.status} (${elapsed}ms)`);
    console.log('Response Body:', typeof json === 'object' ? JSON.stringify(json, null, 2) : json);

    if (res.status === 200 && json && json.ok) {
      console.log('\n✅ Webhook processed successfully by server!');
    } else {
      console.error(`\n❌ Server returned non-success response: status ${res.status}`);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('❌ Request failed:', err);
    process.exitCode = 1;
  }
})();
