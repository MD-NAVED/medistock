/**
 * Bill printing, shared by the billing screen and the reprint button in Reports.
 *
 * `sale.status` decides the banner: a cancelled bill prints with a CANCELLED
 * mark so a reprinted copy can never be mistaken for a valid receipt.
 */
export function printInvoice(settings, sale, items, opts = {}) {
  const s = settings || {};
  const cancelled = sale.status === 'cancelled';
  const hasReturns = items.some((i) => (i.returned_qty || 0) > 0);

  const rows = items.map((i) => {
    const returned = i.returned_qty || 0;
    const net = i.quantity - returned;
    return `
      <tr${returned ? ' class="ret"' : ''}>
        <td>${esc(i.medicine_name)}
          <div class="sub">${esc(i.company)} · Batch ${esc(i.batch_number)} · Exp ${esc(i.expiry_date)}</div>
          ${returned ? `<div class="sub warn">${returned} returned</div>` : ''}
        </td>
        <td class="r">${returned ? `${net} <span class="sub">of ${i.quantity}</span>` : i.quantity}</td>
        <td class="r">₹${Number(i.unit_price).toFixed(2)}</td>
        <td class="r">₹${(net * i.unit_price * (1 + (i.gst_rate || 0) / 100)).toFixed(2)}</td>
      </tr>`;
  }).join('');

  const refunded = Number(opts.refunded || 0);
  const netTotal = Number(sale.total) - refunded;

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sale.invoice_number)}</title>
  <style>
    body { font-family: 'Segoe UI', Arial, sans-serif; width: 420px; margin: 20px auto; color: #111; }
    h1 { font-size: 20px; margin: 0; } .addr { font-size: 12px; color: #444; }
    .hdr { text-align: center; border-bottom: 2px dashed #999; padding-bottom: 8px; margin-bottom: 8px; }
    .meta { font-size: 12px; display: flex; justify-content: space-between; margin-bottom: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; border-bottom: 1px solid #999; padding: 4px 2px; font-size: 12px; }
    td { padding: 5px 2px; border-bottom: 1px dotted #ccc; vertical-align: top; }
    .sub { font-size: 10.5px; color: #666; } .warn { color: #b26a00; }
    .r { text-align: right; }
    .ret td { background: #fff8e1; }
    .totals { margin-top: 8px; font-size: 13px; width: 220px; margin-left: auto; }
    .totals div { display: flex; justify-content: space-between; padding: 2px 0; }
    .grand { font-weight: bold; font-size: 16px; border-top: 2px solid #111; margin-top: 4px; padding-top: 4px; }
    .thanks { text-align: center; font-size: 11px; color: #555; margin-top: 14px; border-top: 2px dashed #999; padding-top: 8px; }
    .stamp { text-align: center; border: 3px solid #c62828; color: #c62828; font-weight: bold;
             font-size: 20px; letter-spacing: 3px; padding: 6px; margin: 10px 0; border-radius: 6px; }
    .copy { text-align: center; font-size: 11px; color: #777; margin-bottom: 6px; }
  </style></head><body>
    <div class="hdr">
      <h1>${esc(s.store_name || 'Medical Store')}</h1>
      <div class="addr">${esc(s.store_address || '')}</div>
      <div class="addr">Ph: ${esc(s.phone || '—')} ${s.license_number ? '· DL No: ' + esc(s.license_number) : ''}</div>
      ${s.gst_number ? `<div class="addr">GSTIN: ${esc(s.gst_number)}</div>` : ''}
    </div>
    ${opts.reprint ? '<div class="copy">— DUPLICATE COPY —</div>' : ''}
    ${cancelled ? '<div class="stamp">CANCELLED</div>' : ''}
    <div class="meta"><div><b>Invoice:</b> ${esc(sale.invoice_number)}</div><div><b>Date:</b> ${esc(sale.created_at)}</div></div>
    ${sale.customer_name ? `<div class="meta"><div><b>Customer:</b> ${esc(sale.customer_name)}</div></div>` : ''}
    <table>
      <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amount</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="totals">
      <div><span>Subtotal</span><span>₹${Number(sale.subtotal).toFixed(2)}</span></div>
      <div><span>GST</span><span>₹${Number(sale.gst_amount).toFixed(2)}</span></div>
      <div><span>Bill total</span><span>₹${Number(sale.total).toFixed(2)}</span></div>
      ${refunded > 0 ? `<div><span>Refunded</span><span>− ₹${refunded.toFixed(2)}</span></div>` : ''}
      <div class="grand"><span>${refunded > 0 || cancelled ? 'NET PAID' : 'TOTAL'}</span><span>₹${netTotal.toFixed(2)}</span></div>
    </div>
    <div class="thanks">
      ${cancelled ? 'This bill was cancelled and is not a valid receipt.<br/>'
                  : hasReturns ? 'Some items on this bill were returned.<br/>' : 'Thank you for your visit! Get well soon. 🌿<br/>'}
      Served by: ${esc(sale.served_by || '—')}
    </div>
    <script>window.onload = function () { window.print(); };</script>
  </body></html>`;

  const w = window.open('', '_blank', 'width=480,height=700');
  if (!w) return false;
  w.document.write(html);
  w.document.close();
  return true;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
