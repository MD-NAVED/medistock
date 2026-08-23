// One-off migration: create the khata (udhaar) tables on an ALREADY
// initialized database — for fresh installs init-supabase.sql already has
// them. Additive only (CREATE IF NOT EXISTS), safe to re-run.
//
// Usage: node --env-file=.env scripts/apply-khata.js
// The pool comes from server/db.js so TLS handling (localhost exemption,
// DATABASE_SSL_CA strict mode) stays identical to the running app.
const { pool } = require('../server/db');

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL missing — run with: node --env-file=.env scripts/apply-khata.js');
  await pool.query("CREATE TABLE IF NOT EXISTS customers (id SERIAL PRIMARY KEY, name TEXT NOT NULL, phone VARCHAR(20) NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await pool.query("CREATE TABLE IF NOT EXISTS customer_ledger (id SERIAL PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE, sale_id INTEGER REFERENCES sales(id), kind VARCHAR(20) NOT NULL, amount NUMERIC(12, 2) NOT NULL, note TEXT NOT NULL DEFAULT '', user_id INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  await pool.query('CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer ON customer_ledger(customer_id)');
  const check = await pool.query('SELECT COUNT(*)::int AS n FROM customers');
  console.log('khata tables ready — customers rows:', check.rows[0].n);
  await pool.end();
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
