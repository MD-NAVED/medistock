const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { db, addUser, verifyPassword, setUserPassword } = require('./db');
const { createBackup, listBackups, startAutoBackup } = require('./backup');

const app = express();
const PORT = process.env.PORT || 3001;
const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 8;      // per username
const LOCKOUT_MINUTES = 15;

app.set('trust proxy', true);
app.use(express.json({ limit: '1mb' }));

// Basic hardening headers. HTTPS itself is terminated by the hosting layer
// (nginx/Caddy/cloud) — see README "Running securely".
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// ---------------------------------------------------------------------------
// Sessions — stored in SQLite so they survive a server restart
// ---------------------------------------------------------------------------
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000)
    .toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, userId, expires);
  return token;
}

function purgeExpiredSessions() {
  db.prepare(`DELETE FROM sessions WHERE expires_at <= datetime('now','localtime')`).run();
}
purgeExpiredSessions();
setInterval(purgeExpiredSessions, 60 * 60 * 1000).unref();

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in', code: 'session_invalid' });
  const row = db.prepare(`
    SELECT s.token, u.id, u.username, u.name, u.role, u.active
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > datetime('now','localtime')
  `).get(token);
  if (!row || !row.active) {
    return res.status(401).json({ error: 'Session expired — please log in again', code: 'session_invalid' });
  }
  db.prepare(`UPDATE sessions SET last_seen = datetime('now','localtime') WHERE token = ?`).run(token);
  req.user = { id: row.id, username: row.username, name: row.name, role: row.role };
  req.token = token;
  next();
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access only' });
  next();
}

const bad = (res, code, msg) => res.status(code).json({ error: msg });

// ---------------------------------------------------------------------------
// Login rate limiting
// ---------------------------------------------------------------------------
function recentFailures(username) {
  return db.prepare(`
    SELECT COUNT(*) AS c FROM login_attempts
    WHERE username = ? AND success = 0
      AND created_at > datetime('now','localtime','-${LOCKOUT_MINUTES} minutes')
  `).get(username).c;
}

function recordAttempt(username, ip, success) {
  db.prepare('INSERT INTO login_attempts (username, ip, success) VALUES (?, ?, ?)')
    .run(username, ip || '', success ? 1 : 0);
  // keep the table small
  db.prepare(`DELETE FROM login_attempts WHERE created_at < datetime('now','localtime','-2 days')`).run();
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return bad(res, 400, 'Username and password required');
  const uname = String(username).trim();
  const ip = req.ip || '';

  if (recentFailures(uname) >= MAX_FAILED_LOGINS) {
    return bad(res, 429, `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);
  }

  const u = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(uname);
  if (!u || !verifyPassword(u, String(password))) {
    recordAttempt(uname, ip, false);
    return bad(res, 401, 'Invalid username or password');
  }
  recordAttempt(uname, ip, true);
  const token = createSession(u.id);
  res.json({ token, user: { id: u.id, username: u.username, name: u.name, role: u.role } });
});

app.post('/api/auth/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));

app.post('/api/auth/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return bad(res, 400, 'Current and new password are required');
  if (String(new_password).length < 6) return bad(res, 400, 'New password must be at least 6 characters');
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  // A wrong current password is a validation failure, not an invalid session —
  // 422 keeps the client from treating it as a logout.
  if (!verifyPassword(u, String(current_password))) {
    return res.status(422).json({ error: 'Current password is incorrect' });
  }
  setUserPassword(u.id, String(new_password));
  // log out every other device for this user
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(u.id, req.token);
  res.json({ ok: true });
});


// ---------------------------------------------------------------------------
// Medicines (catalog)
// ---------------------------------------------------------------------------
app.get('/api/medicines', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT m.id, m.name, m.company, m.type, m.shelf, m.buy_price, m.sell_price,
           m.gst_rate, m.low_stock_threshold,
           COALESCE(SUM(b.quantity), 0) AS stock,
           MIN(CASE WHEN b.quantity > 0 THEN b.expiry_date END) AS nearest_expiry
    FROM medicines m
    LEFT JOIN batches b ON b.medicine_id = m.id
    WHERE m.active = 1 AND (m.name LIKE ? OR m.company LIKE ?)
    GROUP BY m.id
    ORDER BY m.name COLLATE NOCASE
    LIMIT 500
  `).all(like, like);
  res.json(rows);
});

