export const fmt = (n) =>
  '₹' + Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtQty = (n) => Number(n || 0).toLocaleString('en-IN');

export const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(s.length === 10 ? s + 'T00:00:00' : s.replace(' ', 'T'));
  if (isNaN(d)) return s;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const fmtDateTime = (s) => {
  if (!s) return '—';
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d)) return s;
  return d.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
};

export const todayStr = () => new Date().toISOString().slice(0, 10);
export const daysAgoStr = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

export const MEDICINE_TYPES = ['Tablet', 'Capsule', 'Syrup', 'Injection', 'Drops', 'Ointment', 'Powder', 'Other'];
export const GST_RATES = [0, 5, 12, 18, 28];
