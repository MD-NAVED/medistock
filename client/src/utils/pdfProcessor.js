import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';
import { parseInvoiceText, parseInvoiceViaServer } from './invoiceParser.js';

export const PINNED_PDFJS_VERSION = '4.10.38';

// Configure Mozilla pdf.js worker with exact pinned version matching client package.json
if (typeof window !== 'undefined' && pdfjsLib && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PINNED_PDFJS_VERSION}/build/pdf.worker.min.mjs`;
}

/**
 * Loads a PDF Document from File, Blob, or ArrayBuffer.
 * Handles password-protected PDFs with a friendly Hinglish/English error.
 */
export async function loadPdfDocument(fileOrBuffer) {
  let data;
  if (fileOrBuffer instanceof ArrayBuffer) {
    data = fileOrBuffer;
  } else if (fileOrBuffer?.arrayBuffer) {
    data = await fileOrBuffer.arrayBuffer();
  } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(fileOrBuffer)) {
    data = new Uint8Array(fileOrBuffer);
  } else if (fileOrBuffer instanceof Uint8Array) {
    data = fileOrBuffer;
  } else {
    throw new Error('Invalid PDF source');
  }

  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
    data = new Uint8Array(data);
  }

  try {
    const loadingTask = pdfjsLib.getDocument({
      data,
      cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PINNED_PDFJS_VERSION}/cmaps/`,
      cMapPacked: true,
    });

    loadingTask.onPassword = () => {
      throw new Error('Ye PDF password-protected hai — unlock karke try karo');
    };

    const pdf = await loadingTask.promise;
    return pdf;
  } catch (err) {
    const msg = String(err?.message || '').toLowerCase();
    if (err.name === 'PasswordException' || msg.includes('password') || msg.includes('encrypted')) {
      throw new Error('Ye PDF password-protected hai — unlock karke try karo');
    }
    if (err.name === 'InvalidPDFException' || msg.includes('invalid pdf')) {
      throw new Error('Invalid PDF file format. Please upload a valid invoice PDF.');
    }
    throw err;
  }
}

/**
 * Extracts lightweight (~120px wide) page thumbnails for live UI progress preview.
 */
export async function extractPdfThumbnails(pdf, maxPages = 10) {
  if (typeof document === 'undefined') return [];
  const count = Math.min(pdf.numPages, maxPages);
  const thumbnails = [];

  for (let i = 1; i <= count; i++) {
    try {
      const page = await pdf.getPage(i);
      const unscaledViewport = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
      const scale = 120 / (unscaledViewport.width || 600);
      const viewport = page.getViewport({ scale, rotation: page.rotate || 0 });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const ctx = canvas.getContext('2d');

      if (ctx) {
        await page.render({ canvasContext: ctx, viewport }).promise;
        thumbnails.push({
          pageNumber: i,
          dataUrl: canvas.toDataURL('image/jpeg', 0.6),
        });
      }

      if (page.cleanup) page.cleanup();
      canvas.width = 0;
      canvas.height = 0;
    } catch (e) {
      console.warn(`Failed to render thumbnail for page ${i}:`, e.message);
    }
  }

  return thumbnails;
}

/**
 * Sequentially renders each PDF page to canvas and runs Tesseract OCR.
 * Sequential execution & immediate canvas disposal prevents WebAssembly OOM
 * on budget Android phones.
 */
