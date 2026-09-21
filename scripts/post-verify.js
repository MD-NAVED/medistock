const { Client } = require('pg');
const fs = require('fs');

if (fs.existsSync('.env')) {
  const lines = fs.readFileSync('.env', 'utf8').split('\n');
  lines.forEach(l => {
    const m = l.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
}

const client = new Client({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  await client.connect();

  console.log('=== 1. TENANTS TABLE ===');
  const { rows: tenants } = await client.query('SELECT id, store_name, owner_name, plan, tier, status, subscription_ends_at FROM tenants;');
  console.log(JSON.stringify(tenants, null, 2));

  console.log('\n=== 2. USERS TABLE ===');
  const { rows: users } = await client.query('SELECT id, username, name, role, store_id, active FROM users ORDER BY id;');
  console.log(JSON.stringify(users, null, 2));

  console.log('\n=== 3. SALES TABLE ===');
  const { rows: sales } = await client.query('SELECT id, invoice_number, store_id, user_id, customer_name, total, status FROM sales ORDER BY id;');
  console.log(JSON.stringify(sales, null, 2));

  console.log('\n=== 4. PAYMENTS & WEBHOOKS TABLE ===');
  const { rows: payments } = await client.query('SELECT COUNT(*)::int AS count FROM tenant_payments;');
  const { rows: webhooks } = await client.query('SELECT COUNT(*)::int AS count FROM webhook_events;');
  const { rows: referrals } = await client.query('SELECT COUNT(*)::int AS count FROM referral_transactions;');
  console.log(`tenant_payments: ${payments[0].count}`);
  console.log(`webhook_events: ${webhooks[0].count}`);
  console.log(`referral_transactions: ${referrals[0].count}`);

  console.log('\n=== 5. MEDICINES & BATCHES SUMMARY ===');
  const { rows: meds } = await client.query('SELECT COUNT(*)::int AS count FROM medicines;');
  const { rows: batches } = await client.query('SELECT COUNT(*)::int AS count FROM batches;');
  console.log(`Remaining medicines: ${meds[0].count} (all Store 11)`);
  console.log(`Remaining batches: ${batches[0].count} (all Store 11)`);

  console.log('\n=== 6. FOUNDER CONSOLE METRICS (MRR, TENANTS, BILLS) ===');
  const { rows: founder } = await client.query(`
    SELECT
      COUNT(*)::int AS total_tenants,
      COUNT(*) FILTER (WHERE status = 'active')::int AS active_tenants,
      COUNT(*) FILTER (WHERE status = 'trial' AND trial_ends_at > now())::int AS trial_tenants,
      COUNT(*) FILTER (WHERE status = 'expired' OR (status = 'trial' AND trial_ends_at <= now()))::int AS expired_tenants,
      COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_tenants,
      COALESCE(SUM(CASE WHEN status = 'active' THEN price_per_month ELSE 0 END), 0)::float8 AS mrr,
      (SELECT COUNT(*)::int FROM sales) AS platform_total_bills,
      (SELECT COUNT(*)::int FROM medicines WHERE active = 1) AS platform_total_medicines
    FROM tenants;
  `);
  console.log(JSON.stringify(founder[0], null, 2));

  await client.end();
})().catch(console.error);
