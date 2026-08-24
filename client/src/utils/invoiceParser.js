import { createWorker } from 'tesseract.js';

/**
 * Normalizes date strings like "08/28", "12-2027", "15/08/2026" into YYYY-MM-DD.
 */
function normalizeDate(rawDate) {
  if (!rawDate) return '';
  const clean = rawDate.trim().replace(/[^\d\/\.-]/g, '');

  // Full date: DD/MM/YYYY or YYYY-MM-DD
  const fullMatch = clean.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{2,4})$/);
  if (fullMatch) {
    let [, day, month, year] = fullMatch;
    if (year.length === 2) year = '20' + year;
    day = day.padStart(2, '0');
    month = month.padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Month-Year expiry: MM/YY or MM/YYYY (e.g. 08/28 or 12/2027)
  const myMatch = clean.match(/^(\d{1,2})[\/\.-](\d{2,4})$/);
  if (myMatch) {
    let [, month, year] = myMatch;
    if (year.length === 2) year = '20' + year;
    month = month.padStart(2, '0');
    // Set to last day of expiry month or day 28
    return `${year}-${month}-28`;
  }

  return '';
}

/**
 * Fuzzy matches an OCR product line against existing MediStock database medicines.
 */
function matchMedicine(rawLine, medicines) {
  if (!medicines || !medicines.length) return null;
  const lineLower = rawLine.toLowerCase();

  let bestMatch = null;
  let maxScore = 0;

  for (const m of medicines) {
    const medNameLower = m.name.toLowerCase();
    const companyLower = (m.company || '').toLowerCase();

    let score = 0;
    // Direct substring match
    if (lineLower.includes(medNameLower)) score += 50;

    // Word token match
    const words = medNameLower.split(/\s+/).filter((w) => w.length > 2);
    for (const w of words) {
      if (lineLower.includes(w)) score += 15;
    }

    if (companyLower && lineLower.includes(companyLower)) score += 10;

    if (score > maxScore && score >= 25) {
      maxScore = score;
      bestMatch = m;
    }
  }

  return bestMatch;
}

/**
 * Parses raw OCR text lines to extract Supplier, Invoice No, Date, and Line Items.
 */

export function parseInvoiceText(rawText, medicinesList = []) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let supplier_name = '';
  let invoice_number = '';
  let date = '';
  const parsedItems = [];

  // 1. Extract Invoice Number
  const invMatch = rawText.match(/(?:invoice|inv|bill|vch)\s*(?:no|num|#)?[\s:\.-]*([A-Z0-9\-\/]{3,20})/i);
  if (invMatch) {
    invoice_number = invMatch[1].replace(/[^A-Za-z0-9\-\/]/g, '');
  }

  // 2. Extract Date
  const dateMatch = rawText.match(/(?:date|dt)[\s:\.]*(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4})/i)
    || rawText.match(/(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4})/);
  if (dateMatch) {
    date = normalizeDate(dateMatch[1]);
  }

  // 3. Extract Supplier Name from header lines
  const headerCandidates = lines.slice(0, 8).filter((l) => {
    const lower = l.toLowerCase();
    return !lower.includes('invoice') && !lower.includes('tax') && !lower.includes('gstin')
      && !lower.includes('original') && !lower.includes('bill') && !lower.includes('phone')
      && !lower.includes('date') && l.length >= 3;
  });
  if (headerCandidates.length > 0) {
    supplier_name = headerCandidates[0].replace(/^[^A-Za-z0-9]+/, '');
  }

  // 4. Line Items Extraction
  // Pattern matching for typical Indian pharmacy bill table rows
  for (const line of lines) {
    // Skip header/footer lines
    const lower = line.toLowerCase();
    if (lower.includes('subtotal') || lower.includes('grand total') || lower.includes('gstin') || lower.includes('bank details')) {
      continue;
    }

    // Try batch regex: B.No / Batch followed by alphanumeric token
    const batchMatch = line.match(/(?:b\.?no|batch|bno|b\/n)[\s:\.]*([A-Z0-9\-]+)/i);
    // Try exp regex: Exp / Expiry date
    const expMatch = line.match(/(?:exp|expiry)[\s:\.]*(\d{1,2}[\/\.-]\d{2,4})/i);
    // Try quantity match
    const qtyMatch = line.match(/(?:qty|qnty)[\s:\.]*(\d+)/i) || line.match(/\b(\d{1,4})\s*(?:nos|pcs|box|pkt)?\b/i);
    // Try rate/price match
    const priceMatch = line.match(/(?:rate|p\.?rate|mrp|cost|price)[\s:\.]*₹?\s*(\d+(?:\.\d+)?)/i);

    const matchedMed = matchMedicine(line, medicinesList);

    // If line has a medicine match or batch/exp/qty details
    if (matchedMed || batchMatch || expMatch) {
      // Find candidate numbers on the line
      const nums = line.match(/\d+(?:\.\d+)?/g) || [];
      const batchStr = batchMatch ? batchMatch[1] : (line.match(/\b[A-Z0-9]{4,10}\b/i)?.[0] || '');
      const expStr = expMatch ? normalizeDate(expMatch[1]) : '';

      let quantity = qtyMatch ? parseInt(qtyMatch[1], 10) : 10;
      let buyPrice = priceMatch ? parseFloat(priceMatch[1]) : (matchedMed ? matchedMed.buy_price : 0);

      // Fallback number heuristics if explicit regex didn't catch qty/price
      if (nums.length >= 2 && (!qtyMatch || !priceMatch)) {
        const potentialQty = parseInt(nums[0], 10);
        const potentialPrice = parseFloat(nums[nums.length - 1]);
        if (potentialQty > 0 && potentialQty < 10000) quantity = potentialQty;
        if (potentialPrice >= 0) buyPrice = potentialPrice;
      }

      parsedItems.push({
        medicine_id: matchedMed ? matchedMed.id : (medicinesList[0]?.id || null),
        matchedName: matchedMed ? `${matchedMed.name} (${matchedMed.company})` : '',
        batch_number: batchStr.toUpperCase() || 'BATCH-01',
        expiry_date: expStr || '2027-12-31',
        quantity: String(quantity || 10),
        buy_price: String(buyPrice || 0),
        rawLine: line,
      });
    }
  }

  return {
    supplier_name,
    invoice_number,
    date,
    items: parsedItems,
  };
}

/**
 * Runs Tesseract OCR on an image file/blob and parses structure.
 */
export async function parseInvoiceImage(imageFile, medicinesList = [], onProgress = () => {}) {
  let worker = null;
  try {
    onProgress('Initializing OCR engine…', 10);
    worker = await createWorker('eng');

    onProgress('Scanning invoice text & table lines…', 40);
    const { data } = await worker.recognize(imageFile);

    onProgress('Extracting supplier, batches & prices…', 85);
    const parsed = parseInvoiceText(data.text || '', medicinesList);

    onProgress('Complete!', 100);
    return parsed;
  } catch (err) {
    console.error('Invoice OCR error:', err);
    throw new Error('Failed to read invoice image. Please check image lighting or enter manually.');
  } finally {
    if (worker) {
      await worker.terminate();
    }
  }
}
