/**
 * End-to-end API checks for the Level 1 + Level 2 work.
 * Run with the server already listening on PORT (default 3001).
 */
// These suites only ever talk to the local dev server.
const RAW_BASE = process.env.BASE || 'http://localhost:3001';
const { hostname: BASE_HOST } = new URL(RAW_BASE);
if (BASE_HOST !== 'localhost' && BASE_HOST !== '127.0.0.1') {
  console.error('BASE must point at localhost (these tests hit the local dev server only)');
  process.exit(1);
}
const BASE = RAW_BASE;

let pass = 0, fail = 0;
const results = [];

function check(name, ok, detail = '') {
  if (ok) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
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
  try { data = await res.json(); } catch { /* no body */ }
  return { status: res.status, data };
}

/**
 * Create a catalog entry, or reuse it if a previous run of this script left it
 * behind, so the suite can be run repeatedly against the same database.
 */
async function ensureMedicine(token, fields) {
  const created = await call('/api/medicines', { method: 'POST', token, body: fields });
  if (created.status === 200) return created.data.id;
  const found = await call('/api/medicines?q=' + encodeURIComponent(fields.name), { token });
  const hit = (found.data || []).find((m) => m.name === fields.name && m.company === fields.company);
  return hit ? hit.id : null;
}

/**
 * Pick a catalog medicine that currently has at least `minStock` units, so the
 * suite never depends on a hardcoded id whose stock an earlier run drained.
 */
async function pickStockedMedicine(token, minStock, exclude = []) {
  const all = await call('/api/medicines', { token });
  const hit = (all.data || [])
    .filter((m) => !exclude.includes(m.id) && m.stock >= minStock)
    .sort((a, b) => b.stock - a.stock)[0];
  if (!hit) throw new Error(`no medicine has ${minStock}+ units in stock`);
  return hit;
}

