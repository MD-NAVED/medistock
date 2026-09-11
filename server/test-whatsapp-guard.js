/**
 * Task 5 WhatsApp URL Length Guard & Timing-Safe Token Test Suite
 */
const { buildWhatsAppMessage } = require('../client/src/utils/whatsapp');

let passed = 0;
let failed = 0;

function check(label, pass, extra = '') {
  if (pass) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${extra ? ' -> ' + extra : ''}`);
    process.exitCode = 1;
  }
}

(async () => {
  console.log('\n=== Task 5: WhatsApp URL Length Guard & Timing-Safe Token Tests ===');

  const baseUrl = 'https://medistock-pharma.vercel.app';
  const dummyToken = 'a1b2c3d4e5f6a1b2c3d4e5f6';

  // 1. Short Bill Test (3 line items) -> Full detailed template
  const shortInvoice = {
    sale: {
      id: 101,
      invoice_number: 'INV-20260911-0001',
      customer_name: 'Rahul Sharma',
      customer_phone: '9876543210',
      subtotal: 450.00,
      gst_amount: 54.00,
      total: 504.00,
      created_at: '2026-09-11 14:30:00',
      share_token: dummyToken,
    },
    items: [
      { medicine_name: 'Paracetamol 500mg', quantity: 2, line_total: 60.00 },
      { medicine_name: 'Amoxicillin 250mg', quantity: 1, line_total: 140.00 },
      { medicine_name: 'Cetirizine 10mg', quantity: 3, line_total: 250.00 },
    ],
  };

  const shortResult = buildWhatsAppMessage(shortInvoice, 'MediStock Apollo Pharmacy', baseUrl);
  check('short bill uses full detailed template', shortResult.isFallback === false);
  check('short bill URL length is safe (< 1800 chars)', shortResult.length <= 1800, `length=${shortResult.length}`);
  check('short bill contains individual item line', shortResult.url.includes(encodeURIComponent('Paracetamol 500mg')));

  // 2. Large Bill Test (15 line items) -> Concise fallback template
  const largeInvoice = {
    sale: {
      id: 102,
      invoice_number: 'INV-20260911-0002',
      customer_name: 'Suresh Verma',
      customer_phone: '9876543211',
      subtotal: 5800.00,
      gst_amount: 696.00,
      total: 6496.00,
      created_at: '2026-09-11 15:45:00',
      share_token: dummyToken,
    },
    items: Array.from({ length: 25 }, (_, i) => ({
      medicine_name: `Very Long Pharmaceutical Medicine Formulation ${i + 1} with Extended Release Formula 500mg`,
      quantity: 2 + (i % 5),
      line_total: (120 + i * 15).toFixed(2),
    })),
  };

  const largeResult = buildWhatsAppMessage(largeInvoice, 'MediStock Apollo Super Specialty Pharmacy Lucknow', baseUrl);
  check('large bill triggers fallback template (> 1800 chars guard)', largeResult.isFallback === true);
  check('large bill URL length is strictly <= 1800 chars', largeResult.length <= 1800, `length=${largeResult.length}`);
  check('large bill fallback includes "Poora bill PDF mein"', largeResult.url.includes(encodeURIComponent('Poora bill PDF mein:')));
  check('large bill fallback includes direct PDF url', largeResult.url.includes(encodeURIComponent(`/api/public/invoice/102/pdf?t=${dummyToken}`)));

  // 3. Property Test: Emits <= 1800 chars for any bill size from 1 to 40 items
  console.log('  Testing property test: 1 to 40 line items all stay <= 1800 encoded chars...');
  let maxObservedLength = 0;
  let allUnder1800 = true;

  for (let itemCount = 1; itemCount <= 40; itemCount++) {
    const testInvoice = {
      sale: {
        id: 200 + itemCount,
        invoice_number: `INV-20260911-00${itemCount}`,
        customer_name: 'Customer Name ' + itemCount,
        customer_phone: '9876500000',
        subtotal: 1000 * itemCount,
        gst_amount: 120 * itemCount,
        total: 1120 * itemCount,
        created_at: '2026-09-11 18:00:00',
        share_token: dummyToken,
      },
      items: Array.from({ length: itemCount }, (_, i) => ({
        medicine_name: `Generic Medicine Name ${i + 1} 100mg Strip of 10 Capsules`,
        quantity: i + 1,
        line_total: (100 * (i + 1)).toFixed(2),
      })),
    };

    const res = buildWhatsAppMessage(testInvoice, 'MediStock Pharmacy Store Lucknow Super Outlet', baseUrl);
    if (res.length > maxObservedLength) {
      maxObservedLength = res.length;
    }
    if (res.length > 1800) {
      allUnder1800 = false;
      console.error(`Item count ${itemCount} exceeded limit with length ${res.length}`);
    }
  }

  check('property test passed: bill sizes 1-40 never exceed 1800 chars', allUnder1800, `peak length=${maxObservedLength}`);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0 || process.exitCode) {
    process.exit(1);
  }
})();