app.get('/api/medicines/:id/batches', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, batch_number, expiry_date, quantity,
           CAST(julianday(expiry_date) - julianday('now','localtime') AS INTEGER) AS days_left
    FROM batches WHERE medicine_id = ? AND quantity > 0
    ORDER BY expiry_date ASC
  `).all(req.params.id);
  res.json(rows);
});

/** Every batch of a medicine including empty ones, plus write-off history. */
app.get('/api/medicines/:id/detail', requireAuth, (req, res) => {
  const med = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
  if (!med) return bad(res, 404, 'Medicine not found');
  const batches = db.prepare(`
    SELECT id, batch_number, expiry_date, quantity,
           CAST(julianday(expiry_date) - julianday('now','localtime') AS INTEGER) AS days_left
    FROM batches WHERE medicine_id = ?
    ORDER BY expiry_date ASC
  `).all(med.id);
  const writeoffs = db.prepare(`
    SELECT w.id, w.batch_number, w.expiry_date, w.quantity, w.cost_value, w.reason, w.note,
           w.created_at, u.name AS user_name
    FROM stock_writeoffs w JOIN users u ON u.id = w.user_id
    WHERE w.medicine_id = ? ORDER BY w.id DESC LIMIT 50
  `).all(med.id);
  const totalStock = batches.reduce((s, b) => s + b.quantity, 0);
  res.json({ medicine: med, batches, writeoffs, totalStock });
});

/** Remove expired or damaged stock from a batch, keeping an audit record. */
app.post('/api/batches/:id/writeoff', requireAuth, (req, res) => {
  const { quantity, reason, note } = req.body || {};
  const batch = db.prepare(`
    SELECT b.*, m.name, m.company, m.buy_price
    FROM batches b JOIN medicines m ON m.id = b.medicine_id
    WHERE b.id = ?
  `).get(req.params.id);
  if (!batch) return bad(res, 404, 'Batch not found');

  const qty = Math.floor(Number(quantity));
  if (!Number.isFinite(qty) || qty <= 0) return bad(res, 400, 'Quantity must be more than 0');
  if (qty > batch.quantity) return bad(res, 400, `Only ${batch.quantity} units left in batch ${batch.batch_number}`);
  const allowed = ['expired', 'damaged', 'lost', 'other'];
  const why = allowed.includes(reason) ? reason : 'expired';

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE batches SET quantity = quantity - ? WHERE id = ?').run(qty, batch.id);
    db.prepare(`
      INSERT INTO stock_writeoffs (batch_id, medicine_id, medicine_name, company, batch_number,
                                   expiry_date, quantity, cost_value, reason, note, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(batch.id, batch.medicine_id, batch.name, batch.company, batch.batch_number,
           batch.expiry_date, qty, qty * batch.buy_price, why, String(note || '').trim(), req.user.id);
    db.exec('COMMIT');
    res.json({ ok: true, removed: qty, cost_value: qty * batch.buy_price });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

app.get('/api/writeoffs', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT w.*, u.name AS user_name
    FROM stock_writeoffs w JOIN users u ON u.id = w.user_id
    ORDER BY w.id DESC LIMIT 200
  `).all();
  const total = rows.reduce((s, r) => s + r.cost_value, 0);
  res.json({ rows, total_loss: total });
});

/** Soft delete — the medicine leaves the catalog but its sales history stays intact. */
app.delete('/api/medicines/:id', requireAuth, requireOwner, (req, res) => {
  const med = db.prepare('SELECT * FROM medicines WHERE id = ? AND active = 1').get(req.params.id);
  if (!med) return bad(res, 404, 'Medicine not found');
  const stock = db.prepare('SELECT COALESCE(SUM(quantity),0) AS q FROM batches WHERE medicine_id = ?')
    .get(med.id).q;
  if (stock > 0 && !req.query.force) {
    return bad(res, 409, `“${med.name}” still has ${stock} units in stock. Write off or sell the stock first, or confirm forced removal.`);
  }
  db.prepare('UPDATE medicines SET active = 0 WHERE id = ?').run(med.id);
  res.json({ ok: true, had_stock: stock });
});

app.post('/api/medicines', requireAuth, requireOwner, (req, res) => {
  const { name, company, type, shelf, buy_price, sell_price, gst_rate, low_stock_threshold } = req.body || {};
  if (!name?.trim() || !company?.trim()) return bad(res, 400, 'Medicine name and company are required');
  if (Number(sell_price) <= 0) return bad(res, 400, 'Sell price must be greater than 0');

  const nm = name.trim();
  const co = company.trim();

  // A removed medicine keeps its row (sales history references it), so adding
  // the same name + company again revives that row instead of failing.
  const existing = db.prepare('SELECT * FROM medicines WHERE name = ? AND company = ?').get(nm, co);
  if (existing && existing.active === 1) {
    return bad(res, 409, 'This medicine + company already exists in the catalog');
  }
  if (existing) {
    db.prepare(`
      UPDATE medicines SET active = 1, type = ?, shelf = ?, buy_price = ?, sell_price = ?,
                           gst_rate = ?, low_stock_threshold = ? WHERE id = ?
    `).run(type || 'Tablet', (shelf || '').trim(), Number(buy_price) || 0, Number(sell_price) || 0,
           Number(gst_rate) || 0, Number(low_stock_threshold) || 10, existing.id);
    return res.json({ id: existing.id, restored: true });
  }

  const r = db.prepare(`
    INSERT INTO medicines (name, company, type, shelf, buy_price, sell_price, gst_rate, low_stock_threshold)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nm, co, type || 'Tablet', (shelf || '').trim(),
         Number(buy_price) || 0, Number(sell_price) || 0, Number(gst_rate) || 0, Number(low_stock_threshold) || 10);
  res.json({ id: Number(r.lastInsertRowid) });
});

