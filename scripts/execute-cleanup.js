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

async function runCleanup() {
  await client.connect();
  console.log('Connected to PostgreSQL database for production cleanup.');

  try {
    await client.query('BEGIN');
    console.log('--- TRANSACTION STARTED ---');

    // 1. Re-parent Medicines 27 & 37 and Batches 43 & 46 to Store 11
    const upMed = await client.query('UPDATE medicines SET store_id = 11 WHERE id IN (27, 37);');
    console.log(`[1] Re-parented medicines (27, 37) to store 11: ${upMed.rowCount} rows`);

    const upBatches = await client.query('UPDATE batches SET store_id = 11 WHERE id IN (43, 46);');
    console.log(`[2] Re-parented batches (43, 46) to store 11: ${upBatches.rowCount} rows`);

    // 2. Re-parent Sales 9 & 11 to Store 11 and user 1
    const upSales = await client.query('UPDATE sales SET store_id = 11, user_id = 1, cancelled_by = NULL WHERE id IN (9, 11);');
    console.log(`[3] Re-parented sales (9, 11) to store 11 / user 1: ${upSales.rowCount} rows`);

    // 3. Delete test sales & line items (Sales 8 & 10)
    const delRetItems = await client.query('DELETE FROM sale_return_items WHERE sale_item_id IN (SELECT id FROM sale_items WHERE sale_id IN (8, 10));');
    console.log(`[4] Deleted sale_return_items for test sales (8, 10): ${delRetItems.rowCount} rows`);

    const delReturns = await client.query('DELETE FROM sale_returns WHERE sale_id IN (8, 10);');
    console.log(`[5] Deleted sale_returns for test sales (8, 10): ${delReturns.rowCount} rows`);

    const delSaleItems = await client.query('DELETE FROM sale_items WHERE sale_id IN (8, 10);');
    console.log(`[6] Deleted sale_items for test sales (8, 10): ${delSaleItems.rowCount} rows`);

    const delSales = await client.query('DELETE FROM sales WHERE id IN (8, 10);');
    console.log(`[7] Deleted test sales (8, 10): ${delSales.rowCount} rows`);

    // 4. Delete test purchases (2, 3, 4, 5, 6)
    const delPurchItems = await client.query('DELETE FROM purchase_items WHERE purchase_id IN (2, 3, 4, 5, 6);');
    console.log(`[8] Deleted purchase_items for test purchases (2..6): ${delPurchItems.rowCount} rows`);

    const delPurchases = await client.query('DELETE FROM purchases WHERE id IN (2, 3, 4, 5, 6);');
    console.log(`[9] Deleted test purchases (2..6): ${delPurchases.rowCount} rows`);

    // 5. Delete test batches (42, 44, 45) & test medicines
    const delBatches = await client.query('DELETE FROM batches WHERE id IN (42, 44, 45);');
    console.log(`[10] Deleted test batches (42, 44, 45): ${delBatches.rowCount} rows`);

    const delMedicines = await client.query('DELETE FROM medicines WHERE store_id <> 11 OR store_id IS NULL;');
    console.log(`[11] Deleted test medicines: ${delMedicines.rowCount} rows`);

    // 6. Clear payments, webhooks, referrals
    const delWebhooks = await client.query('DELETE FROM webhook_events;');
    console.log(`[12] Cleared webhook_events: ${delWebhooks.rowCount} rows`);

    const delPayments = await client.query('DELETE FROM tenant_payments;');
    console.log(`[13] Cleared tenant_payments: ${delPayments.rowCount} rows`);

    const delReferrals = await client.query('DELETE FROM referral_transactions;');
    console.log(`[14] Cleared referral_transactions: ${delReferrals.rowCount} rows`);

    // 7. Delete test sessions, login attempts & test users
    const delSessions = await client.query('DELETE FROM sessions WHERE user_id NOT IN (1, 2, 5, 32);');
    console.log(`[15] Deleted test sessions: ${delSessions.rowCount} rows`);

    const delAttempts = await client.query("DELETE FROM login_attempts WHERE username NOT IN ('owner', 'staff', '@naved', '#Andy');");
    console.log(`[16] Deleted test login_attempts: ${delAttempts.rowCount} rows`);

    const delUsers = await client.query('DELETE FROM users WHERE id NOT IN (1, 2, 5, 32);');
    console.log(`[17] Deleted test users: ${delUsers.rowCount} rows`);

    // 8. Disconnect self-referral, delete settings & test tenants
    const nullifyRef = await client.query('UPDATE tenants SET referred_by_tenant_id = NULL WHERE id <> 11;');
    console.log(`[18] Nullified referred_by_tenant_id on test tenants: ${nullifyRef.rowCount} rows`);

    const delSettings = await client.query('DELETE FROM settings WHERE store_id <> 11 OR store_id IS NULL;');
    console.log(`[19] Deleted test settings: ${delSettings.rowCount} rows`);

    const delTenants = await client.query('DELETE FROM tenants WHERE id <> 11;');
    console.log(`[20] Deleted test tenants: ${delTenants.rowCount} rows`);

    // SAFETY ASSERTIONS
    const { rows: tCheck } = await client.query('SELECT id, store_name FROM tenants;');
    if (tCheck.length !== 1 || tCheck[0].id !== 11) {
      throw new Error(`SAFETY ASSERTION FAILED: Expected exactly Tenant 11, found: ${JSON.stringify(tCheck)}`);
    }

    const { rows: uCheck } = await client.query('SELECT id, username FROM users ORDER BY id;');
    if (uCheck.length !== 4) {
      throw new Error(`SAFETY ASSERTION FAILED: Expected 4 users, found: ${uCheck.length}`);
    }

    const { rows: sCheck } = await client.query('SELECT id, store_id FROM sales ORDER BY id;');
    if (sCheck.length !== 4 || !sCheck.every(s => s.store_id === 11)) {
      throw new Error(`SAFETY ASSERTION FAILED: Expected 4 sales all in store 11, found: ${JSON.stringify(sCheck)}`);
    }

    await client.query('COMMIT');
    console.log('--- TRANSACTION COMMITTED SUCCESSFULLY ---');
    console.log('Database state verified: Exactly 1 tenant (Store 11), 4 users, 4 sales (all store 11).');
  } catch (err) {
    console.error('ERROR during transaction! Executing ROLLBACK...', err);
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  runCleanup().catch(err => {
    console.error('Cleanup execution failed:', err);
    process.exit(1);
  });
}

module.exports = { runCleanup };
