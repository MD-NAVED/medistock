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

  console.log('=== QUERY A: TENANTS ===');
  const { rows: qA } = await client.query(
    'SELECT id, store_name, owner_name, phone, email, plan, tier, status, subscription_ends_at, created_at FROM tenants ORDER BY id;'
  );
  console.log(JSON.stringify(qA, null, 2));

  console.log('\n=== QUERY B: TENANT PAYMENTS ===');
  console.log((await client.query(
    'SELECT tp.id, tp.tenant_id, tp.plan, tp.amount, tp.status, tp.razorpay_payment_id, tp.created_at FROM tenant_payments tp ORDER BY tp.id;'
  )).rows);

  console.log('\n=== QUERY C: USERS ===');
  console.log((await client.query(
    'SELECT id, username, name, role, store_id, created_at FROM users ORDER BY id;'
  )).rows);

  console.log('\n=== QUERY D: SALES VOLUME ===');
  console.log((await client.query(
    'SELECT store_id, COUNT(*)::int AS count FROM sales GROUP BY store_id ORDER BY store_id;'
  )).rows);

  console.log('\n=== QUERY E: REFERRAL TRANSACTIONS ===');
  console.log((await client.query(
    'SELECT * FROM referral_transactions ORDER BY id DESC LIMIT 20;'
  )).rows);

  await client.end();
})().catch(console.error);