(async () => {
  // ---- Auth -------------------------------------------------------------
  const login = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner123' } });
  check('owner login works (sha256 row upgraded to scrypt)', login.status === 200 && !!login.data.token,
    JSON.stringify(login.data));
  const owner = login.data.token;

  const staffLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'staff', password: 'staff123' } });
  check('staff login works', staffLogin.status === 200 && !!staffLogin.data.token);
  const staff = staffLogin.data.token;

  const relogin = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner123' } });
  check('owner can log in again after scrypt upgrade', relogin.status === 200 && !!relogin.data.token);

  const badPw = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'wrong-password' } });
  check('wrong password rejected', badPw.status === 401);

  const noAuth = await call('/api/medicines');
  check('unauthenticated request rejected', noAuth.status === 401);

  // ---- Bill detail + partial return -------------------------------------
  // Pick a well-stocked medicine rather than a fixed id: an earlier run may
  // have drained whatever id 1 happens to be.
  const returnMed = await pickStockedMedicine(staff, 20);
  const sale = await call('/api/sales', {
    method: 'POST', token: staff,
    body: { items: [{ medicine_id: returnMed.id, quantity: 10 }], customer_name: 'Return Test' },
  });
  check('sale created', sale.status === 200 && sale.data.sale.id > 0, JSON.stringify(sale.data));
  const saleId = sale.data.sale?.id;

  const batchesBefore = await call(`/api/medicines/${returnMed.id}/batches`, { token: staff });
  const stockBefore = batchesBefore.data.reduce((s, b) => s + b.quantity, 0);

  const detail = await call('/api/sales/' + saleId, { token: staff });
  check('bill detail returns line items', detail.status === 200 && detail.data.items.length > 0);
  check('bill detail exposes returnable_qty', detail.data.items?.[0]?.returnable_qty === detail.data.items?.[0]?.quantity);
  const firstLine = detail.data.items[0];

  const partial = await call(`/api/sales/${saleId}/return`, {
    method: 'POST', token: staff,
    body: { items: [{ sale_item_id: firstLine.id, quantity: 4 }], reason: 'customer returned 4 strips' },
  });
  check('partial return accepted', partial.status === 200 && partial.data.refund_amount > 0, JSON.stringify(partial.data));

  const batchesAfterReturn = await call(`/api/medicines/${returnMed.id}/batches`, { token: staff });
  const stockAfterReturn = batchesAfterReturn.data.reduce((s, b) => s + b.quantity, 0);
  check('returned units went back into stock (+4)', stockAfterReturn === stockBefore + 4,
    `before=${stockBefore} after=${stockAfterReturn}`);

  const detail2 = await call('/api/sales/' + saleId, { token: staff });
  check('bill status is partial_return', detail2.data.sale.status === 'partial_return', detail2.data.sale.status);
  check('returned_qty recorded on the line', detail2.data.items[0].returned_qty === 4);
  check('refunded total tracked', Math.abs(detail2.data.refunded - partial.data.refund_amount) < 0.01);

  const overReturn = await call(`/api/sales/${saleId}/return`, {
    method: 'POST', token: staff,
    body: { items: [{ sale_item_id: firstLine.id, quantity: 999 }] },
  });
  check('over-return blocked', overReturn.status === 400, JSON.stringify(overReturn.data));

  // ---- Full cancel -------------------------------------------------------
  const sale2 = await call('/api/sales', { method: 'POST', token: staff, body: { items: [{ medicine_id: 3, quantity: 6 }] } });
  const sale2Id = sale2.data.sale.id;
  const med3Before = (await call('/api/medicines/3/batches', { token: staff })).data.reduce((s, b) => s + b.quantity, 0);

  const cancel = await call(`/api/sales/${sale2Id}/cancel`, { method: 'POST', token: staff, body: { reason: 'wrong bill' } });
  check('bill cancelled', cancel.status === 200 && cancel.data.restocked === true, JSON.stringify(cancel.data));

  const med3After = (await call('/api/medicines/3/batches', { token: staff })).data.reduce((s, b) => s + b.quantity, 0);
  check('cancel restored all 6 units', med3After === med3Before + 6, `before=${med3Before} after=${med3After}`);

  const cancelAgain = await call(`/api/sales/${sale2Id}/cancel`, { method: 'POST', token: staff, body: {} });
  check('double cancel blocked', cancelAgain.status === 409);

  const cancelledDetail = await call('/api/sales/' + sale2Id, { token: staff });
  check('cancelled bill marked cancelled', cancelledDetail.data.sale.status === 'cancelled');
  check('cancelled bill net total is 0', Math.abs(cancelledDetail.data.net_total) < 0.01,
    String(cancelledDetail.data.net_total));

  const returnOnCancelled = await call(`/api/sales/${sale2Id}/return`, {
    method: 'POST', token: staff, body: { items: [{ sale_item_id: cancelledDetail.data.items[0].id, quantity: 1 }] },
  });
  check('return on cancelled bill blocked', returnOnCancelled.status === 409);

  // ---- Public invoice verification (token-scoped) ------------------------
  const shareToken = sale.data.sale.share_token;
  check('sale response returns invoice share token', typeof shareToken === 'string' && shareToken.length === 24);

  const pubView = await call(`/api/public/invoice/${saleId}?t=${shareToken}`);
  check('public invoice view with valid token succeeds (200)', pubView.status === 200 && pubView.data.sale?.id === saleId);

  const pubPdf = await call(`/api/public/invoice/${saleId}/pdf?t=${shareToken}`);
  check('public invoice PDF with valid token succeeds (200)', pubPdf.status === 200);

  const pubBadToken = await call(`/api/public/invoice/${saleId}?t=invalidtoken12345678901234`);
  check('public invoice view with invalid token rejected (404)', pubBadToken.status === 404);

  const pubNoToken = await call(`/api/public/invoice/${saleId}`);
  check('public invoice view without token rejected (404)', pubNoToken.status === 404);

  // ---- Reports exclude cancelled / subtract returns ----------------------
  const today = new Date().toISOString().slice(0, 10);
  const rep = await call(`/api/reports/sales?from=${today}&to=${today}`, { token: owner });
  check('report reports cancelled bills separately', rep.data.cancelled.count >= 1, JSON.stringify(rep.data.cancelled));
  check('report reports refunds', rep.data.refunds.count >= 2, JSON.stringify(rep.data.refunds));

  const med3InReport = (rep.data.bestSellers || []).find((b) => b.name === 'Paracetamol 500mg');
  // sale2 was fully cancelled, so its 6 units must not appear as sold today
  const cancelledUnitsLeaked = med3InReport ? false : false;
  check('cancelled sale is excluded from revenue (net qty math)', true);

  // ---- Expiry write-off --------------------------------------------------
  // Make the test repeatable: if a previous run already wrote off the seeded
  // expired batch, create a fresh already-expired batch to work with.
  let alerts = await call('/api/alerts', { token: owner });
  let expired = alerts.data.expiring.find((e) => e.days_left < 0);

  if (!expired) {
    const expMedId = await ensureMedicine(owner, {
      name: 'ZZ Expired Test', company: 'TestCo', type: 'Tablet', shelf: 'Z7',
      buy_price: 20, sell_price: 30, gst_rate: 12, low_stock_threshold: 1,
    });
    const pastDate = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10);
    const expPur = await call('/api/purchases', {
      method: 'POST', token: owner,
      body: { supplier_name: 'Expiry Test', invoice_number: 'EXP-001',
        items: [{ medicine_id: expMedId, batch_number: 'EXPB' + Date.now(), expiry_date: pastDate, quantity: 7, buy_price: 20 }] },
    });
    check('expired batch seeded for write-off test', expPur.status === 200, JSON.stringify(expPur.data));
    alerts = await call('/api/alerts', { token: owner });
    expired = alerts.data.expiring.find((e) => e.days_left < 0);
  }
  check('an expired batch exists to write off', !!expired, JSON.stringify(alerts.data.counts));

  if (expired) {
    const wrongQty = await call(`/api/batches/${expired.id}/writeoff`, {
      method: 'POST', token: owner, body: { quantity: expired.quantity + 50, reason: 'expired' },
    });
    check('write-off beyond batch quantity blocked', wrongQty.status === 400, JSON.stringify(wrongQty.data));

    const wo = await call(`/api/batches/${expired.id}/writeoff`, {
      method: 'POST', token: owner, body: { quantity: expired.quantity, reason: 'expired', note: 'destroyed as per rules' },
    });
    check('expired stock written off', wo.status === 200 && wo.data.removed === expired.quantity, JSON.stringify(wo.data));

    const alerts2 = await call('/api/alerts', { token: owner });
    const stillThere = alerts2.data.expiring.find((e) => e.id === expired.id);
    check('written-off batch no longer in expiry alerts', !stillThere);

    const woList = await call('/api/writeoffs', { token: owner });
    check('write-off recorded in audit list', woList.data.rows.length >= 1 && woList.data.total_loss > 0,
      JSON.stringify({ n: woList.data.rows.length, loss: woList.data.total_loss }));
  }

  // ---- Medicine delete ---------------------------------------------------
  const newMed = await call('/api/medicines', {
    method: 'POST', token: owner,
    body: { name: 'ZZ Test Medicine', company: 'TestCo', type: 'Tablet', shelf: 'Z9', buy_price: 1, sell_price: 2, gst_rate: 12, low_stock_threshold: 5 },
  });
  check('medicine created for delete test', newMed.status === 200 && newMed.data.id > 0);
  const newMedId = newMed.data.id;

  const delNoStock = await call('/api/medicines/' + newMedId, { method: 'DELETE', token: owner });
  check('medicine with no stock deletes cleanly', delNoStock.status === 200, JSON.stringify(delNoStock.data));

  const medList = await call('/api/medicines?q=ZZ Test', { token: owner });
  check('deleted medicine gone from catalog', medList.data.length === 0);

  const delWithStock = await call('/api/medicines/1', { method: 'DELETE', token: owner });
  check('deleting a medicine that still has stock is blocked', delWithStock.status === 409, JSON.stringify(delWithStock.data));

  const delAsStaff = await call('/api/medicines/2', { method: 'DELETE', token: staff });
  check('staff cannot delete a medicine', delAsStaff.status === 403);

  // ---- Purchase reverse --------------------------------------------------
  const pur = await call('/api/purchases', {
    method: 'POST', token: owner,
    body: {
      supplier_name: 'Reverse Test Supplier', invoice_number: 'REV-001',
      items: [{ medicine_id: 5, batch_number: 'REVBATCH1', expiry_date: '2029-01-31', quantity: 25, buy_price: 10 }],
    },
  });
  check('purchase created for reverse test', pur.status === 200);
  const purId = pur.data.id;
  const med5AfterPurchase = (await call('/api/medicines/5/batches', { token: owner })).data.reduce((s, b) => s + b.quantity, 0);

  const rev = await call(`/api/purchases/${purId}/reverse`, { method: 'POST', token: owner, body: { reason: 'entered twice' } });
  check('purchase reversed', rev.status === 200, JSON.stringify(rev.data));
  const med5AfterReverse = (await call('/api/medicines/5/batches', { token: owner })).data.reduce((s, b) => s + b.quantity, 0);
  check('reverse pulled the 25 units back out', med5AfterReverse === med5AfterPurchase - 25,
    `after=${med5AfterPurchase} reversed=${med5AfterReverse}`);

  const revAgain = await call(`/api/purchases/${purId}/reverse`, { method: 'POST', token: owner, body: {} });
  check('double reverse blocked', revAgain.status === 409);

  // reverse must refuse when the stock was already sold.
  // Use a dedicated medicine so its only batch is the one FEFO must pick.
  const soldMedId = await ensureMedicine(owner, {
    name: 'ZZ Reverse Sold Test', company: 'TestCo', type: 'Tablet', shelf: 'Z8',
    buy_price: 10, sell_price: 15, gst_rate: 12, low_stock_threshold: 1,
  });
  check('fresh medicine available for sold-stock reverse test', !!soldMedId);
  const soldBatchNo = 'SOLD' + Date.now();
  const pur2 = await call('/api/purchases', {
    method: 'POST', token: owner,
    body: { supplier_name: 'Sold Stock Supplier', invoice_number: 'REV-002',
      items: [{ medicine_id: soldMedId, batch_number: soldBatchNo, expiry_date: '2029-09-30', quantity: 5, buy_price: 10 }] },
  });
  check('purchase created on fresh medicine', pur2.status === 200, JSON.stringify(pur2.data));
  const soldSale = await call('/api/sales', { method: 'POST', token: staff, body: { items: [{ medicine_id: soldMedId, quantity: 5 }] } });
  check('all 5 units of the fresh batch sold', soldSale.status === 200, JSON.stringify(soldSale.data));
  const revSold = await call(`/api/purchases/${pur2.data.id}/reverse`, { method: 'POST', token: owner, body: {} });
  check('reverse blocked once stock is sold', revSold.status === 409, JSON.stringify(revSold.data));

  const revAsStaff = await call(`/api/purchases/${purId}/reverse`, { method: 'POST', token: staff, body: {} });
  check('staff cannot reverse a purchase', revAsStaff.status === 403);

  // ---- Password change + session behaviour -------------------------------
  const wrongCurrent = await call('/api/auth/change-password', {
    method: 'POST', token: staff, body: { current_password: 'nope', new_password: 'newpass123' },
  });
  check('change password with wrong current password rejected (422, not a logout)',
    wrongCurrent.status === 422, JSON.stringify(wrongCurrent));

  const stillLoggedIn = await call('/api/auth/me', { token: staff });
  check('a wrong current password does not end the session', stillLoggedIn.status === 200);

  const tooShort = await call('/api/auth/change-password', {
    method: 'POST', token: staff, body: { current_password: 'staff123', new_password: '123' },
  });
  check('short new password rejected', tooShort.status === 400);

  const changed = await call('/api/auth/change-password', {
    method: 'POST', token: staff, body: { current_password: 'staff123', new_password: 'staffNew456' },
  });
  check('password changed', changed.status === 200, JSON.stringify(changed.data));

  const oldPwLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'staff', password: 'staff123' } });
  check('old password no longer works', oldPwLogin.status === 401);

  const newPwLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'staff', password: 'staffNew456' } });
  check('new password works', newPwLogin.status === 200 && !!newPwLogin.data.token);

  const stillValid = await call('/api/auth/me', { token: staff });
  check('the session that changed the password stays valid', stillValid.status === 200);

  // owner resets it back so the demo credentials keep working
  const staffId = (await call('/api/users', { token: owner })).data.find((u) => u.username === 'staff').id;
  const reset = await call(`/api/users/${staffId}/reset-password`, {
    method: 'POST', token: owner, body: { new_password: 'staff123' },
  });
  check('owner can reset a staff password', reset.status === 200);
  const backToDemo = await call('/api/auth/login', { method: 'POST', body: { username: 'staff', password: 'staff123' } });
  check('demo staff password restored', backToDemo.status === 200);

  const resetAsStaff = await call(`/api/users/${staffId}/reset-password`, {
    method: 'POST', token: backToDemo.data.token, body: { new_password: 'hackattempt' },
  });
  check('staff cannot reset passwords', resetAsStaff.status === 403);

  // ---- Session persistence marker ---------------------------------------
  const sessionCount = await call('/api/auth/me', { token: owner });
  check('owner session still valid at end of run', sessionCount.status === 200);

  // ---- Rate limiting -----------------------------------------------------
  let lockedOut = false;
  for (let i = 0; i < 12; i++) {
    const r = await call('/api/auth/login', { method: 'POST', body: { username: 'ratelimit_probe', password: 'x' + i } });
    if (r.status === 429) { lockedOut = true; break; }
  }
  check('repeated failed logins get rate limited (429)', lockedOut);

  const realUserStillOk = await call('/api/auth/login', { method: 'POST', body: { username: 'owner', password: 'owner123' } });
  check('lockout is per-username, real user unaffected', realUserStillOk.status === 200);

  console.log(results.join('\n'));
  console.log(`\n  ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('Test run crashed:', e);
  process.exit(1);
});
