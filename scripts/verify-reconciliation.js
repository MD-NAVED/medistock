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

  console.log('=== 1. TENANT_PAYMENTS (FULL ROW) ===');
  const tp = await client.query("SELECT * FROM tenant_payments WHERE razorpay_payment_id = 'pay_TbA3RvqKiPcqt3';");
  console.log(JSON.stringify(tp.rows[0], null, 2));

  console.log('\n=== 2. TENANTS (STORE 11 STATUS) ===');
  const t = await client.query("SELECT id, store_name, owner_name, phone, plan, tier, status, price_per_month, subscription_ends_at FROM tenants WHERE id = 11;");
  console.log(JSON.stringify(t.rows[0], null, 2));

  console.log('\n=== 3. FOUNDER OVERVIEW METRICS (HONEST MRR) ===');
  const f = await client.query(`
    SELECT
      COUNT(*)::int AS total_tenants,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active_tenants,
      COUNT(*) FILTER (WHERE status = 'trial' AND trial_ends_at > now())::int AS trial_tenants,
      COUNT(*) FILTER (WHERE status = 'expired' OR (status = 'trial' AND trial_ends_at <= now()))::int AS expired_tenants,
      COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_tenants,
      COALESCE(SUM(CASE WHEN status = 'active' THEN price_per_month ELSE 0 END), 0)::float8 AS mrr,
      (SELECT COUNT(*)::int FROM tenant_payments WHERE status = 'paid') AS total_paid_payments,
      (SELECT COALESCE(SUM(amount), 0)::float8 / 100 FROM tenant_payments WHERE status = 'paid') AS total_revenue_collected,
      (SELECT COUNT(*)::int FROM sales) AS platform_total_bills,
      (SELECT COUNT(*)::int FROM medicines WHERE active = 1) AS platform_total_medicines
    FROM tenants;
  `);
  console.log(JSON.stringify(f.rows[0], null, 2));

  console.log('\n=== 4. WEBHOOK_EVENTS ===');
  const wh = await client.query("SELECT * FROM webhook_events WHERE event_id = 'TbA3U9IGViHQfM';");
  console.log(JSON.stringify(wh.rows[0], null, 2));

  await client.end();
})();
