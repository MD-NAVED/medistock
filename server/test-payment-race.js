/**
 * Task 2 Concurrency & Deduplication Test Suite
 * (a) Two parallel handlePaymentSuccess calls -> exactly ONE subscription extension + ONE referral credit
 * (b) Same webhook payload replayed 5x -> processed once with deduplication
 */
const crypto = require('crypto');
const http = require('http');
const { pool, transaction } = require('./db');

const PORT = process.env.PORT || 3111;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function check(label, pass, extra = '') {
  if (pass) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${extra ? ' -> ' + extra : ''}`);
    process.exitCode = 1;
  }
}

async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  console.log('\n=== Task 2: Payment Race Condition & Webhook Deduplication Tests ===');

  // Ensure schema is fully bootstrapped on server
  await call('/api/billing/plans');

  // Setup: Create a referrer tenant and a referred tenant
  const refStore = (await pool.query(
    `INSERT INTO tenants (store_name, owner_name, phone, plan, status, tier, referral_code, price_per_month)
     VALUES ('Race Referrer Store', 'Ref Owner', '9999988888', 'yearly', 'active', 'elite', 'RACEREF100', 999.00)
     RETURNING id`
  )).rows[0];

  const subStore = (await pool.query(
    `INSERT INTO tenants (store_name, owner_name, phone, plan, status, tier, referred_by_tenant_id, referral_code, price_per_month, subscription_ends_at)
     VALUES ('Race Subscribed Store', 'Sub Owner', '9999977777', 'trial', 'trial', 'starter', $1, 'RACESUB100', 0, now() + interval '5 days')
     RETURNING id`,
    [refStore.id]
  )).rows[0];

  const subEndsBefore = (await pool.query('SELECT subscription_ends_at FROM tenants WHERE id = $1', [subStore.id])).rows[0].subscription_ends_at;

  // Insert a test tenant_payment row
  const orderId = 'order_race_test_' + Date.now();
  const paymentId = 'pay_race_test_' + Date.now();
  const paymentRow = (await pool.query(
    `INSERT INTO tenant_payments (tenant_id, plan, months, amount, razorpay_order_id, status)
     VALUES ($1, 'pro-yearly', 12, 499900, $2, 'created')
     RETURNING id`,
    [subStore.id, orderId]
  )).rows[0];

  check('test payment row created', !!paymentRow?.id);

  // 1. Race Test: Simulate two parallel handlePaymentSuccess invocations (Verify & Webhook racing)
  // Call server internal endpoint or simulate parallel verify requests
  // In server/index.js, /api/billing/verify is exposed
  const keySecret = process.env.RAZORPAY_KEY_SECRET || 'test_key_secret_for_local_harness_32ch';
  const signature = crypto.createHmac('sha256', keySecret)
    .update(orderId + '|' + paymentId)
    .digest('hex');

  // Log in as an owner to call /api/billing/verify
  const userRow = (await pool.query(
    `INSERT INTO users (username, password_hash, salt, name, role, algo, store_id)
     VALUES ($1, 'dummy', 'salt', 'Race Owner', 'owner', 'scrypt', $2)
     RETURNING id`,
    ['race_owner_' + Date.now(), subStore.id]
  )).rows[0];

  const token = 'race_token_' + crypto.randomBytes(16).toString('hex');
  await pool.query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval \'1 day\')',
    [token, userRow.id]
  );

  console.log('  Testing simultaneous parallel payment confirmations...');
  const [resA, resB] = await Promise.all([
    call('/api/billing/verify', {
      method: 'POST',
      token,
      headers: { Authorization: 'Bearer ' + token },
      body: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature },
    }),
    call('/api/billing/verify', {
      method: 'POST',
      token,
      headers: { Authorization: 'Bearer ' + token },
      body: { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature },
    }),
  ]);

  check('both parallel verify calls return 200 OK', resA.status === 200 && resB.status === 200);

  // Verify DB state: exactly ONE referral transaction must exist
  const refTxs = (await pool.query(
    'SELECT * FROM referral_transactions WHERE tenant_id = $1 AND referred_tenant_id = $2',
    [refStore.id, subStore.id]
  )).rows;
  check('exactly ONE referral commission credited under concurrency', refTxs.length === 1, `found ${refTxs.length} txs`);

  // Verify wallet balance is credited exactly once (15% of 4999 = 750)
  const refTenant = (await pool.query('SELECT referral_wallet_balance::float8 AS bal FROM tenants WHERE id = $1', [refStore.id])).rows[0];
  check('referrer wallet credited exactly once (750)', Math.abs(refTenant.bal - 750) < 0.01, `balance=${refTenant.bal}`);

  // Verify tenant subscription extended by 12 months (not 24 months)
  const subTenant = (await pool.query('SELECT status, tier, plan, subscription_ends_at FROM tenants WHERE id = $1', [subStore.id])).rows[0];
  check('tenant status is active and tier upgraded to pro', subTenant.status === 'active' && subTenant.tier === 'pro');

  const monthsDiff = (new Date(subTenant.subscription_ends_at) - new Date()) / (30 * 86400000);
  check('subscription extended by ~12 months (single credit)', monthsDiff >= 11.5 && monthsDiff <= 13.0, `monthsDiff=${monthsDiff}`);

  // 2. Webhook Event Deduplication Test: Replay same webhook payload 5x
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'test_webhook_secret_for_local_harness_32ch';
  const eventId = 'evt_test_dedupe_' + Date.now();
  const webhookBody = JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: 'pay_webhook_test_' + Date.now(),
          order_id: orderId,
          method: 'upi',
        },
      },
    },
  });
  const webhookSig = crypto.createHmac('sha256', webhookSecret).update(Buffer.from(webhookBody)).digest('hex');

  console.log('  Testing webhook replay 5x with same x-razorpay-event-id...');
  const webhookResponses = [];
  for (let i = 0; i < 5; i++) {
    const r = await call('/api/billing/webhook', {
      method: 'POST',
      body: webhookBody,
      headers: {
        'x-razorpay-signature': webhookSig,
        'x-razorpay-event-id': eventId,
      },
    });
    webhookResponses.push(r);
  }

  check('all 5 webhook replay requests return 200 OK', webhookResponses.every(r => r.status === 200));
  const dedupedCount = webhookResponses.filter(r => r.data?.deduplicated === true).length;
  check('subsequent 4 webhook replayed requests were marked deduplicated', dedupedCount === 4, `dedupedCount=${dedupedCount}`);

  const eventRows = (await pool.query('SELECT * FROM webhook_events WHERE event_id = $1', [eventId])).rows;
  check('webhook_events table contains exactly ONE entry for event_id', eventRows.length === 1);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  await pool.end();
  if (failed > 0 || process.exitCode) {
    process.exit(1);
  }
})();