app.put('/api/medicines/:id', requireAuth, requireOwner, (req, res) => {
  const m = db.prepare('SELECT * FROM medicines WHERE id = ?').get(req.params.id);
  if (!m) return bad(res, 404, 'Medicine not found');
  const b = req.body || {};
  db.prepare(`
    UPDATE medicines SET name=?, company=?, type=?, shelf=?, buy_price=?, sell_price=?,
                         gst_rate=?, low_stock_threshold=?
    WHERE id=?
  `).run(
    (b.name ?? m.name).trim(), (b.company ?? m.company).trim(), b.type ?? m.type,
    (b.shelf ?? m.shelf).trim(), Number(b.buy_price ?? m.buy_price) || 0,
    Number(b.sell_price ?? m.sell_price) || 0, Number(b.gst_rate ?? m.gst_rate) || 0,
    Number(b.low_stock_threshold ?? m.low_stock_threshold) || 0, m.id
  );
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Purchases (stock IN - manual entry; invoice scanning comes later)
// ---------------------------------------------------------------------------
app.get('/api/purchases', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.invoice_number, p.supplier_name, p.total, p.created_at,
           p.status, p.reversed_at, p.reverse_reason,
           u.name AS created_by, COUNT(pi.id) AS item_count
    FROM purchases p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
    GROUP BY p.id ORDER BY p.id DESC LIMIT 200
  `).all();
  res.json(rows);
});

app.get('/api/purchases/:id', requireAuth, (req, res) => {
  const p = db.prepare(`
    SELECT p.*, u.name AS created_by FROM purchases p
    JOIN users u ON u.id = p.user_id WHERE p.id = ?
  `).get(req.params.id);
  if (!p) return bad(res, 404, 'Purchase not found');
  const items = db.prepare(`
    SELECT pi.*, m.name AS medicine_name, m.company
    FROM purchase_items pi JOIN medicines m ON m.id = pi.medicine_id
    WHERE pi.purchase_id = ?
  `).all(p.id);
  res.json({ purchase: p, items });
});

/**
 * Undo a purchase entered by mistake: pull the same quantities back out of the
 * batches. Refuses when the stock has already been sold, because reversing then
 * would make the batch quantity negative and corrupt the ledger.
 */
app.post('/api/purchases/:id/reverse', requireAuth, requireOwner, (req, res) => {
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(req.params.id);
  if (!p) return bad(res, 404, 'Purchase not found');
  if (p.status === 'reversed') return bad(res, 409, 'This purchase is already reversed');

  const items = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?').all(p.id);
  if (!items.length) return bad(res, 400, 'This purchase has no items');

  // Check every line can be pulled back before changing anything.
  for (const it of items) {
    const b = db.prepare('SELECT b.*, m.name FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.medicine_id = ? AND b.batch_number = ?')
      .get(it.medicine_id, it.batch_number);
    if (!b) return bad(res, 409, `Batch ${it.batch_number} no longer exists — cannot reverse`);
    if (b.quantity < it.quantity) {
      return bad(res, 409, `Cannot reverse: only ${b.quantity} of the ${it.quantity} units of “${b.name}” batch ${it.batch_number} are still in stock (the rest was already sold).`);
    }
  }

  db.exec('BEGIN');
  try {
    for (const it of items) {
      db.prepare('UPDATE batches SET quantity = quantity - ? WHERE medicine_id = ? AND batch_number = ?')
        .run(it.quantity, it.medicine_id, it.batch_number);
    }
    db.prepare(`
      UPDATE purchases SET status = 'reversed', reversed_at = datetime('now','localtime'),
                           reversed_by = ?, reverse_reason = ? WHERE id = ?
    `).run(req.user.id, String(req.body?.reason || '').trim(), p.id);
    db.exec('COMMIT');
    res.json({ ok: true, reversed_items: items.length });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

app.post('/api/purchases', requireAuth, (req, res) => {
  const { supplier_name, invoice_number, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return bad(res, 400, 'Add at least one item to the purchase');
  for (const it of items) {
    if (!it.medicine_id) return bad(res, 400, 'Select a medicine for every item');
    if (!it.batch_number?.trim()) return bad(res, 400, 'Batch number is required for every item');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.expiry_date || '')) return bad(res, 400, 'Valid expiry date is required for every item');
    if (!Number.isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) return bad(res, 400, 'Quantity must be more than 0');
    if (Number(it.buy_price) < 0) return bad(res, 400, 'Buy price cannot be negative');
  }

  let total = 0;
  db.exec('BEGIN');
  try {
    const pr = db.prepare('INSERT INTO purchases (invoice_number, supplier_name, user_id, total) VALUES (?, ?, ?, 0)')
      .run((invoice_number || '').trim() || 'PINV-' + Date.now(), (supplier_name || '').trim(), req.user.id);
    const insItem = db.prepare('INSERT INTO purchase_items (purchase_id, medicine_id, batch_number, expiry_date, quantity, buy_price) VALUES (?, ?, ?, ?, ?, ?)');
    for (const it of items) {
      const qty = Math.floor(Number(it.quantity));
      const bp = Number(it.buy_price) || 0;
      total += qty * bp;
      insItem.run(pr.lastInsertRowid, it.medicine_id, it.batch_number.trim(), it.expiry_date, qty, bp);
      // Add stock: create the batch if new, otherwise add quantity to the existing batch
      db.prepare(`
        INSERT INTO batches (medicine_id, batch_number, expiry_date, quantity)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(medicine_id, batch_number)
        DO UPDATE SET quantity = quantity + excluded.quantity
      `).run(it.medicine_id, it.batch_number.trim(), it.expiry_date, qty);
      // Keep the medicine's buy price in sync with the latest purchase
      db.prepare('UPDATE medicines SET buy_price = ? WHERE id = ?').run(bp, it.medicine_id);
    }
    db.prepare('UPDATE purchases SET total = ? WHERE id = ?').run(total, pr.lastInsertRowid);
    db.exec('COMMIT');
    res.json({ id: Number(pr.lastInsertRowid), total });
  } catch (e) {
    db.exec('ROLLBACK');
    if (String(e.message).includes('UNIQUE')) return bad(res, 409, 'Duplicate batch entry in this purchase');
    throw e;
  }
});

/**
 * Edit an existing purchase: supplier name, invoice number, and the line
 * items themselves. Stock is reconciled in one transaction — old line-item
 * quantities are pulled back out of their batches, then the new line items are
 * applied — so the ledger stays consistent even when stock from the original
 * batches has since been sold. Refuses (409) when a reduction would drive a
 * batch negative. Reversed purchases cannot be edited.
 */
app.put('/api/purchases/:id', requireAuth, requireOwner, (req, res) => {
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').all(req.params.id)[0];
  if (!p) return bad(res, 404, 'Purchase not found');
  if (p.status === 'reversed') return bad(res, 409, 'Cannot edit a reversed purchase');

  const { supplier_name, invoice_number, items } = req.body || {};
  if (!Array.isArray(items) || !items.length) return bad(res, 400, 'Add at least one item to the purchase');
  for (const it of items) {
    if (!it.medicine_id) return bad(res, 400, 'Select a medicine for every item');
    if (!it.batch_number?.trim()) return bad(res, 400, 'Batch number is required for every item');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(it.expiry_date || '')) return bad(res, 400, 'Valid expiry date is required for every item');
    if (!Number.isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) return bad(res, 400, 'Quantity must be more than 0');
    if (Number(it.buy_price) < 0) return bad(res, 400, 'Buy price cannot be negative');
  }

  const oldItems = db.prepare('SELECT * FROM purchase_items WHERE purchase_id = ?').all(p.id);
  if (!oldItems.length) return bad(res, 400, 'This purchase has no items to edit');

  // Aggregate old and new quantities by (medicine_id, batch_number) so a
  // reduction shows up as old_qty - new_qty > 0 for that key. Only keys whose
  // quantity is being net-reduced need a stock check — additions always land
  // above the current level and never drive a batch negative.
  const agg = (rows, normalize) => {
    const out = [];
    for (const r of rows) {
      const key = normalize(r);
      const existing = out.find(o => o.medicine_id === key.medicine_id && o.batch_number === key.batch_number);
      if (existing) existing.qty += key.qty;
      else out.push(key);
    }
    return out;
  };
  const oldAgg = agg(oldItems, it => ({ medicine_id: it.medicine_id, batch_number: it.batch_number, qty: it.quantity }));
  const newAgg = agg(items, it => ({ medicine_id: it.medicine_id, batch_number: it.batch_number.trim(), qty: Math.floor(Number(it.quantity)) }));
  for (const o of oldAgg) {
    const n = newAgg.find(x => x.medicine_id === o.medicine_id && x.batch_number === o.batch_number);
    const reduction = o.qty - (n ? n.qty : 0);
    if (reduction > 0) {
      const b = db.prepare('SELECT b.*, m.name FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.medicine_id = ? AND b.batch_number = ?')
        .all(o.medicine_id, o.batch_number)[0];
      if (!b) return bad(res, 409, `Batch ${o.batch_number} no longer exists — cannot edit`);
      if (b.quantity < reduction) {
        return bad(res, 409, `Cannot reduce: only ${b.quantity} of batch ${o.batch_number} ("${b.name}") is still in stock — the rest was already sold.`);
      }
    }
  }

  let total = 0;
  db.exec('BEGIN');
  try {
    // 1. Reverse the old line items — pull their quantities back out of batches.
    for (const it of oldItems) {
      db.prepare('UPDATE batches SET quantity = quantity - ? WHERE medicine_id = ? AND batch_number = ?')
        .run(it.quantity, it.medicine_id, it.batch_number);
    }
    // 2. Replace the purchase_items rows.
    db.prepare('DELETE FROM purchase_items WHERE purchase_id = ?').run(p.id);
    const insItem = db.prepare('INSERT INTO purchase_items (purchase_id, medicine_id, batch_number, expiry_date, quantity, buy_price) VALUES (?, ?, ?, ?, ?, ?)');
    // 3. Apply the new line items — put their quantities back into batches.
    for (const it of items) {
      const qty = Math.floor(Number(it.quantity));
      const bp = Number(it.buy_price) || 0;
      total += qty * bp;
      insItem.run(p.id, it.medicine_id, it.batch_number.trim(), it.expiry_date, qty, bp);
      db.prepare(`
        INSERT INTO batches (medicine_id, batch_number, expiry_date, quantity)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(medicine_id, batch_number)
        DO UPDATE SET quantity = quantity + excluded.quantity
      `).run(it.medicine_id, it.batch_number.trim(), it.expiry_date, qty);
      db.prepare('UPDATE medicines SET buy_price = ? WHERE id = ?').run(bp, it.medicine_id);
    }
    // 4. Update the purchase header and the recalculated total.
    db.prepare('UPDATE purchases SET invoice_number = ?, supplier_name = ?, total = ? WHERE id = ?')
      .run((invoice_number || '').trim() || 'PINV-' + Date.now(), (supplier_name || '').trim(), total, p.id);
    db.exec('COMMIT');
    res.json({ id: Number(p.id), total });
  } catch (e) {
    db.exec('ROLLBACK');
    if (String(e.message).includes('UNIQUE')) return bad(res, 409, 'Duplicate batch entry in this purchase');
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Sales / Billing (stock OUT - automatic, FEFO)
// ---------------------------------------------------------------------------
app.post('/api/sales', requireAuth, (req, res) => {
  const { items, customer_name } = req.body || {};
  if (!Array.isArray(items) || !items.length) return bad(res, 400, 'Cart is empty');
  for (const it of items) {
    if (!Number.isInteger(Number(it.quantity)) || Number(it.quantity) <= 0)
      return bad(res, 400, 'Invalid quantity');
  }
  const settings = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const gstEnabled = !!settings?.gst_enabled;

  db.exec('BEGIN');
  try {
    const maxId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM sales').get().m) + 1;
    const invNo = 'INV-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + String(maxId).padStart(4, '0') + '-' + Math.floor(1000 + Math.random() * 9000);
    const sr = db.prepare('INSERT INTO sales (invoice_number, user_id, customer_name, subtotal, gst_amount, total) VALUES (?, ?, ?, 0, 0, 0)')
      .run(invNo, req.user.id, (customer_name || '').trim());

    let subtotal = 0, gstAmount = 0;
    const outItems = [];
    for (const it of items) {
      const m = db.prepare('SELECT * FROM medicines WHERE id = ? AND active = 1').get(it.medicine_id);
      if (!m) { db.exec('ROLLBACK'); return bad(res, 404, `Medicine #${it.medicine_id} not found`); }

      // FEFO: allocate from batches that expire soonest first
      const batches = db.prepare(
        'SELECT id, batch_number, expiry_date, quantity FROM batches WHERE medicine_id = ? AND quantity > 0 ORDER BY expiry_date ASC, id ASC'
      ).all(m.id);
      let remaining = Number(it.quantity);
      for (const b of batches) {
        if (remaining <= 0) break;
        const take = Math.min(b.quantity, remaining);
        remaining -= take;
        const lineTotal = take * m.sell_price;
        const lineGst = gstEnabled ? (lineTotal * m.gst_rate) / 100 : 0;
        subtotal += lineTotal;
        gstAmount += lineGst;
        db.prepare('UPDATE batches SET quantity = quantity - ? WHERE id = ?').run(take, b.id);
        db.prepare(`
          INSERT INTO sale_items (sale_id, medicine_id, batch_id, medicine_name, company, batch_number,
                                  expiry_date, quantity, unit_price, cost_price, gst_rate, line_total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sr.lastInsertRowid, m.id, b.id, m.name, m.company, b.batch_number, b.expiry_date,
               take, m.sell_price, m.buy_price, gstEnabled ? m.gst_rate : 0, lineTotal);
        outItems.push({ medicine_name: m.name, company: m.company, batch_number: b.batch_number,
                        expiry_date: b.expiry_date, quantity: take, unit_price: m.sell_price,
                        gst_rate: gstEnabled ? m.gst_rate : 0, line_total: lineTotal });
      }
      if (remaining > 0) {
        db.exec('ROLLBACK');
        return bad(res, 400, `Insufficient stock of "${m.name} - ${m.company}". Only ${Number(it.quantity) - remaining} available.`);
      }
    }
    db.prepare('UPDATE sales SET subtotal = ?, gst_amount = ?, total = ? WHERE id = ?')
      .run(subtotal, gstAmount, subtotal + gstAmount, sr.lastInsertRowid);
    db.exec('COMMIT');
    res.json({
      sale: { id: Number(sr.lastInsertRowid), invoice_number: invNo, customer_name: (customer_name || '').trim(),
              subtotal, gst_amount: gstAmount, total: subtotal + gstAmount,
              created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), served_by: req.user.name },
      items: outItems,
    });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

app.get('/api/sales', requireAuth, (req, res) => {
  const { from, to } = req.query;
  const rows = db.prepare(`
    SELECT s.id, s.invoice_number, s.customer_name, s.subtotal, s.gst_amount, s.total, s.created_at,
           s.status, s.cancelled_at, s.cancel_reason,
           u.name AS served_by, COUNT(si.id) AS item_count,
           COALESCE(SUM(si.quantity), 0) AS units,
           COALESCE(SUM(si.returned_qty), 0) AS returned_units
    FROM sales s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE (? IS NULL OR date(s.created_at) >= ?)
      AND (? IS NULL OR date(s.created_at) <= ?)
    GROUP BY s.id ORDER BY s.id DESC LIMIT 300
  `).all(from || null, from || null, to || null, to || null);
  res.json(rows);
});

/** Full bill: every line, what has already been returned, and refund history. */
app.get('/api/sales/:id', requireAuth, (req, res) => {
  const sale = db.prepare(`
    SELECT s.*, u.name AS served_by FROM sales s
    JOIN users u ON u.id = s.user_id WHERE s.id = ?
  `).get(req.params.id);
  if (!sale) return bad(res, 404, 'Bill not found');

  const items = db.prepare(`
    SELECT id, medicine_id, batch_id, medicine_name, company, batch_number, expiry_date,
           quantity, returned_qty, (quantity - returned_qty) AS returnable_qty,
           unit_price, gst_rate, line_total
    FROM sale_items WHERE sale_id = ? ORDER BY id
  `).all(sale.id);

  const returns = db.prepare(`
    SELECT r.id, r.kind, r.reason, r.refund_amount, r.created_at, u.name AS user_name
    FROM sale_returns r JOIN users u ON u.id = r.user_id
    WHERE r.sale_id = ? ORDER BY r.id DESC
  `).all(sale.id);

  for (const r of returns) {
    r.items = db.prepare(`
      SELECT ri.quantity, ri.refund_amount, si.medicine_name, si.company, si.batch_number
      FROM sale_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id
      WHERE ri.return_id = ?
    `).all(r.id);
  }

  const refunded = returns.reduce((s, r) => s + r.refund_amount, 0);
  res.json({ sale, items, returns, refunded, net_total: sale.total - refunded });
});

/**
 * Cancel a whole bill: every unreturned unit goes back into the exact batch it
 * came from, and the sale is marked cancelled so reports stop counting it.
 */
app.post('/api/sales/:id/cancel', requireAuth, (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return bad(res, 404, 'Bill not found');
  if (sale.status === 'cancelled') return bad(res, 409, 'This bill is already cancelled');

  const reason = String(req.body?.reason || '').trim();
  const restock = req.body?.restock !== false; // default: put stock back
  const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(sale.id);
  const pending = items.filter((i) => i.quantity - i.returned_qty > 0);
  if (!pending.length) return bad(res, 409, 'Every item on this bill has already been returned');

  db.exec('BEGIN');
  try {
    let refund = 0;
    const rr = db.prepare(
      'INSERT INTO sale_returns (sale_id, user_id, kind, reason, refund_amount) VALUES (?, ?, ?, ?, 0)'
    ).run(sale.id, req.user.id, 'cancel', reason);

    for (const it of pending) {
      const qty = it.quantity - it.returned_qty;
      const lineRefund = qty * it.unit_price * (1 + (it.gst_rate || 0) / 100);
      refund += lineRefund;
      if (restock) {
        db.prepare('UPDATE batches SET quantity = quantity + ? WHERE id = ?').run(qty, it.batch_id);
      }
      db.prepare('UPDATE sale_items SET returned_qty = quantity WHERE id = ?').run(it.id);
      db.prepare(`
        INSERT INTO sale_return_items (return_id, sale_item_id, medicine_id, batch_id, quantity,
                                       unit_price, gst_rate, refund_amount, restocked)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(rr.lastInsertRowid, it.id, it.medicine_id, it.batch_id, qty,
             it.unit_price, it.gst_rate || 0, lineRefund, restock ? 1 : 0);
    }

    db.prepare('UPDATE sale_returns SET refund_amount = ? WHERE id = ?').run(refund, rr.lastInsertRowid);
    db.prepare(`
      UPDATE sales SET status = 'cancelled', cancelled_at = datetime('now','localtime'),
                       cancelled_by = ?, cancel_reason = ? WHERE id = ?
    `).run(req.user.id, reason, sale.id);
    db.exec('COMMIT');
    res.json({ ok: true, refund_amount: refund, restocked: restock, lines: pending.length });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

/**
 * Partial return: customer brings back some units. Each returned unit goes back
 * into its original batch so expiry tracking stays correct.
 * Body: { items: [{ sale_item_id, quantity }], reason, restock }
 */
app.post('/api/sales/:id/return', requireAuth, (req, res) => {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(req.params.id);
  if (!sale) return bad(res, 404, 'Bill not found');
  if (sale.status === 'cancelled') return bad(res, 409, 'This bill is cancelled — nothing left to return');

  const { items, reason } = req.body || {};
  const restock = req.body?.restock !== false;
  if (!Array.isArray(items) || !items.length) return bad(res, 400, 'Select at least one item to return');

  // Validate everything before touching stock.
  const planned = [];
  for (const req_it of items) {
    const line = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?')
      .get(req_it.sale_item_id, sale.id);
    if (!line) return bad(res, 404, `Item #${req_it.sale_item_id} is not on this bill`);
    const qty = Math.floor(Number(req_it.quantity));
    if (!Number.isFinite(qty) || qty <= 0) return bad(res, 400, `Invalid return quantity for ${line.medicine_name}`);
    const available = line.quantity - line.returned_qty;
    if (qty > available) {
      return bad(res, 400, `Cannot return ${qty} of “${line.medicine_name}” — only ${available} unreturned unit(s) on this bill`);
    }
    planned.push({ line, qty });
  }

  db.exec('BEGIN');
  try {
    let refund = 0;
    const rr = db.prepare(
      'INSERT INTO sale_returns (sale_id, user_id, kind, reason, refund_amount) VALUES (?, ?, ?, ?, 0)'
    ).run(sale.id, req.user.id, 'return', String(reason || '').trim());

    for (const { line, qty } of planned) {
      const lineRefund = qty * line.unit_price * (1 + (line.gst_rate || 0) / 100);
      refund += lineRefund;
      if (restock) {
        db.prepare('UPDATE batches SET quantity = quantity + ? WHERE id = ?').run(qty, line.batch_id);
      }
      db.prepare('UPDATE sale_items SET returned_qty = returned_qty + ? WHERE id = ?').run(qty, line.id);
      db.prepare(`
        INSERT INTO sale_return_items (return_id, sale_item_id, medicine_id, batch_id, quantity,
                                       unit_price, gst_rate, refund_amount, restocked)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(rr.lastInsertRowid, line.id, line.medicine_id, line.batch_id, qty,
             line.unit_price, line.gst_rate || 0, lineRefund, restock ? 1 : 0);
    }
    db.prepare('UPDATE sale_returns SET refund_amount = ? WHERE id = ?').run(refund, rr.lastInsertRowid);

    // If nothing is left unreturned, the bill becomes fully returned.
    const left = db.prepare('SELECT COALESCE(SUM(quantity - returned_qty),0) AS q FROM sale_items WHERE sale_id = ?')
      .get(sale.id).q;
    db.prepare('UPDATE sales SET status = ? WHERE id = ?')
      .run(left === 0 ? 'returned' : 'partial_return', sale.id);

    db.exec('COMMIT');
    res.json({ ok: true, refund_amount: refund, restocked: restock, remaining_units: left });
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
app.get('/api/alerts', requireAuth, (req, res) => {
  const low = db.prepare(`
    SELECT m.id, m.name, m.company, m.shelf, m.low_stock_threshold,
           COALESCE(SUM(b.quantity), 0) AS stock
    FROM medicines m
    LEFT JOIN batches b ON b.medicine_id = m.id
    WHERE m.active = 1
    GROUP BY m.id
    HAVING stock <= m.low_stock_threshold
    ORDER BY stock ASC
  `).all();

  const expiring = db.prepare(`
    SELECT b.id, b.batch_number, b.expiry_date, b.quantity,
           m.name, m.company, m.shelf,
           CAST(julianday(b.expiry_date) - julianday('now','localtime') AS INTEGER) AS days_left
    FROM batches b JOIN medicines m ON m.id = b.medicine_id
    WHERE b.quantity > 0 AND b.expiry_date <= date('now','localtime','+90 days')
    ORDER BY b.expiry_date ASC
  `).all();

  res.json({
    low,
    expiring,
    counts: { low: low.length, expiring: expiring.length },
  });
});

// ---------------------------------------------------------------------------
// Reports
//
// Money and units are always counted from *net* quantities: a cancelled bill
// contributes nothing, and a partially returned line only counts the units the
// customer kept. `net_qty` below is that surviving quantity.
// ---------------------------------------------------------------------------
const NET_QTY = '(si.quantity - si.returned_qty)';
const NOT_CANCELLED = `s.status != 'cancelled'`;

app.get('/api/reports/dashboard', requireAuth, (req, res) => {
  const today = db.prepare(`
    SELECT COUNT(DISTINCT s.id) AS bills,
           COALESCE(SUM(${NET_QTY} * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0) AS revenue
    FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE date(s.created_at) = date('now','localtime') AND ${NOT_CANCELLED}
  `).get();

  const todayProfit = db.prepare(`
    SELECT COALESCE(SUM((si.unit_price - si.cost_price) * ${NET_QTY}), 0) AS profit
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE date(s.created_at) = date('now','localtime') AND ${NOT_CANCELLED}
  `).get().profit;

  const last7 = db.prepare(`
    SELECT date(s.created_at) AS day,
           COALESCE(SUM(${NET_QTY} * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0) AS revenue,
           COUNT(DISTINCT s.id) AS bills
    FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE date(s.created_at) >= date('now','localtime','-6 days') AND ${NOT_CANCELLED}
    GROUP BY day ORDER BY day
  `).all();

  const alerts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM (
        SELECT m.id FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id
        WHERE m.active = 1 GROUP BY m.id
        HAVING COALESCE(SUM(b.quantity), 0) <= m.low_stock_threshold
      )) AS low,
      (SELECT COUNT(*) FROM batches
        WHERE quantity > 0 AND expiry_date <= date('now','localtime','+90 days')) AS expiring
  `).get();

  const topSellers = db.prepare(`
    SELECT si.medicine_name AS name, si.company, SUM(${NET_QTY}) AS qty,
           SUM(${NET_QTY} * si.unit_price) AS revenue
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE date(s.created_at) >= date('now','localtime','-6 days') AND ${NOT_CANCELLED}
    GROUP BY si.medicine_id HAVING qty > 0 ORDER BY qty DESC LIMIT 5
  `).all();

  res.json({ today, todayProfit, last7, alerts, topSellers });
});

app.get('/api/reports/sales', requireAuth, (req, res) => {
  const from = req.query.from || new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const to = req.query.to || new Date().toISOString().slice(0, 10);

  const summary = db.prepare(`
    SELECT COUNT(DISTINCT s.id) AS bills,
           COALESCE(SUM(${NET_QTY} * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0) AS revenue,
           COALESCE(SUM(${NET_QTY}), 0) AS units,
           COALESCE(SUM((si.unit_price - si.cost_price) * ${NET_QTY}), 0) AS profit
    FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE date(s.created_at) BETWEEN ? AND ? AND ${NOT_CANCELLED}
  `).get(from, to);

  // Cancellations, returns and written-off stock for the same window.
  const refunds = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(refund_amount),0) AS amount
    FROM sale_returns WHERE date(created_at) BETWEEN ? AND ?
  `).get(from, to);

  const cancelled = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS amount
    FROM sales WHERE status = 'cancelled' AND date(created_at) BETWEEN ? AND ?
  `).get(from, to);

  const writeoffs = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(quantity),0) AS units, COALESCE(SUM(cost_value),0) AS loss
    FROM stock_writeoffs WHERE date(created_at) BETWEEN ? AND ?
  `).get(from, to);

  const bestSellers = db.prepare(`
    SELECT si.medicine_name AS name, si.company, SUM(${NET_QTY}) AS qty,
           SUM(${NET_QTY} * si.unit_price) AS revenue,
           SUM((si.unit_price - si.cost_price) * ${NET_QTY}) AS profit
    FROM sale_items si JOIN sales s ON s.id = si.sale_id
    WHERE date(s.created_at) BETWEEN ? AND ? AND ${NOT_CANCELLED}
    GROUP BY si.medicine_id HAVING qty > 0 ORDER BY qty DESC LIMIT 10
  `).all(from, to);

  const sales = db.prepare(`
    SELECT s.id, s.invoice_number, s.total, s.subtotal, s.gst_amount, s.created_at, s.status,
           u.name AS served_by, COUNT(si.id) AS item_count,
           COALESCE(SUM(si.returned_qty),0) AS returned_units
    FROM sales s JOIN users u ON u.id = s.user_id
    LEFT JOIN sale_items si ON si.sale_id = s.id
    WHERE date(s.created_at) BETWEEN ? AND ?
    GROUP BY s.id ORDER BY s.id DESC LIMIT 100
  `).all(from, to);

  res.json({ from, to, summary, refunds, cancelled, writeoffs, bestSellers, sales });
});

// ---------------------------------------------------------------------------
// Settings & Users
// ---------------------------------------------------------------------------
app.get('/api/settings', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM settings WHERE id = 1').get());
});

app.put('/api/settings', requireAuth, requireOwner, (req, res) => {
  const s = db.prepare('SELECT * FROM settings WHERE id = 1').get();
  const b = req.body || {};
  db.prepare(`
    UPDATE settings SET store_name=?, store_address=?, phone=?, license_number=?,
                        gst_enabled=?, gst_number=? WHERE id=1
  `).run(
    (b.store_name ?? s.store_name).trim(), (b.store_address ?? s.store_address).trim(),
    (b.phone ?? s.phone).trim(), (b.license_number ?? s.license_number).trim(),
    b.gst_enabled !== undefined ? (b.gst_enabled ? 1 : 0) : s.gst_enabled,
    (b.gst_number ?? s.gst_number).trim()
  );
  res.json(db.prepare('SELECT * FROM settings WHERE id = 1').get());
});

app.get('/api/users', requireAuth, requireOwner, (req, res) => {
  const rows = db.prepare('SELECT id, username, name, role, active, created_at FROM users ORDER BY id').all();
  res.json(rows);
});

app.post('/api/users', requireAuth, requireOwner, (req, res) => {
  const { username, password, name, role } = req.body || {};
  if (!username?.trim() || !password || !name?.trim()) return bad(res, 400, 'Name, username and password are required');
  if (password.length < 5) return bad(res, 400, 'Password must be at least 5 characters');
  if (!['owner', 'employee'].includes(role)) return bad(res, 400, 'Invalid role');
  try {
    addUser(username.trim(), password, name.trim(), role);
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return bad(res, 409, 'That username is already taken');
    throw e;
  }
});

app.put('/api/users/:id', requireAuth, requireOwner, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return bad(res, 404, 'User not found');
  const b = req.body || {};
  if (u.id === req.user.id && b.active === false) return bad(res, 400, 'You cannot deactivate your own account');
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(b.active === false ? 0 : 1, u.id);
  // A deactivated user must lose their open sessions immediately.
  if (b.active === false) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ ok: true });
});

/** Owner resets a staff password (for the "I forgot my password" case). */
app.post('/api/users/:id/reset-password', requireAuth, requireOwner, (req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!u) return bad(res, 404, 'User not found');
  const pw = String(req.body?.new_password || '');
  if (pw.length < 6) return bad(res, 400, 'Password must be at least 6 characters');
  setUserPassword(u.id, pw);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); // force re-login
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------
app.get('/api/backups', requireAuth, requireOwner, (req, res) => {
  res.json(listBackups());
});

app.post('/api/backups', requireAuth, requireOwner, (req, res) => {
  try {
    const { file, size } = createBackup('manual');
    res.json({ ok: true, name: path.basename(file), size });
  } catch (e) {
    return bad(res, 500, 'Backup failed: ' + e.message);
  }
});

// ---------------------------------------------------------------------------
// Static client + error handling
// ---------------------------------------------------------------------------
const DIST = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(DIST));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(DIST, 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

app.listen(PORT, () => {
  console.log('');
  console.log('  💊 MediStock is running!');
  console.log(`  ➜  Open http://localhost:${PORT} in your browser`);
  console.log('  ➜  Demo logins ->  owner / owner123   |   staff / staff123');
  startAutoBackup();
  console.log('');
});