export async function parseInvoicePDF(
  fileOrBuffer,
  medicinesList = [],
  onProgress = () => {}
) {
  onProgress('Reading PDF invoice…', 10, { page: 0, totalPages: 0 });
  const pdf = await loadPdfDocument(fileOrBuffer);

  if (pdf.numPages > 10) {
    throw new Error(`Invoice too long (${pdf.numPages} pages). Maximum 10 pages allowed — please split or contact support.`);
  }

  // Pre-extract lightweight thumbnails for progress display
  let thumbnails = [];
  try {
    thumbnails = await extractPdfThumbnails(pdf, 10);
  } catch {
    /* non-blocking */
  }

  let worker = null;
  const pageTexts = [];

  try {
    onProgress('Initializing OCR engine…', 20, { page: 0, totalPages: pdf.numPages, thumbnails });
    // worker initialized on demand

    for (let i = 1; i <= pdf.numPages; i++) {
      const convertPct = Math.round(20 + ((i - 0.7) / pdf.numPages) * 70);
      onProgress(`Converting page ${i} of ${pdf.numPages}…`, convertPct, {
        page: i,
        totalPages: pdf.numPages,
        stage: 'converting',
        thumbnails,
      });

      const page = await pdf.getPage(i);
      const unscaled = page.getViewport({ scale: 1, rotation: page.rotate || 0 });
      // 1.5x - 2.0x scale capped at 1600px width for optimal OCR readability without RAM bloat
      const targetScale = Math.min(2.0, 1600 / (unscaled.width || 600));
      const viewport = page.getViewport({ scale: targetScale, rotation: page.rotate || 0 });

      let canvas = null;
      let pageText = '';

      if (typeof document !== 'undefined') {
        canvas = document.createElement('canvas');
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');

        await page.render({ canvasContext: ctx, viewport }).promise;


        const scanPct = Math.round(20 + ((i - 0.2) / pdf.numPages) * 70);
        onProgress(`✨ AI Scan (Gemini) page ${i} of ${pdf.numPages}…`, scanPct, {
          page: i,
          totalPages: pdf.numPages,
          stage: 'scanning',
          thumbnails,
        });

        const base64 = canvas.toDataURL('image/jpeg', 0.8);
        try {
          const pageParsed = await parseInvoiceViaServer(base64, medicinesList);
          pageTexts.push(pageParsed); // store the parsed result
        } catch (geminiErr) {
          console.warn('Gemini failed for PDF page, falling back to Tesseract...', geminiErr);
          onProgress(`📄 Local OCR (fallback) page ${i} of ${pdf.numPages}…`, scanPct, {
             page: i, totalPages: pdf.numPages, stage: 'scanning', thumbnails
          });
          if (!worker) worker = await createWorker('eng');
          const { data } = await worker.recognize(canvas);
          pageTexts.push(data?.text || '');
        }

        // Immediate disposal of page & canvas to free memory on budget phones
        canvas.width = 0;
        canvas.height = 0;
      }

      if (page.cleanup) page.cleanup();
    }

    onProgress('Extracting supplier, batches & line items…', 95, {
      page: pdf.numPages,
      totalPages: pdf.numPages,
      stage: 'parsing',
      thumbnails,
    });

    // Merge logic
    let finalParsed = { supplier_name: '', invoice_number: '', date: '', items: [] };
    let hasGemini = false;
    let combinedText = '';

    for (const res of pageTexts) {
       if (typeof res === 'string') {
          combinedText += res + '\n--- PAGE BREAK ---\n';
       } else {
          hasGemini = true;
          if (!finalParsed.supplier_name && res.supplier_name) finalParsed.supplier_name = res.supplier_name;
          if (!finalParsed.invoice_number && res.invoice_number) finalParsed.invoice_number = res.invoice_number;
          if (!finalParsed.date && res.date) finalParsed.date = res.date;
          if (res.items) finalParsed.items.push(...res.items);
       }
    }
    
    if (combinedText.trim()) {
       const textParsed = parseInvoiceText(combinedText, medicinesList);
       if (!finalParsed.supplier_name && textParsed.supplier_name) finalParsed.supplier_name = textParsed.supplier_name;
       if (!finalParsed.invoice_number && textParsed.invoice_number) finalParsed.invoice_number = textParsed.invoice_number;
       if (!finalParsed.date && textParsed.date) finalParsed.date = textParsed.date;
       finalParsed.items.push(...textParsed.items);
    }
    
    if (hasGemini) finalParsed.engine = 'gemini';

    onProgress('Complete!', 100, { page: pdf.numPages, totalPages: pdf.numPages, stage: 'done', thumbnails });
    return finalParsed;

  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* ignore */
      }
    }
  }
}
