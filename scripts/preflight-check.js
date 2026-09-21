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

  console.log('=== PRE-FLIGHT A: BATCHES ===');
  const { rows: batches } = await client.query(
    'SELECT id, store_id, medicine_id, batch_number FROM batches ORDER BY id;'
  );
  console.log(JSON.stringify(batches, null, 2));

  console.log('\n=== PRE-FLIGHT B: FOREIGN KEYS REFERENCING TENANTS & USERS ===');
  const { rows: fks } = await client.query(`
    SELECT
        tc.table_name, 
        kcu.column_name, 
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name,
        rc.delete_rule
    FROM 
        information_schema.table_constraints AS tc 
        JOIN information_schema.key_column_usage AS kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        JOIN information_schema.referential_constraints AS rc
          ON tc.constraint_name = rc.constraint_name
        JOIN information_schema.constraint_column_usage AS ccu
          ON ccu.constraint_name = tc.constraint_name
          AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY' 
      AND ccu.table_name IN ('tenants', 'users')
    ORDER BY ccu.table_name, tc.table_name;
  `);
  console.log(JSON.stringify(fks, null, 2));

  console.log('\n=== PRE-FLIGHT C: ALL OTHER TABLES WITH store_id ===');
  const { rows: storeCols } = await client.query(`
    SELECT table_name, column_name 
    FROM information_schema.columns 
    WHERE column_name IN ('store_id', 'tenant_id')
      AND table_schema = 'public'
    ORDER BY table_name;
  `);
  console.log('\n=== PRE-FLIGHT D: ROW COUNTS OF OTHER POTENTIAL FK TABLES ===');
  for (const t of ['customer_ledger', 'sale_returns', 'sale_return_items', 'stock_writeoffs', 'customers', 'login_attempts', 'webhook_events']) {
    try {
      const { rows } = await client.query(`SELECT COUNT(*)::int AS count FROM ${t};`);
      console.log(`${t}: ${rows[0].count}`);
    } catch (e) {
      console.log(`${t}: error (${e.message})`);
    }
  }

  await client.end();
})().catch(console.error);
