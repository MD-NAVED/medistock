/**
 * Manual Reconciliation Script for Real ₹299 Starter Payment
 *
 * Reconciles pay_TbA3RvqKiPcqt3 (order_TbA1ojSUMYM4WY) captured on 2026-09-12.
 * Executes in a single atomic PostgreSQL transaction.
 */

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

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

const client = new Client({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  await client.connect();
  console.log('Connected to PostgreSQL for manual reconciliation.');

  try {
    await client.query('BEGIN');
    console.log('--- TRANSACTION STARTED ---');

    // 1. Insert reconciled payment row
    const insertRes = await client.query(`
      INSERT INTO tenant_payments (
        tenant_id,
        plan,
        months,
        amount,
        currency,
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        status,
        method,
        paid_at,
        created_at
      ) VALUES (
        11,
        'starter-monthly',
        1,
        29900,
        'INR',
        'order_TbA1ojSUMYM4WY',
        'pay_TbA3RvqKiPcqt3',
        'manual-reconciliation: payment-link flow paid before webhook dual-match fix was deployed',
        'paid',
        'upi',
        '2026-09-12 14:38:00+05:30',
        '2026-09-12 14:38:00+05:30'
      )
      RETURNING *;
    `);
    console.log('✅ [1] Inserted into tenant_payments:', JSON.stringify(insertRes.rows[0], null, 2));

    // 2. Update tenants row for Store 11
    const updateRes = await client.query(`
      UPDATE tenants
      SET
        plan = 'starter',
        tier = 'starter',
        status = 'active',
        price_per_month = 299.00,
        subscription_ends_at = NOW() + INTERVAL '30 days'
      WHERE id = 11
      RETURNING id, store_name, plan, tier, status, price_per_month, subscription_ends_at;
    `);
    console.log('✅ [2] Updated tenants (Store 11):', JSON.stringify(updateRes.rows[0], null, 2));

    // 3. Insert webhook_events row for event TbA3U9IGViHQfM so it is logged
    const evtRes = await client.query(`
      INSERT INTO webhook_events (event_id, event_type, processed_at)
      VALUES ('TbA3U9IGViHQfM', 'payment.captured', '2026-09-12 14:38:29+05:30')
      ON CONFLICT (event_id) DO NOTHING
      RETURNING *;
    `);
    console.log('✅ [3] Webhook event logged:', evtRes.rows.length > 0 ? evtRes.rows[0] : 'Already logged');

    await client.query('COMMIT');
    console.log('--- TRANSACTION COMMITTED SUCCESSFULLY ---');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Transaction rolled back due to error:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
})();
