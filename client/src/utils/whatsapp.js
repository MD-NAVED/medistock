/**
 * WhatsApp Deep Link Builder with URL Length Guard (<1800 chars)
 */

export function buildWhatsAppMessage(invoice, storeName = 'MediStock Pharmacy', baseUrl = '') {
  const { sale, items = [] } = invoice || {};
  const digits = String(sale?.customer_phone || '').replace(/\D/g, '');
  const to = digits.length === 10 ? '91' + digits : digits;
  const pdfUrl = `${baseUrl}/api/public/invoice/${sale?.id}/pdf?t=${sale?.share_token || ''}`;

  // 1. Detailed message template
  const fullLines = [
    `🧾 *${storeName}* — Invoice ${sale?.invoice_number || ''}`,
    `📅 ${sale?.created_at || ''}`,
  ];
  if (sale?.customer_name) fullLines.push(`👤 ${sale.customer_name}`);
  fullLines.push('──────────────');
  items.forEach((it) => {
    fullLines.push(`• ${it.medicine_name} × ${it.quantity} = ₹${Number(it.line_total || 0).toFixed(2)}`);
  });
  fullLines.push('──────────────');
  fullLines.push(`Subtotal: ₹${Number(sale?.subtotal || 0).toFixed(2)}`);
  if (Number(sale?.gst_amount || 0) > 0) fullLines.push(`GST: ₹${Number(sale.gst_amount).toFixed(2)}`);
  fullLines.push(`*TOTAL: ₹${Number(sale?.total || 0).toFixed(2)}*`);
  fullLines.push('');
  fullLines.push(`📄 Invoice PDF: ${pdfUrl}`);
  fullLines.push('_Sent via MediStock_');

  const fullText = fullLines.join('\n');
  const fullUrl = 'https://wa.me/' + to + '?text=' + encodeURIComponent(fullText);

  // If encoded URL length is <= 1800 chars, return full detailed message
  if (fullUrl.length <= 1800) {
    return { url: fullUrl, isFallback: false, length: fullUrl.length };
  }

  // 2. Concise fallback message template for large bills
  const fallbackLines = [
    `🧾 *${storeName}* — Invoice ${sale?.invoice_number || ''}`,
    `📅 ${sale?.created_at || ''}`,
  ];
  if (sale?.customer_name) fallbackLines.push(`👤 ${sale.customer_name}`);
  fallbackLines.push('──────────────');
  fallbackLines.push(`📦 Items: ${items.length} item line(s) · ${items.reduce((s, i) => s + Number(i.quantity || 0), 0)} units`);
  fallbackLines.push(`*TOTAL: ₹${Number(sale?.total || 0).toFixed(2)}*`);
  fallbackLines.push('──────────────');
  fallbackLines.push(`📄 Poora bill PDF mein:`);
  fallbackLines.push(pdfUrl);
  fallbackLines.push('');
  fallbackLines.push('_Sent via MediStock_');

  const fallbackText = fallbackLines.join('\n');
  const fallbackUrl = 'https://wa.me/' + to + '?text=' + encodeURIComponent(fallbackText);
  return { url: fallbackUrl, isFallback: true, length: fallbackUrl.length };
}

export function buildWhatsAppLink(invoice, storeName) {
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://medistock-pharma.vercel.app';
  return buildWhatsAppMessage(invoice, storeName, origin).url;
}
