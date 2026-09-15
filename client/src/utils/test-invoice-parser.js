import { scoreMedicineMatches, parseInvoiceText } from './invoiceParser.js';

let pass = 0, fail = 0;
function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  }
}

const mockMedicines = [
  { id: 101, name: 'Paracetamol 650mg', company: 'Cipla Ltd', buy_price: 15.5 },
  { id: 102, name: 'Paracetamol 500mg', company: 'Sun Pharma', buy_price: 12.0 },
  { id: 103, name: 'Amoxicillin 500mg', company: 'Cipla Ltd', buy_price: 45.0 },
  { id: 104, name: 'Azithromycin 250mg', company: 'Cipla Ltd', buy_price: 60.0 },
];

console.log('\n=== Running invoiceParser safeguards tests ===');

// 1. High confidence match
const highRes = scoreMedicineMatches('PARACETAMOL 650MG CIPLA', mockMedicines);
check('high confidence match identified', highRes.isConfident === true && highRes.topMatch?.id === 101);

// 2. Ambiguous match (low confidence with candidate list)
const ambigRes = scoreMedicineMatches('PARACETAMOL TAB', mockMedicines);
check('ambiguous match not marked confident', ambigRes.isConfident === false);
check('ambiguous match returns candidate list', ambigRes.candidates.length >= 2);

// 3. No match
const noMatch = scoreMedicineMatches('RANDOM WIDGET ABC', mockMedicines);
check('unknown text returns no match', noMatch.topMatch === null && noMatch.candidates.length === 0);

// 4. Parser eliminates silent defaults
const sampleText = `
TAX INVOICE
Distributor: Shree Balaji Pharma
Inv No: INV-2026-991
Date: 12/04/2026

Paracetamol 650mg Cipla B.No: B7789 Exp: 08/28 Qty: 50 Rate: 14.50
UnknownMedicineXYZ B.No: UNK123 Exp: 11/27 Qty: 20 Rate: 99.00
IncompleteLineOnlyBatch B.No: INCBAT99
`;

const parsed = parseInvoiceText(sampleText, mockMedicines);

check('extracted invoice number correctly', parsed.invoice_number === 'INV-2026-991');
check('extracted supplier name correctly', parsed.supplier_name.includes('Shree Balaji Pharma'));
check('extracted date correctly normalized', parsed.date === '2026-04-12');
check('parsed 3 line items', parsed.items.length === 3);

// Verify item 1: Confident item
const it1 = parsed.items[0];
check('item 1 matched medicine 101', it1.medicine_id === 101);
check('item 1 batch is B7789', it1.batch_number === 'B7789');
check('item 1 expiry normalized to month end', it1.expiry_date === '2028-08-28');
check('item 1 quantity is 50', it1.quantity === '50');
check('item 1 price is 14.5', it1.buy_price === '14.5');

// Verify item 2: Unmatched medicine has NO silent fallback
const it2 = parsed.items[1];
check('unmatched item has empty medicine_id (no silent fallback)', it2.medicine_id === '');
check('unmatched item batch preserved', it2.batch_number === 'UNK123');
check('unmatched item expiry normalized', it2.expiry_date === '2027-11-28');
check('unmatched item quantity extracted', it2.quantity === '20');
check('unmatched item price extracted', it2.buy_price === '99');

// Verify item 3: Incomplete line has empty quantity, price, expiry
const it3 = parsed.items[2];
check('incomplete item has empty medicine_id', it3.medicine_id === '');
check('incomplete item has empty expiry (not defaulted to 2027-12-31)', it3.expiry_date === '');
check('incomplete item has empty quantity (not defaulted to 10)', it3.quantity === '');
check('incomplete item has empty buy_price (not defaulted to 0)', it3.buy_price === '');
check('incomplete item batch preserved', it3.batch_number === 'INCBAT99');

console.log(`\nParser tests: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
