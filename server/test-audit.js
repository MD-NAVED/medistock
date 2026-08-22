/**
 * Comprehensive audit for the features NOT already covered by test-api.js.
 * Run with the server already listening on PORT (default 3001).
 *
 * Coverage gaps this fills:
 *  1. Batch view endpoint /api/medicines/:id/batches (Level 1 — batch view)
 *  2. GET /api/purchases list (Level 1 — purchases listing)
 *  3. GET /api/reports smoke (Level 1 — old bill view / reports)
 *  4. DATABASE-BACKED SESSION SURVIVES SERVER RESTART (Level 2 — the key test
 *     that a pure in-memory session store would fail).
 *     This script prints "RESTART-SERVER-NOW" between phases; the operator
 *     must stop and restart the server between the two halves. A token fetched
 *     before the restart must still authenticate after it.
 */
// These suites only ever talk to the local dev server.
const RAW_BASE = process.env.BASE || 'http://localhost:3001';
const { hostname: BASE_HOST } = new URL(RAW_BASE);
if (BASE_HOST !== 'localhost' && BASE_HOST !== '127.0.0.1') {
  console.error('BASE must point at localhost (these tests hit the local dev server only)');
  process.exit(1);
}
const BASE = RAW_BASE;
const MODE = process.env.AUDIT_MODE || 'phase1'; // phase1 | phase2
let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

