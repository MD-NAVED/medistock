/**
 * Focused test for PUT /api/purchases/:id (Purchase Edit).
 * Run with the server already listening on PORT (default 3001).
 *
 * Scenarios:
 *  1. Owner-only — staff PUT is rejected (403).
 *  2. Edit supplier + reduce a line qty — stock moves accordingly, total recomputed.
 *  3. Edit add a new batch — stock added.
 *  4. Reversed purchase is not editable (409).
 *  5. Reducing a batch below sold stock is refused (409).
 */
const BASE = process.env.BASE || 'http://localhost:3001';
let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

async function call(p, { method = 'GET', body, token } = {}) {
  // URL is strictly derived from a fixed origin (BASE) — no arbitrary host.
  const url = new URL(p, BASE);
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const STAMP = Date.now();
const MED_A = `EdTestMed-A${STAMP}`;
const MED_B = `EdTestMed-B${STAMP}`;
const BATCH_A = `BTCH-A-${STAMP}`;
const BATCH_A2 = `BTCH-A2-${STAMP}`;
const BATCH_B = `BTCH-B-${STAMP}`;

(async () => {
  // ---- Login as owner and staff ----
  const oLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner123' } });
  check('owner login', oLogin.status === 200 && !!oLogin.data.token, JSON.stringify(oLogin.data));
  const owner = oLogin.data.token;

  const sLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'staff', password: 'staff123' } });
  check('staff login', sLogin.status === 200 && !!sLogin.data.token);
  const staff = sLogin.data.token;

  // ---- Create medicines A and B ----
  const makeMed = async (name) => {
    const r = await call('/api/medicines', { method: 'POST', token: owner, body: {
      name, company: 'EdTestCo', price: 25, buy_price: 12, hsn: '3004', gst: 12,
    } });
    if (r.status === 200) return r.data.id;
    const found = await call('/api/medicines?q=' + encodeURIComponent(name), { token: owner });
    const hit = (found.data || []).find((m) => m.name === name);
    return hit ? hit.id : null;
  };
  const medA = await makeMed(MED_A);
  const medB = await makeMed(MED_B);
  check('created/found medicine A', !!medA);
  check('created/found medicine B', !!medB);
  if (!medA || !medB) { printResults(); return; }

  // ---- Scenario 1: staff cannot edit (PUT requires owner) ----
  const r1a = await call('/api/purchases/999999', { method: 'PUT', token: staff, body: { supplier_name: 'X', invoice_number: 'Y', items: [] } });
  check('staff PUT rejected (403 expected)', r1a.status === 403, `status=${r1a.status}`);

  // ---- Make a purchase: 10 of A @10 in BATCH_A ----
  const post1 = await call('/api/purchases', { method: 'POST', token: owner, body: {
    supplier_name: 'OrigSupplier',
    invoice_number: `EDINV-${STAMP}`,
    items: [
      { medicine_id: medA, batch_number: BATCH_A, expiry_date: '2027-12-31', quantity: 10, buy_price: 10 },
    ],
  } });
  check('POST purchase (10 of A)', post1.status === 200 && post1.data.id > 0, JSON.stringify(post1.data));
  const pid = post1.data && post1.data.id;

  const stockCheck = async (medId) => (await call('/api/medicines/' + medId + '/batches', { token: owner })).data || [];
  const batches1 = await stockCheck(medA);
  const ba1 = batches1.find((b) => b.batch_number === BATCH_A);
  check('Batch A has 10 after POST', ba1 && ba1.quantity === 10, JSON.stringify(ba1));

  // ---- Scenario 2: edit — change supplier + reduce A to 6 @11 ----
  const put1 = await call('/api/purchases/' + pid, { method: 'PUT', token: owner, body: {
    supplier_name: 'EditedSupplier',
    invoice_number: `EDINV2-${STAMP}`,
    items: [
      { medicine_id: medA, batch_number: BATCH_A, expiry_date: '2027-12-31', quantity: 6, buy_price: 11 },
    ],
  } });
  check('PUT edit reduces qty + changes supplier', put1.status === 200, JSON.stringify(put1.data));

  await sleep(50);
  const detail1 = await call('/api/purchases/' + pid, { token: owner });
  check('detail reflects new supplier', !!(detail1.data && detail1.data.purchase && detail1.data.purchase.supplier_name === 'EditedSupplier'),
    JSON.stringify(detail1.data && detail1.data.purchase));
  check('detail reflects new total 6*11=66', !!(detail1.data && detail1.data.purchase && Number(detail1.data.purchase.total) === 66),
    JSON.stringify(detail1.data && detail1.data.purchase && detail1.data.purchase.total));

  const batches2 = await stockCheck(medA);
  const ba2 = batches2.find((b) => b.batch_number === BATCH_A);
  check('Batch A now 6 after edit', ba2 && ba2.quantity === 6, JSON.stringify(ba2));

  const medInfo = (await call('/api/medicines', { token: owner })).data.find((m) => m.id === medA);
  check('medicines.buy_price updated to 11', medInfo && Number(medInfo.buy_price) === 11, JSON.stringify(medInfo));

  // ---- Scenario 3: edit — replace BATCH_A line with BATCH_A2 @20 (no conflict) ----
  const put2 = await call('/api/purchases/' + pid, { method: 'PUT', token: owner, body: {
    supplier_name: 'EditedSupplier2',
    invoice_number: `EDINV3-${STAMP}`,
    items: [
      { medicine_id: medA, batch_number: BATCH_A2, expiry_date: '2028-06-30', quantity: 20, buy_price: 13 },
    ],
  } });
  check('PUT replace batch A -> A2', put2.status === 200, JSON.stringify(put2.data));
  await sleep(50);
  const batches3 = await stockCheck(medA);
  const ba3old = batches3.find((b) => b.batch_number === BATCH_A);
  const ba3new = batches3.find((b) => b.batch_number === BATCH_A2);
  // batches endpoint filters quantity > 0, so a fully-reversed batch (qty = 0) drops out of the list.
  check('old batch A dropped from in-stock list (qty = 0)', ba3old == null, `got=${JSON.stringify(ba3old)}`);
  check('new batch A2 has 20 (stock added)', ba3new && ba3new.quantity === 20, JSON.stringify(ba3new));

  // ---- Scenario 4: reversed purchase is not editable (409) ----
  const postThrow = await call('/api/purchases', { method: 'POST', token: owner, body: {
    supplier_name: 'ThrowawaySupplier',
    invoice_number: `EDTHROW-${STAMP}`,
    items: [{ medicine_id: medB, batch_number: BATCH_B, expiry_date: '2028-06-30', quantity: 5, buy_price: 7 }],
  } });
  const pidThrow = postThrow.data && postThrow.data.id;
  check('throwaway purchase created for reverse test', postThrow.status === 200 && pidThrow > 0, JSON.stringify(postThrow.data));
  const rev = await call('/api/purchases/' + pidThrow + '/reverse', { method: 'POST', token: owner, body: { reason: 'edit-test setup' } });
  check('throwaway reversed', rev.status === 200, JSON.stringify(rev.data));
  const putAfterRev = await call('/api/purchases/' + pidThrow, { method: 'PUT', token: owner, body: {
    supplier_name: 'X', invoice_number: 'Y',
    items: [{ medicine_id: medB, batch_number: BATCH_B, expiry_date: '2028-06-30', quantity: 100, buy_price: 7 }],
  } });
  check('PUT on reversed purchase refused (409)', putAfterRev.status === 409, JSON.stringify(putAfterRev.data));

  // ---- Scenario 5: reduction below sold stock is refused (409) ----
  // BATCH_A2 currently has 20 of medA. Sell 15 of them via /api/sales (FEFO picks BATCH_A2 since BATCH_A is now 0).
  const sellR = await call('/api/sales', { method: 'POST', token: owner, body: {
    items: [{ medicine_id: medA, quantity: 15 }],
    customer_name: 'EdTest Customer',
  } });
  check('sold 15 of A from BATCH_A2 (FEFO)', sellR.status === 200, JSON.stringify(sellR.data));
  await sleep(50);
  const batches5 = await stockCheck(medA);
  const ba5 = batches5.find((b) => b.batch_number === BATCH_A2);
  check('A2 is now 5 (20-15)', ba5 && ba5.quantity === 5, JSON.stringify(ba5));

  // Edit the original purchase (pid), which currently says 20 of A @13 in BATCH_A2.
  // Reducing to qty 4 = reduction of 16, but only 5 stock remains. Must refuse with 409.
  const putReduction = await call('/api/purchases/' + pid, { method: 'PUT', token: owner, body: {
    supplier_name: 'EditedSupplier3',
    invoice_number: `EDINV4-${STAMP}`,
    items: [
      { medicine_id: medA, batch_number: BATCH_A2, expiry_date: '2028-06-30', quantity: 4, buy_price: 13 },
    ],
  } });
  check('reducing batch below sold stock refused (409)', putReduction.status === 409, JSON.stringify(putReduction.data));
  check('409 message references remaining stock', /stock|sold|cannot reduce/i.test(String((putReduction.data && putReduction.data.error) || '')),
    JSON.stringify(putReduction.data));

  // Confirm stock UNCHANGED after refused edit (transaction rolled back)
  const batches6 = await stockCheck(medA);
  const ba6 = batches6.find((b) => b.batch_number === BATCH_A2);
  check('A2 still 5 after refused edit (rollback)', ba6 && ba6.quantity === 5, JSON.stringify(ba6));

  printResults();
})().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(2);
});

function printResults() {
  console.log('\n=== PUT /api/purchases/:id test results ===');
  results.forEach((r) => console.log(r));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
