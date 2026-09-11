/**
 * Query performance profiling script to run EXPLAIN ANALYZE
 */
const { Client } = require('pg');

const url = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL || 'postgresql://postgres.PROJECT_REF:REDACTED_PASSWORD@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres';

(async () => {
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  console.log('Connected to DB for profiling...');

  // Ensure composite indexes
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_sales_store_created ON sales(store_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_batches_store_expiry ON batches(store_id, expiry_date ASC);
    CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer_created ON customer_ledger(customer_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_tenant_payments_order ON tenant_payments(razorpay_order_id);
  `);

  console.log('Composite indexes applied.');

  // Top 5 queries profiling
  const queries = [
    {
      name: '1. Session Token Auth Lookup (Every Request)',
      sql: "EXPLAIN ANALYZE SELECT s.token, u.id, u.username, u.name, u.role, u.active, u.store_id, u.platform_admin, t.status AS tenant_status, t.tier AS tenant_tier, t.trial_ends_at, t.subscription_ends_at FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN tenants t ON t.id = u.store_id WHERE s.token = 'dummy_token' AND s.expires_at > now()",
    },
    {
      name: '2. Dashboard Sales & Revenue Aggregation (Today IST)',
      sql: "EXPLAIN ANALYZE SELECT COUNT(DISTINCT s.id)::int AS bills, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.store_id = 16 AND (s.created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date AND s.status != 'cancelled'",
    },
    {
      name: '3. Expiry Alerts Report (Batches expiring in 90 days)',
      sql: "EXPLAIN ANALYZE SELECT b.id, b.batch_number, b.expiry_date, b.quantity, m.name, m.company, m.shelf FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.store_id = 16 AND b.quantity > 0 AND b.expiry_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date + 90 ORDER BY b.expiry_date ASC",
    },
    {
      name: '4. Khata Customer Balances',
      sql: "EXPLAIN ANALYZE SELECT c.id, c.name, c.phone, COALESCE(SUM(CASE l.kind WHEN 'credit' THEN l.amount ELSE -l.amount END), 0)::float8 AS balance FROM customers c LEFT JOIN customer_ledger l ON l.customer_id = c.id WHERE c.store_id = 16 GROUP BY c.id ORDER BY c.name ASC",
    },
    {
      name: '5. Sales History with Date Filter (Last 30 Days)',
      sql: "EXPLAIN ANALYZE SELECT s.id, s.invoice_number, s.customer_name, s.subtotal, s.gst_amount, s.total, s.created_at, s.status, u.name AS served_by FROM sales s JOIN users u ON u.id = s.user_id WHERE s.store_id = 16 AND (s.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '2026-08-01' AND '2026-09-11' ORDER BY s.id DESC LIMIT 100",
    },
  ];

  let output = '# PostgreSQL Query Execution Plans & Performance Baseline\n\n';
  output += `Generated at: ${new Date().toISOString()}\n\n`;

  for (const q of queries) {
    console.log(`Profiling: ${q.name}`);
    const res = await client.query(q.sql);
    output += `### ${q.name}\n\`\`\`sql\n${q.sql.replace('EXPLAIN ANALYZE ', '')}\n\`\`\`\n\n**Plan:**\n\`\`\`text\n`;
    for (const row of res.rows) {
      output += row['QUERY PLAN'] + '\n';
    }
    output += '```\n\n---\n\n';
  }

  const fs = require('fs');
  fs.writeFileSync('docs/perf-baseline.md', output);
  console.log('docs/perf-baseline.md written successfully.');

  await client.end();
})();
