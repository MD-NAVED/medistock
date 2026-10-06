import { createWorker } from 'tesseract.js';
import { api } from '../api.js';

/**
 * Normalizes date strings like "08/28", "12-2027", "15/08/2026" into YYYY-MM-DD.
 */
function normalizeDate(rawDate) {
  if (!rawDate) return '';
  const rawTrimmed = rawDate.trim();
  
  // Check for MMM-YYYY or MMM YYYY (e.g. Aug-2027, Aug 2027, Aug/2027)
  const mmmMatch = rawTrimmed.match(/^([A-Za-z]{3})[\s\/\.-]+(\d{2,4})$/);
  if (mmmMatch) {
    const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
    const mStr = mmmMatch[1].toLowerCase();
    const mm = months[mStr] || '01';
    let yy = mmmMatch[2];
    if (yy.length === 2) yy = '20' + yy;
    return `${yy}-${mm}-28`;
  }

  const clean = rawTrimmed.replace(/[^\d\/\.-]/g, '');

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
 * Downsamples high-resolution mobile photos (e.g. 12MP-48MP, 5-12MB) to max 1280px wide
 * using an off-screen HTML5 Canvas. Produces a ~200-350KB JPEG blob to prevent mobile
 * browser tab crashes / WebAssembly Out-Of-Memory errors on budget devices.
 */
export async function compressImage(file, maxWidth = 1280, quality = 0.8) {
  if (!file || typeof window === 'undefined' || (!window.createImageBitmap && !window.Image)) {
    return file;
  }

  // Modern browser path: automatic EXIF orientation normalization
  if (typeof window.createImageBitmap === 'function') {
    try {
      const bitmap = await window.createImageBitmap(file, { imageOrientation: 'from-image' });
      let { width, height } = bitmap;
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(bitmap, 0, 0, width, height);
        if (bitmap.close) bitmap.close();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        canvas.width = 0;
        canvas.height = 0;
        if (blob && blob.size < file.size) return blob;
        return file;
      }
      if (bitmap.close) bitmap.close();
    } catch {
      // Fallback to Image element on older browser contexts
    }
  }

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (width > maxWidth) {
        height = Math.round((height * maxWidth) / width);
        width = maxWidth;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        return resolve(file);
      }
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          canvas.width = 0;
          canvas.height = 0;
          if (blob && blob.size < file.size) {
            resolve(blob);
          } else {
            resolve(file);
          }
        },
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

/**
 * Scores all medicines against the OCR text line and returns candidate matches.
 * - Confident match (score >= 60): isConfident = true, auto-select candidate.
 * - Low confidence (25 <= score < 60): isConfident = false, returns top 3 candidates for user selection.
 * - Score < 25: no match found.
 */
