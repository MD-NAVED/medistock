import PDFDocument from 'pdfkit';
import { loadPdfDocument, parseInvoicePDF, PINNED_PDFJS_VERSION } from './pdfProcessor.js';
import { parseInvoiceFile } from './invoiceParser.js';

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

function makePdf(buildFn, options = {}) {
  return new Promise((resolve) => {
    const doc = new PDFDocument(options);
    const buffers = [];
    doc.on('data', (d) => buffers.push(d));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    buildFn(doc);
    doc.end();
  });
}

const mockMedicines = [
  { id: 101, name: 'Paracetamol 650mg', company: 'Cipla Ltd', buy_price: 15.5 },
  { id: 102, name: 'Amoxicillin 500mg', company: 'Cipla Ltd', buy_price: 45.0 },
  { id: 103, name: 'Azithromycin 250mg', company: 'Cipla Ltd', buy_price: 60.0 },
];

(async () => {
  console.log('\n=== Running PDF Processor & Pipeline Tests ===\n');

  // 1. Verify Worker Version Pinning
  check('worker version is pinned to exact 4.10.38', PINNED_PDFJS_VERSION === '4.10.38');

  // 2. Single-Page PDF Test
  const singlePdfBuffer = await makePdf((doc) => {
    doc.fontSize(16).text('TAX INVOICE');
    doc.fontSize(12).text('Distributor: Shree Balaji Pharma');
    doc.text('Inv No: INV-SINGLE-01');
    doc.text('Date: 15/09/2026');
    doc.text('Paracetamol 650mg Cipla B.No: BATCH-S1 Exp: 12/28 Qty: 40 Rate: 15.50');
  });

  const singleDoc = await loadPdfDocument(singlePdfBuffer);
  check('single-page PDF loaded successfully', singleDoc && singleDoc.numPages === 1);

  // Extract text from page 1 using pdf.js textContent
  const page1 = await singleDoc.getPage(1);
  const textContent1 = await page1.getTextContent();
  const rawStrings1 = textContent1.items.map((it) => it.str).join(' ');
  check('page 1 text content extracted', rawStrings1.includes('Shree Balaji Pharma') && rawStrings1.includes('INV-SINGLE-01'));

  // 3. Multi-Page PDF Test (3 pages)
  const multiPdfBuffer = await makePdf((doc) => {
    // Page 1
    doc.fontSize(16).text('TAX INVOICE (Page 1)');
    doc.fontSize(12).text('Distributor: Metro Pharma Distributors');
    doc.text('Inv No: INV-MULTI-99');
    doc.text('Date: 10/09/2026');
    doc.text('Amoxicillin 500mg Cipla B.No: AMX-P1 Exp: 06/28 Qty: 25 Rate: 45.00');

    // Page 2
    doc.addPage();
    doc.fontSize(16).text('TAX INVOICE (Page 2 - Continued)');
    doc.fontSize(12).text('Azithromycin 250mg Cipla B.No: AZI-P2 Exp: 10/28 Qty: 15 Rate: 60.00');

    // Page 3
    doc.addPage();
    doc.fontSize(14).text('Summary & Bank Details');
    doc.fontSize(12).text('Subtotal: Rs. 2025.00 | Grand Total: Rs. 2025.00');
  });

  const multiDoc = await loadPdfDocument(multiPdfBuffer);
  check('multi-page PDF has exactly 3 pages', multiDoc && multiDoc.numPages === 3);

  // Verify texts across all pages merge properly
  const p1 = await multiDoc.getPage(1);
  const p2 = await multiDoc.getPage(2);
  const p3 = await multiDoc.getPage(3);
  const t1 = (await p1.getTextContent()).items.map((it) => it.str).join(' ');
  const t2 = (await p2.getTextContent()).items.map((it) => it.str).join(' ');
  const t3 = (await p3.getTextContent()).items.map((it) => it.str).join(' ');
  const mergedMultiText = [t1, t2, t3].join('\n--- PAGE BREAK ---\n');

  check('merged multi-page text contains page 1 medicine (Amoxicillin)', mergedMultiText.includes('Amoxicillin'));
  check('merged multi-page text contains page 2 medicine (Azithromycin)', mergedMultiText.includes('Azithromycin'));

  // Parse merged multi-page invoice text with parseInvoiceText
  const { parseInvoiceText } = await import('./invoiceParser.js');
  const multiParsed = parseInvoiceText(mergedMultiText, mockMedicines);
  check('multi-page invoice number extracted', multiParsed.invoice_number === 'INV-MULTI-99');
  check('multi-page extracted items from BOTH pages', multiParsed.items.length === 2);
  check('item 1 is Amoxicillin from page 1', multiParsed.items[0]?.batch_number === 'AMX-P1');
  check('item 2 is Azithromycin from page 2', multiParsed.items[1]?.batch_number === 'AZI-P2');

  // 4. Over 10 Pages Rejection Test (>10 pages)
  const elevenPdfBuffer = await makePdf((doc) => {
    for (let i = 1; i <= 11; i++) {
      if (i > 1) doc.addPage();
      doc.text(`Invoice Page ${i}`);
    }
  });

  const elevenDoc = await loadPdfDocument(elevenPdfBuffer);
  check('11-page PDF generated with 11 pages', elevenDoc.numPages === 11);

  let pageLimitError = null;
  try {
    await parseInvoicePDF(elevenPdfBuffer, mockMedicines);
  } catch (err) {
    pageLimitError = err;
  }
  check('invoice > 10 pages throws rejection error', !!pageLimitError);
  check('rejection message specifies 10 page limit', /maximum 10 pages/i.test(pageLimitError?.message || ''));

  // 5. Encrypted / Password-Protected PDF Test
  const encryptedPdfBuffer = await makePdf((doc) => {
    doc.text('Secret Invoice Details');
  }, { userPassword: 'chemist_password_123' });

  let encryptedError = null;
  try {
    await loadPdfDocument(encryptedPdfBuffer);
  } catch (err) {
    encryptedError = err;
  }
  check('encrypted PDF throws error', !!encryptedError);
  check('encrypted PDF presents friendly Hinglish message',
    /Ye PDF password-protected hai — unlock karke try karo/i.test(encryptedError?.message || ''));

  // 6. Test parseInvoiceFile unified routing
  const fakePdfFile = { name: 'bill.pdf', type: 'application/pdf', arrayBuffer: () => elevenPdfBuffer };
  let routeError = null;
  try {
    await parseInvoiceFile(fakePdfFile, mockMedicines);
  } catch (err) {
    routeError = err;
  }
  check('parseInvoiceFile correctly routes .pdf to PDF handler',
    /maximum 10 pages/i.test(routeError?.message || ''));

  console.log(`\nPDF Tests Summary: ${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
})();
