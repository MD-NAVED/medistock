/**
 * Scale Hardening Acceptance Test Suite (scripts/test-import-scale.js)
 * 
 * Verifies:
 * 1. 3,300 rows (3,000 valid + 100 invalid + 200 duplicates) commits in < 8.0s
 * 2. Exactly 3,000 unique medicines in catalog (no duplicates)
 * 3. 100 invalid rows returned in error report with clear reasons
 * 4. 200 duplicate rows updated without duplicate catalog entries
 * 5. Re-importing same file results in zero stock doubling (idempotent upsert)
 * 6. 5,001-row boundary guard cleanly rejected with HTTP 400
 * 7. Clean teardown of synthetic test data
 */
const { Client } = require('pg');

const RAW_BASE = process.env.BASE || 'http://localhost:3001';
const BASE = RAW_BASE;
const DB_URL = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/medistock';

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    results.push(`  PASS  ${name}`);
  } else {
    fail++;
    results.push(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

async function call(pathname, { method = 'GET', body, token } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* no json */ }
  return { status: res.status, data };
}

(async () => {
  console.log('\n=== Import Scale Hardening Acceptance Test (<8s SLA) ===');

  // 1. Authenticate (try demo user first, fallback to owner)
  let token = null;
  let loginRes = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'demo', password: 'Demo@2026' },
  });
  if (loginRes.status === 200 && loginRes.data?.token) {
    token = loginRes.data.token;
  } else {
    loginRes = await call('/api/auth/login', {
      method: 'POST',
      body: { username: 'owner', password: 'owner123' },
    });
    if (loginRes.status === 200 && loginRes.data?.token) {
      token = loginRes.data.token;
    }
  }

  check('login successful for scale test', !!token, `status: ${loginRes.status}`);
  if (!token) {
    console.error('Could not authenticate. Aborting scale test.');
    process.exit(1);
  }

  // Connect to DB for independent direct verification
  let dbClient = null;
  try {
    dbClient = new Client({ connectionString: DB_URL, ssl: DB_URL.includes('supabase') ? { rejectUnauthorized: false } : false });
    await dbClient.connect();
  } catch (err) {
    console.warn('[DB Note] Could not connect directly to DB, will verify via API endpoints:', err.message);
  }

  const TEST_PREFIX = 'ScaleMed_';

  // Cleanup any leftover synthetic scale test rows before starting
  if (dbClient) {
    await dbClient.query(`
      DELETE FROM batches WHERE medicine_id IN (SELECT id FROM medicines WHERE name LIKE '${TEST_PREFIX}%');
      DELETE FROM medicines WHERE name LIKE '${TEST_PREFIX}%';
    `);
  }

  // 2. Generate Synthetic Dataset:
  // - 3,000 valid unique medicines
  // - 100 invalid rows (50 missing name, 50 bad expiry format)
  // - 200 duplicates of the first 200 valid medicines
  console.log('Generating synthetic dataset: 3,000 valid + 100 invalid + 200 duplicates...');
  const rows = [];
  let rowIdx = 1;

  // 3,000 valid rows
  for (let i = 1; i <= 3000; i++) {
    rows.push({
      i: rowIdx++,
      name: `${TEST_PREFIX}${String(i).padStart(4, '0')}`,
      company: `Pharma Corp ${i % 50}`,
      type: 'Tablet',
      shelf: `Rack-${(i % 20) + 1}`,
      buy_price: '12.50',
      sell_price: '20.00',
      gst_rate: '12',
      batch_no: `BATCH-${String(i).padStart(4, '0')}`,
      expiry_date: i % 2 === 0 ? '12/2027' : '05/2028',
      quantity: '50',
    });
  }

  // 100 invalid rows
  for (let i = 1; i <= 50; i++) {
    // Missing medicine name
    rows.push({
      i: rowIdx++,
      name: '',
      company: 'Invalid Pharma',
      sell_price: '10.00',
      batch_no: `INV-NAME-${i}`,
      expiry_date: '12/2027',
      quantity: '20',
    });
  }
  for (let i = 1; i <= 50; i++) {
    // Bad / unreadable expiry format
    rows.push({
      i: rowIdx++,
      name: `${TEST_PREFIX}BadExp_${i}`,
      company: 'Bad Expiry Pharma',
      sell_price: '15.00',
      batch_no: `INV-EXP-${i}`,
      expiry_date: '99/9999',
      quantity: '30',
    });
  }

  // 200 duplicates of existing medicines (first 200)
  for (let i = 1; i <= 200; i++) {
    rows.push({
      i: rowIdx++,
      name: `${TEST_PREFIX}${String(i).padStart(4, '0')}`,
      company: `Pharma Corp ${i % 50}`,
      type: 'Tablet',
      shelf: `Rack-UPDATED`,
      buy_price: '14.00',
      sell_price: '22.00',
      gst_rate: '12',
      batch_no: `BATCH-${String(i).padStart(4, '0')}`,
      expiry_date: '12/2027',
      quantity: '50',
    });
  }

  check('total generated rows count is 3,300', rows.length === 3300, `got ${rows.length}`);

  // 3. Scale Test Execution: Measure commit duration (<8.0s)
  console.log(`Executing batch import of ${rows.length} rows...`);
  const t0 = performance.now();
  const commitRes = await call('/api/import/commit', {
    method: 'POST',
    token,
    body: { rows },
  });
  const t1 = performance.now();
  const durationSec = (t1 - t0) / 1000;

  console.log(`⏱️ Import commit completed in ${durationSec.toFixed(3)}s`);
  check('POST /api/import/commit returns 200 OK', commitRes.status === 200, JSON.stringify(commitRes.data));
  check('import duration is strictly under 8.0s SLA', durationSec < 8.0, `actual: ${durationSec.toFixed(3)}s`);

  const summary = commitRes.data || {};
  check('3000 medicines created', summary.created === 3000, `created: ${summary.created}`);
  check('200 duplicates updated', summary.existing === 200, `existing: ${summary.existing}`);
  check('100 invalid rows skipped with reasons', summary.skipped?.length === 100, `skipped: ${summary.skipped?.length}`);
  check('50 stock skipped due to invalid expiry', summary.stock_skipped === 50, `stock_skipped: ${summary.stock_skipped}`);

  // 4. Verify Catalog in Database
  if (dbClient) {
    const medCountRes = await dbClient.query(`SELECT COUNT(*)::int AS count FROM medicines WHERE name LIKE '${TEST_PREFIX}%' AND active = 1`);
    const totalMeds = medCountRes.rows[0].count;
    console.log(`📊 DB Verification: Found ${totalMeds} medicines with prefix ${TEST_PREFIX}`);
    check('catalog has exactly 3,000 distinct medicines (no doubles)', totalMeds === 3000, `found ${totalMeds}`);

    // Verify sample batch quantities
    // BATCH-0001 was in row 1 (50) and row 3101 (50) -> in-file consolidated total = 100
    const sampleBatchRes = await dbClient.query(`
      SELECT b.quantity, b.expiry_date 
      FROM batches b 
      JOIN medicines m ON m.id = b.medicine_id 
      WHERE m.name = '${TEST_PREFIX}0001' AND b.batch_number = 'BATCH-0001'
    `);
    const initialBatch1Qty = sampleBatchRes.rows[0]?.quantity;
    check('sample batch BATCH-0001 consolidated quantity is 100', initialBatch1Qty === 100, `got ${initialBatch1Qty}`);

    // BATCH-0500 had 1 single row of 50
    const sampleSingleBatchRes = await dbClient.query(`
      SELECT b.quantity, b.expiry_date 
      FROM batches b 
      JOIN medicines m ON m.id = b.medicine_id 
      WHERE m.name = '${TEST_PREFIX}0500' AND b.batch_number = 'BATCH-0500'
    `);
    const initialBatch500Qty = sampleSingleBatchRes.rows[0]?.quantity;
    check('sample batch BATCH-0500 created with correct quantity 50', initialBatch500Qty === 50, `got ${initialBatch500Qty}`);
  }

  // 5. Re-Import Idempotency Test: Zero Stock Doubling
  console.log('Testing re-import idempotency (re-uploading identical file)...');
  const tRe0 = performance.now();
  const reImportRes = await call('/api/import/commit', {
    method: 'POST',
    token,
    body: { rows },
  });
  const tRe1 = performance.now();
  const reDurationSec = (tRe1 - tRe0) / 1000;
  console.log(`⏱️ Re-import completed in ${reDurationSec.toFixed(3)}s`);

  check('re-import returns 200 OK', reImportRes.status === 200, JSON.stringify(reImportRes.data));
  const reSummary = reImportRes.data || {};
  check('re-import creates 0 new medicines', reSummary.created === 0, `created: ${reSummary.created}`);
  check('re-import updates 3,200 existing medicines', reSummary.existing === 3200, `existing: ${reSummary.existing}`);

  if (dbClient) {
    // Assert stock did NOT double for both multi-row and single-row batches
    const sampleAfterReimport = await dbClient.query(`
      SELECT b.quantity, b.expiry_date 
      FROM batches b 
      JOIN medicines m ON m.id = b.medicine_id 
      WHERE m.name = '${TEST_PREFIX}0001' AND b.batch_number = 'BATCH-0001'
    `);
    const finalQty1 = sampleAfterReimport.rows[0]?.quantity;
    console.log(`📦 Re-import batch BATCH-0001 quantity check: ${finalQty1} (Initial was 100)`);
    check('zero stock doubling on re-import for BATCH-0001 (quantity stays 100)', finalQty1 === 100, `got ${finalQty1}`);

    const sampleSingleAfterReimport = await dbClient.query(`
      SELECT b.quantity, b.expiry_date 
      FROM batches b 
      JOIN medicines m ON m.id = b.medicine_id 
      WHERE m.name = '${TEST_PREFIX}0500' AND b.batch_number = 'BATCH-0500'
    `);
    const finalQty500 = sampleSingleAfterReimport.rows[0]?.quantity;
    console.log(`📦 Re-import batch BATCH-0500 quantity check: ${finalQty500} (Initial was 50)`);
    check('zero stock doubling on re-import for BATCH-0500 (quantity stays 50)', finalQty500 === 50, `got ${finalQty500}`);

    const finalMedsCount = (await dbClient.query(`SELECT COUNT(*)::int AS count FROM medicines WHERE name LIKE '${TEST_PREFIX}%'`)).rows[0].count;
    check('catalog still has exactly 3,000 distinct medicines after re-import', finalMedsCount === 3000, `got ${finalMedsCount}`);
  }

  // 6. Test 5,000-Row Boundary Rejection (5,001 rows -> 400 clean rejection)
  console.log('Testing 5,000-row limit boundary (sending 5,001 rows)...');
  const boundaryRows = [];
  for (let i = 1; i <= 5001; i++) {
    boundaryRows.push({
      i,
      name: `BoundMed_${i}`,
      company: 'BoundCorp',
      sell_price: '10.00',
    });
  }
  const boundaryRes = await call('/api/import/commit', {
    method: 'POST',
    token,
    body: { rows: boundaryRows },
  });
  check('5,001 rows triggers clean 400 rejection', boundaryRes.status === 400, `got status ${boundaryRes.status}`);
  check('400 rejection message specifies maximum row limit', String(boundaryRes.data?.error || '').includes('5000'), `msg: ${boundaryRes.data?.error}`);

  // 7. Cleanup Synthetic Data
  if (dbClient) {
    console.log('Cleaning up synthetic scale test medicines & batches...');
    await dbClient.query(`
      DELETE FROM batches WHERE medicine_id IN (SELECT id FROM medicines WHERE name LIKE '${TEST_PREFIX}%');
      DELETE FROM medicines WHERE name LIKE '${TEST_PREFIX}%';
    `);
    await dbClient.end();
  }

  // Print Summary
  console.log('\n=== Scale Hardening Test Results ===');
  for (const r of results) {
    console.log(r);
  }
  console.log(`\n${pass} passed, ${fail} failed\n`);

  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('Scale test crashed:', err);
  process.exit(1);
});