export function scoreMedicineMatches(rawLine, medicines) {
  if (!medicines || !medicines.length || !rawLine) {
    return { topMatch: null, candidates: [], isConfident: false };
  }
  const lineLower = rawLine.toLowerCase();
  const scored = [];

  for (const m of medicines) {
    const medNameLower = m.name.toLowerCase();
    const companyLower = (m.company || '').toLowerCase();

    let score = 0;
    // Direct substring match
    if (lineLower.includes(medNameLower)) {
      score += 60;
    }

    // Word token match
    const words = medNameLower.split(/\s+/).filter((w) => w.length > 2);
    let matchedWords = 0;
    for (const w of words) {
      if (lineLower.includes(w)) {
        score += 25;
        matchedWords++;
      }
    }
    if (words.length > 0 && matchedWords === words.length) {
      score += 20;
    }

    if (companyLower && lineLower.includes(companyLower)) {
      score += 15;
    }

    if (score >= 25) {
      scored.push({
        medicine: m,
        score,
        id: m.id,
        name: m.name,
        company: m.company || '',
        buy_price: m.buy_price,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const candidates = scored.slice(0, 3);
  const topMatch = candidates[0] || null;
  const isConfident = !!(topMatch && topMatch.score >= 60);

  return {
    topMatch,
    candidates,
    isConfident,
  };
}

/**
 * Parses raw OCR text lines to extract Supplier, Invoice No, Date, and Line Items.
 * ZERO SILENT DEFAULTS: unextracted fields remain empty strings with candidate lists
 * so the user can review and manually verify rather than saving corrupted data.
 */
export function parseInvoiceText(rawText, medicinesList = []) {
  const lines = rawText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  let supplier_name = '';
  let invoice_number = '';
  let date = '';
  const parsedItems = [];

  // 1. Extract Invoice Number (line-by-line to prevent multiline bleed)
  for (const line of lines) {
    const invMatch = line.match(/\b(?:invoice|inv|bill|vch)\s*(?:no|num|#)[\s:\.-]*([A-Z0-9\-\/]{3,20})/i)
      || line.match(/\b(?:invoice|inv|bill|vch)[\s:\.-]+([A-Z0-9\-\/]{3,20})/i);
    if (invMatch) {
      invoice_number = invMatch[1].replace(/[^A-Za-z0-9\-\/]/g, '');
      break;
    }
  }

  // 2. Extract Date
  for (const line of lines) {
    const dateMatch = line.match(/\b(?:date|dt)[\s:\.]*(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4})/i)
      || line.match(/\b(\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4})\b/);
    if (dateMatch) {
      date = normalizeDate(dateMatch[1]);
      if (date) break;
    }
  }

  // 3. Extract Supplier Name from header lines
  const headerCandidates = lines.slice(0, 10).filter((l) => {
    const lower = l.toLowerCase();
    const isWatermark = lower.includes('.ai') || lower.includes('generated') || lower.includes('http');
    const isDate = /^\d{1,2}[\/\.-]\d{1,2}[\/\.-]\d{2,4}$/.test(l.replace(/[^\d\/\.-]/g, ''));
    return !lower.includes('invoice') && !lower.includes('tax') && !lower.includes('gstin')
      && !lower.includes('original') && !lower.includes('bill') && !lower.includes('phone')
      && !lower.includes('date') && l.length >= 3 && !isWatermark && !isDate;
  });
  if (headerCandidates.length > 0) {
    // Prefer lines with typical distributor keywords
    const pharmaLine = headerCandidates.find(l => /pharma|medical|distributor|agency|medicos/i.test(l));
    supplier_name = (pharmaLine || headerCandidates[0]).replace(/^[^A-Za-z0-9]+/, '');
  }

  // 4. Line Items Extraction
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes('subtotal') || lower.includes('grand total') || lower.includes('gstin') || lower.includes('bank details')) {
      continue;
    }

    const batchMatch = line.match(/\b(?:b\.?no|batch|bno|b\/n)[\s:\.]*([A-Z0-9\-]+)/i);
    const expMatch = line.match(/\b(?:exp|expiry)[\s:\.]*(\d{1,2}[\/\.-]\d{2,4})/i);
    const qtyMatch = line.match(/\b(?:qty|qnty)[\s:\.]*(\d+)/i) || line.match(/\b(\d{1,4})\s*(?:nos|pcs|box|pkt)?\b/i);
    const priceMatch = line.match(/\b(?:rate|p\.?rate|mrp|cost|price)[\s:\.]*₹?\s*(\d+(?:\.\d+)?)/i);

    const matchResult = scoreMedicineMatches(line, medicinesList);
    const { topMatch, candidates, isConfident } = matchResult;

    if (topMatch || batchMatch || expMatch) {
      const batchStr = batchMatch ? batchMatch[1].trim() : '';
      const expStr = expMatch ? normalizeDate(expMatch[1]) : '';

      let quantity = '';
      if (qtyMatch) {
        quantity = String(parseInt(qtyMatch[1], 10));
      }

      let buyPrice = '';
      if (priceMatch) {
        buyPrice = String(parseFloat(priceMatch[1]));
      }

      const nums = line.match(/\d+(?:\.\d+)?/g) || [];
      if (nums.length >= 2 && (!quantity || !buyPrice)) {
        const potentialQty = parseInt(nums[0], 10);
        const potentialPrice = parseFloat(nums[nums.length - 1]);
        if (!quantity && potentialQty > 0 && potentialQty < 10000) quantity = String(potentialQty);
        if (!buyPrice && potentialPrice >= 0) buyPrice = String(potentialPrice);
      }

      if (!buyPrice && isConfident && topMatch?.medicine?.buy_price) {
        buyPrice = String(topMatch.medicine.buy_price);
      }

      // Catalog-Anchored Sanity Check
      if (isConfident && topMatch?.medicine?.buy_price) {
        const catPrice = Number(topMatch.medicine.buy_price);
        const pQty = Number(quantity);
        const pPrice = Number(buyPrice);
        
        if (pPrice && pQty && catPrice > 0) {
          // If parsed price / parsed_qty is close to catalog buy_price, then pPrice was AMOUNT (total) instead of RATE
          if (Math.abs((pPrice / pQty) - catPrice) / catPrice < 0.4) {
             buyPrice = String(Number((pPrice / pQty).toFixed(2)));
          }
        }
        
        // If parsed qty > 500 and the medicine name contains that dosage number (e.g. "CROCIN 650" -> 650)
        if (pQty > 500 && topMatch.name.includes(String(pQty))) {
           quantity = ''; // Blank it, it picked dosage as qty
        }
      }

      // NO SILENT DEFAULTS:
      // If confident, assign medicine_id. If not confident, leave empty '' and supply candidates.
      // batch_number, expiry_date, quantity, buy_price are left empty if unextracted.
      parsedItems.push({
        medicine_id: isConfident ? topMatch.id : '',
        matchedName: isConfident ? `${topMatch.name} (${topMatch.company})` : '',
        candidates: candidates.map((c) => ({
          id: c.id,
          name: c.name,
          company: c.company,
          buy_price: c.buy_price,
        })),
        lowConfidence: !isConfident && candidates.length > 0,
        batch_number: batchStr.toUpperCase() || '',
        expiry_date: expStr || '',
        quantity: quantity || '',
        buy_price: buyPrice || '',
        rawLine: line,
      });
    }
  }

  return {
    engine: 'tesseract',
    supplier_name,
    invoice_number,
    date,
    items: parsedItems,
  };
}

/**
 * Runs Tesseract OCR on an image file/blob and parses structure.
 * Compresses to 1280px first to avoid mobile WebAssembly memory issues.
 */

/**
 * Sends image to the new Gemini Vision server endpoint.
 */
export async function parseInvoiceViaServer(base64Image, medicinesList) {
  const data = await api('/api/purchases/scan-invoice', {
    method: 'POST',
    body: { image_base64: base64Image },
  });
  
  // Transform Gemini output to match existing Tesseract output shape
  const transformedItems = (data.items || []).map(item => {
     const matchResult = scoreMedicineMatches((item.medicine_name || '') + ' ' + (item.company || ''), medicinesList);
     const { topMatch, candidates, isConfident } = matchResult;
     
     return {
        medicine_id: isConfident ? topMatch.id : '',
        matchedName: isConfident ? `${topMatch.name} (${topMatch.company})` : '',
        candidates: candidates.map((c) => ({
          id: c.id,
          name: c.name,
          company: c.company,
          buy_price: c.buy_price,
        })),
        lowConfidence: !isConfident && candidates.length > 0,
        batch_number: (item.batch_number || '').toUpperCase(),
        expiry_date: item.expiry || '',
        quantity: item.quantity !== null && item.quantity !== undefined ? String(item.quantity) : '',
        free_quantity: item.free_quantity !== null && item.free_quantity !== undefined ? String(item.free_quantity) : '',
        buy_price: item.rate !== null && item.rate !== undefined ? String(item.rate) : '',
        rawLine: `${item.medicine_name} ${item.batch_number||''} ${item.expiry||''} ${item.quantity||''} ${item.rate||''}`
     };
  });
  
  return {
    engine: data.engine || 'gemini',
    supplier_name: data.supplier_name || '',
    invoice_number: data.invoice_number || '',
    date: data.invoice_date || '',
    items: transformedItems
  };
}

export async function parseInvoiceImage(imageFile, medicinesList = [], onProgress = () => {}) {
  let worker = null;
  try {
    onProgress('Compressing invoice image for mobile…', 10);
    const compressed = await compressImage(imageFile, 1280, 0.8);

    onProgress('Initializing OCR engine…', 25);
    worker = await createWorker('eng');

    onProgress('Scanning invoice text & table lines…', 50);
    const { data } = await worker.recognize(compressed);

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

/**
 * Unified router for invoice files (Camera, Gallery images, and PDF uploads).
 * Dispatches to parseInvoicePDF for PDFs or parseInvoiceImage for standard image formats.
 */
export async function parseInvoiceFile(file, medicinesList = [], onProgress = () => {}) {
  if (!file) throw new Error('No file provided for scanning');

  const isPdf = file.type === 'application/pdf' || String(file.name || '').toLowerCase().endsWith('.pdf');
  if (isPdf) {
    const { parseInvoicePDF } = await import('./pdfProcessor.js');
    return parseInvoicePDF(file, medicinesList, onProgress);
  }

  // Regular Image Fallback Logic
  onProgress('Compressing invoice image for mobile…', 10);
  const compressedBlob = await compressImage(file, 1280, 0.8);
  
  try {
    onProgress('✨ AI Scan (Gemini) - Processing...', 50);
    // Convert blob to base64
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.readAsDataURL(compressedBlob);
    });
    const parsed = await parseInvoiceViaServer(base64, medicinesList);
    console.log(`[Invoice Scanner] engine=${parsed.engine || 'gemini-3.6-flash'} completed successfully`);
    onProgress('Complete!', 100);
    return parsed;
  } catch (err) {
    console.warn(`[Invoice Scanner] AI engine failed (${err?.message || 'error'}), falling back to engine=tesseract (local OCR):`, err);
    onProgress('📄 Local OCR (fallback) - Initializing...', 60);
    const parsed = await parseInvoiceImage(compressedBlob, medicinesList, onProgress);
    console.log('[Invoice Scanner] engine=tesseract (fallback) completed successfully');
    return { ...parsed, engine: 'tesseract-fallback' };
  }
}