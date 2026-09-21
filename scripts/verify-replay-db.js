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

  console.log('=== 1. WEBHOOK_EVENTS VERIFICATION ===');
  const wh = await client.query("SELECT * FROM webhook_events ORDER BY processed_at DESC LIMIT 5;");
  console.log(JSON.stringify(wh.rows, null, 2));

  console.log('\n=== 2. TENANT_PAYMENTS VERIFICATION ===');
  const tp = await client.query("SELECT id, tenant_id, plan, months, amount, razorpay_order_id, razorpay_payment_id, status, paid_at, created_at FROM tenant_payments ORDER BY id DESC LIMIT 5;");
  console.log(JSON.stringify(tp.rows, null, 2));

  console.log('\n=== 3. TENANTS STORE 11 STATUS ===');
  const t = await client.query("SELECT id, store_name, plan, tier, status, subscription_ends_at, trial_ends_at FROM tenants WHERE id = 11;");
  console.log(JSON.stringify(t.rows, null, 2));

  await client.end();
})().catch(e => {
  console.error(e);
  process.exit(1);
});
