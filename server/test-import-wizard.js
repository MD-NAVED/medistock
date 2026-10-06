/**
 * Automated Test Suite: Excel/CSV Import Wizard
 * Verifies:
 * 1. MM/YYYY and pharma month formats normalize to month-end dates (12/2027 -> 2027-12-31)
 * 2. Leap year Feb 2024 (29th) vs non-leap Feb 2025 (28th)
 * 3. MM-YYYY, MMM-YYYY, MM/YY formats all normalize to month-end
 * 4. Trailing empty rows are silently ignored (not counted as skipped/errors)
 * 5. Invalid rows with missing medicine name are skipped WITH clear reason
 * 6. Full end-to-end Marg ERP messy-header file import -> DB medicines + batches
 */
const XLSX = require('xlsx');

const RAW_BASE = process.env.BASE || 'http://localhost:3001';
const { hostname: BASE_HOST } = new URL(RAW_BASE);
if (BASE_HOST !== 'localhost' && BASE_HOST !== '127.0.0.1') {
  console.error('BASE must point at localhost');
  process.exit(1);
}
const BASE = RAW_BASE;

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
  console.log('\n=== Excel / CSV Import Wizard Test Suite ===');

  // 1. Auth as owner
  const login = await call('/api/auth/login', {
    method: 'POST',
    body: { username: 'owner', password: 'owner123' },
  });
  check('owner login works', login.status === 200 && !!login.data?.token);
  const token = login.data?.token;

  // 2. Build a messy Marg-style workbook with shuffled columns, rupee symbols, trailing blanks
  const wsData = [
    // Marg-style shuffled headers
    ['EXP DATE', 'QTY', 'M.R.P.', 'ITEM NAME', 'BATCH NO', 'PURCH RATE', 'COMPANY'],
    // Row 1: MM/YYYY format + rupee signs
    ['12/2027', '500', '₹2.00', 'Dolo 650mg MargTest', 'DL2451', '₹1.30', 'Micro Labs MargTest'],
    // Row 2: 05/2026 format + rupee signs
    ['05/2026', '24', '₹125.00', 'Ascoril LS Syrup MargTest', 'AS118', '₹98.00', 'Glenmark MargTest'],
    // Row 3: Aug-2027 (MMM-YYYY) format
    ['Aug-2027', '100', '50.00', 'Azithral 500 MargTest', 'AZ991', '35.00', 'Alembic MargTest'],
    // Row 4: 12/27 (MM/YY) format
    ['12/27', '60', '80.00', 'Pantocid 40 MargTest', 'PN401', '60.00', 'Sun Pharma MargTest'],
    // Row 5: 02/2024 leap year (Feb 29)
    ['02/2024', '10', '20.00', 'Leap Year Med MargTest', 'LP24', '15.00', 'Test Labs'],
    // Row 6: 02/2025 non-leap year (Feb 28)
    ['02/2025', '10', '20.00', 'NonLeap Year Med MargTest', 'NLP25', '15.00', 'Test Labs'],
    // Row 7: Genuinely invalid row (missing medicine name, but has company/batch)
    ['10/2027', '15', '45.00', '', 'INV99', '30.00', 'Orphan Co'],
    // Trailing completely empty rows (common in Excel exports)
    ['', '', '', '', '', '', ''],
    ['', '', '', '', '', '', ''],
    ['   ', '  ', '', '  ', '', '', ''],
  ];

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'MargExport');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const file_base64 = buf.toString('base64');

  // 3. Test POST /api/import/parse
  const parseRes = await call('/api/import/parse', {
    method: 'POST',
    token,
    body: { file_base64 },
  });

  check('POST /api/import/parse returns 200', parseRes.status === 200, JSON.stringify(parseRes.data));
  check('parse returns correct sheet name', parseRes.data?.sheet === 'MargExport');
  check('parse returns 7 headers', parseRes.data?.headers?.length === 7);

  // Trailing empty rows must not be parsed as real rows
  const parsedRows = parseRes.data?.rows || [];
  check('trailing blank rows silently omitted from parsed rows', parsedRows.length === 7, `got ${parsedRows.length} rows`);

  // 4. Test column mapping emulation
  const headers = parseRes.data?.headers || [];
  const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');
  const findCol = (patterns) => {
    for (const p of patterns) {
      const idx = headers.findIndex((h) => norm(h) === p || norm(h).includes(p));
      if (idx !== -1) return headers[idx];
    }
    return '';
  };

  const mapping = {
    name: findCol(['name', 'itemname']),
    company: findCol(['company']),
    sell_price: findCol(['mrp', 'sellprice', 'price']),
    batch_no: findCol(['batch', 'batchno']),
    expiry_date: findCol(['expiry', 'expdate', 'exp']),
    quantity: findCol(['qty', 'quantity', 'stock']),
    buy_price: findCol(['ptr', 'purchaseprice', 'purchaserate', 'purchrate', 'buyprice']),
  };

  check('Marg ITEM NAME maps to name', mapping.name === 'ITEM NAME', mapping.name);
  check('Marg M.R.P. maps to sell_price', mapping.sell_price === 'M.R.P.', mapping.sell_price);
  check('Marg EXP DATE maps to expiry_date', mapping.expiry_date === 'EXP DATE', mapping.expiry_date);
  check('Marg BATCH NO maps to batch_no', mapping.batch_no === 'BATCH NO', mapping.batch_no);
  check('Marg QTY maps to quantity', mapping.quantity === 'QTY', mapping.quantity);
  check('Marg PURCH RATE maps to buy_price', mapping.buy_price === 'PURCH RATE', mapping.buy_price);

  // 5. Test client-side row building + empty row guard
  const mappedRows = parsedRows.map((raw) => ({
    i: raw.i,
    name: String(raw.cells[mapping.name] || '').trim(),
    company: String(raw.cells[mapping.company] || '').trim(),
    sell_price: String(raw.cells[mapping.sell_price] || '').trim(),
    batch_no: String(raw.cells[mapping.batch_no] || '').trim(),
    expiry_date: String(raw.cells[mapping.expiry_date] || '').trim(),
    quantity: String(raw.cells[mapping.quantity] || '').trim(),
    buy_price: String(raw.cells[mapping.buy_price] || '').trim(),
  })).filter((r) => {
    // Silent empty row guard
    return Boolean(
      r.name || r.company || r.sell_price || r.batch_no ||
      r.expiry_date || r.quantity || r.buy_price
    );
  });

  check('empty-row guard filters completely blank rows', mappedRows.length === 7);

  // 6. Test POST /api/import/commit
  const commitRes = await call('/api/import/commit', {
    method: 'POST',
    token,
    body: { rows: mappedRows },
  });

  check('POST /api/import/commit returns 200', commitRes.status === 200, JSON.stringify(commitRes.data));
  const summary = commitRes.data || {};
  check('6 valid medicines created', summary.created >= 6, `created: ${summary.created}`);
  check('6 batches added with valid expiry', summary.batches_added >= 6, `batches_added: ${summary.batches_added}`);
  check('0 stock skipped due to unreadable expiry', summary.stock_skipped === 0, `stock_skipped: ${summary.stock_skipped}`);

  // 7. Verify invalid row skipped WITH explicit reason
  const skippedList = summary.skipped || [];
  const missingNameSkipped = skippedList.find((s) => s.reason === 'Medicine name missing');
  check('row with missing medicine name is skipped WITH reason', !!missingNameSkipped, JSON.stringify(skippedList));

  // 8. Verify database records for the imported medicines & batches
  const doloLookup = await call('/api/medicines?q=Dolo%20650mg%20MargTest', { token });
  const doloMed = (doloLookup.data || []).find((m) => m.name === 'Dolo 650mg MargTest');
  check('Dolo 650mg exists in medicines catalog', !!doloMed);
  check('Dolo 650mg MRP is 2.00', doloMed?.sell_price === 2);
  check('Dolo 650mg buy_price is 1.30', doloMed?.buy_price === 1.3);

  if (doloMed) {
    const batches = await call(`/api/medicines/${doloMed.id}/batches`, { token });
    const batchDL = (batches.data || []).find((b) => b.batch_number === 'DL2451');
    check('batch DL2451 exists in batches table', !!batchDL);
    check('batch DL2451 has quantity 500', batchDL?.quantity === 500);
    // CRITICAL: 12/2027 MUST normalize to 2027-12-31 (month-end)
    const dlExpiry = String(batchDL?.expiry_date || '').slice(0, 10);
    check('MM/YYYY 12/2027 normalized to 2027-12-31 (month-end)', dlExpiry === '2027-12-31', `got ${dlExpiry}`);
  }

  const ascorilLookup = await call('/api/medicines?q=Ascoril%20LS%20Syrup%20MargTest', { token });
  const ascorilMed = (ascorilLookup.data || []).find((m) => m.name === 'Ascoril LS Syrup MargTest');
  check('Ascoril LS exists in medicines catalog', !!ascorilMed);
  if (ascorilMed) {
    const batches = await call(`/api/medicines/${ascorilMed.id}/batches`, { token });
    const batchAS = (batches.data || []).find((b) => b.batch_number === 'AS118');
    check('batch AS118 has quantity 24', batchAS?.quantity === 24);
    // CRITICAL: 05/2026 MUST normalize to 2026-05-31 (month-end)
    const asExpiry = String(batchAS?.expiry_date || '').slice(0, 10);
    check('MM/YYYY 05/2026 normalized to 2026-05-31 (month-end)', asExpiry === '2026-05-31', `got ${asExpiry}`);
  }

  const azithralLookup = await call('/api/medicines?q=Azithral%20500%20MargTest', { token });
  const azithralMed = (azithralLookup.data || []).find((m) => m.name === 'Azithral 500 MargTest');
  if (azithralMed) {
    const batches = await call(`/api/medicines/${azithralMed.id}/batches`, { token });
    const batchAZ = (batches.data || []).find((b) => b.batch_number === 'AZ991');
    // CRITICAL: Aug-2027 MUST normalize to 2027-08-31
    const azExpiry = String(batchAZ?.expiry_date || '').slice(0, 10);
    check('MMM-YYYY Aug-2027 normalized to 2027-08-31 (month-end)', azExpiry === '2027-08-31', `got ${azExpiry}`);
  }

  const pantoLookup = await call('/api/medicines?q=Pantocid%2040%20MargTest', { token });
  const pantoMed = (pantoLookup.data || []).find((m) => m.name === 'Pantocid 40 MargTest');
  if (pantoMed) {
    const batches = await call(`/api/medicines/${pantoMed.id}/batches`, { token });
    const batchPN = (batches.data || []).find((b) => b.batch_number === 'PN401');
    // CRITICAL: 12/27 MUST normalize to 2027-12-31
    const pnExpiry = String(batchPN?.expiry_date || '').slice(0, 10);
    check('MM/YY 12/27 normalized to 2027-12-31 (month-end)', pnExpiry === '2027-12-31', `got ${pnExpiry}`);
  }

  const leapLookup = await call('/api/medicines?q=Leap%20Year%20Med%20MargTest', { token });
  const leapMed = (leapLookup.data || []).find((m) => m.name === 'Leap Year Med MargTest');
  if (leapMed) {
    const batches = await call(`/api/medicines/${leapMed.id}/batches`, { token });
    const batchLP = (batches.data || []).find((b) => b.batch_number === 'LP24');
    // Leap year Feb 2024 -> 2024-02-29
    const lpExpiry = String(batchLP?.expiry_date || '').slice(0, 10);
    check('Leap year 02/2024 normalized to 2024-02-29 (month-end)', lpExpiry === '2024-02-29', `got ${lpExpiry}`);
  }

  const nonLeapLookup = await call('/api/medicines?q=NonLeap%20Year%20Med%20MargTest', { token });
  const nonLeapMed = (nonLeapLookup.data || []).find((m) => m.name === 'NonLeap Year Med MargTest');
  if (nonLeapMed) {
    const batches = await call(`/api/medicines/${nonLeapMed.id}/batches`, { token });
    const batchNLP = (batches.data || []).find((b) => b.batch_number === 'NLP25');
    // Non-leap year Feb 2025 -> 2025-02-28
    const nlpExpiry = String(batchNLP?.expiry_date || '').slice(0, 10);
    check('Non-leap year 02/2025 normalized to 2025-02-28 (month-end)', nlpExpiry === '2025-02-28', `got ${nlpExpiry}`);
  }

  // Print results
  console.log(results.join('\n'));
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('Test crashed:', err);
  process.exit(1);
});