const API_PATH_RE = /^\/[A-Za-z0-9\-\/]*$/;
async function call(p, { method = 'GET', body, token } = {}) {
  // Only relative /api paths — a request can never leave the gated BASE origin.
  if (typeof p !== 'string' || !API_PATH_RE.test(p)) throw new Error('test path must be a relative /api path');
  const res = await fetch(BASE + p, {
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

(async () => {
  if (MODE === 'phase1') {
    console.log('\n>>> AUDIT PHASE 1 — fetching token + covering gaps other than restart');
    // Login both users
    const oLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner123' } });
    check('phase1 owner login', oLogin.status === 200 && !!oLogin.data.token, JSON.stringify(oLogin.data));
    const owner = oLogin.data.token;
    const sLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'staff', password: 'staff123' } });
    const staff = sLogin.data.token;
    check('phase1 staff login', sLogin.status === 200 && !!staff);

    // ---- Gap 1: Batch view endpoint ----
    // Make a medicine, post a purchase, then fetch its batches.
    const medR = await call('/api/medicines', { method: 'POST', token: owner, body: {
      name: `AuditBatchMed-${STAMP}`, company: 'AuditCo', price: 50, buy_price: 20, hsn: '3004', gst: 12,
    } });
    let medId = medR.data && medR.data.id;
    if (!medId) {
      const found = await call('/api/medicines?q=AuditBatchMed', { token: owner });
      medId = (found.data || []).find((m) => m.name === `AuditBatchMed-${STAMP}`)?.id;
    }
    // medId feeds a URL path below — accept only a positive integer so the
    // path can never carry scheme/host characters.
    medId = Number(medId);
    if (!Number.isInteger(medId) || medId <= 0) throw new Error('audit medicine id missing');
    check('audit medicine created', !!medId, JSON.stringify(medR.data));
    const BATCH = `AUDBTCH-${STAMP}`;
    const pur = await call('/api/purchases', { method: 'POST', token: owner, body: {
      supplier_name: 'AuditSupplier',
      invoice_number: `AUDINV-${STAMP}`,
      items: [{ medicine_id: medId, batch_number: BATCH, expiry_date: '2028-12-31', quantity: 14, buy_price: 20 }],
    } });
    check('audit purchase posted', pur.status === 200, JSON.stringify(pur.data));

    const medBatchesPath = `/api/medicines/${medId}/batches`;
    const bRes = await call(medBatchesPath, { token: owner });
    check('GET /api/medicines/:id/batches returns 200', bRes.status === 200, JSON.stringify(bRes.data));
    const myBatch = (bRes.data || []).find((b) => b.batch_number === BATCH);
    check('batch view lists the new batch with qty 14', myBatch && myBatch.quantity === 14, JSON.stringify(bRes.data));
    check('batch view exposes expiry_date', myBatch && !!myBatch.expiry_date);
    check('batch view exposes days_left', myBatch && Number.isFinite(Number(myBatch.days_left)), JSON.stringify(myBatch));

    // staff should also see batches (read-only is fine)
    const bStaff = await call(medBatchesPath, { token: staff });
    check('staff can read batches', bStaff.status === 200, `status=${bStaff.status}`);

    // ---- Gap 2: GET /api/purchases list ----
    const listP = await call('/api/purchases', { token: owner });
    check('GET /api/purchases returns 200', listP.status === 200, `status=${listP.status}`);
    check('purchase list includes the audit purchase', (listP.data || []).some((r) => r.id === pur.data.id), `count=${(listP.data || []).length}`);
    const myRow = (listP.data || []).find((r) => r.id === pur.data.id);
    check('purchase list row has item_count', myRow && Number.isFinite(Number(myRow.item_count)));
    check('purchase list row has created_by', myRow && !!myRow.created_by);
    check('purchase list row has status field', myRow && !!myRow.status);

    // ---- Gap 3: reports smoke ----
    const rep = await call('/api/reports/dashboard', { token: owner });
    check('GET /api/reports/dashboard returns 200', rep.status === 200, `status=${rep.status}`);
    check('reports dashboard returns object', rep.data && typeof rep.data === 'object', JSON.stringify(rep.data && Object.keys(rep.data)));
    // Alerts endpoint is the expiry/stock-alert surface
    const alerts = await call('/api/alerts', { token: owner });
    check('GET /api/alerts returns 200', alerts.status === 200, `status=${alerts.status}`);
    check('alerts has counts', alerts.data && 'counts' in alerts.data, JSON.stringify(alerts.data && Object.keys(alerts.data)));

    // ---- Session persistence baseline ----
    const keepAlive = await call('/api/auth/me', { token: owner });
    check('token works before restart', keepAlive.status === 200, `status=${keepAlive.status}`);

    // Print the token AND some markers so the operator can pass it through env
    // for phase 2. We also stash it via a sentinel purchase note so it survives
    // simply by being printed. The operator passes RESTART_TOKEN=<token>.
    console.log('\n>>> RESTART-SERVER-NOW <<<');
    console.log('   - Stop the node server (Ctrl+C or kill).');
    console.log('   - Restart it: PORT=3001 node server/dev.js');
    console.log('   - Then run: AUDIT_MODE=phase2 RESTART_TOKEN=' + owner + ' node server/test-audit.js');
    console.log('   (staff token for reference: ' + staff + ')');
    printResults();
    return;
  }

  if (MODE === 'phase2') {
    console.log('\n>>> AUDIT PHASE 2 — session survived restart + re-verify gaps');
    const owner = process.env.RESTART_TOKEN;
    if (!owner) {
      console.error('RESTART_TOKEN env var required for phase2');
      process.exit(2);
    }

    // ---- THE KEY TEST: does the same token still work after server restart? ----
    const after = await call('/api/auth/me', { token: owner });
    check('DATABASE-BACKED SESSION: same token works after server restart', after.status === 200, `status=${after.status} body=${JSON.stringify(after.data)}`);
    check('session is bound to correct user (owner)', after.data && after.data.username === 'owner', JSON.stringify(after.data));

    // Re-verify a protected endpoint with the surviving token — proves it isn't
    // a fluke and the user object is fully attached (req.user.id, role).
    const listP = await call('/api/purchases', { token: owner });
    check('protected endpoint works with surviving token', listP.status === 200, `status=${listP.status}`);

    // A freshly-issued token should ALSO work (login still functions post-restart)
    const fresh = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner123' } });
    check('fresh login still works after restart', fresh.status === 200 && !!fresh.data.token, JSON.stringify(fresh.data));

    printResults();
    return;
  }

  console.error('Unknown AUDIT_MODE:', MODE, '(use phase1 or phase2)');
  process.exit(2);
})().catch((e) => {
  console.error('Unhandled error:', e);
  process.exit(2);
});

function printResults() {
  console.log('\n=== audit results ===');
  results.forEach((r) => console.log(r));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
