const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { pool, transaction, addUser, verifyPassword, setUserPassword } = require('./db');

const app = express();

// CORS — allow the deployed frontend origin(s) and local dev
const allowedOrigins = [
  'http://localhost:5173',           // Vite dev server
  'http://localhost:3001',           // Local dev (server serves client)
  'https://medistock.vercel.app',    // Main Vercel frontend (adjust to your actual domain)
  'https://medistock-api.vercel.app', // API domain if different
  /^https:\/\/.*\.vercel\.app$/,     // Any Vercel preview deployment
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // server-to-server / curl
    const ok = allowedOrigins.some(o => o instanceof RegExp ? o.test(origin) : o === origin);
    callback(ok ? null : new Error('CORS: Origin not allowed'), ok);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
const SESSION_DAYS = 30;
const MAX_FAILED_LOGINS = 8;      // per username
const LOCKOUT_MINUTES = 15;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* Shareable invoice links: an unguessable token per sale so customers can open
   their bill without logging in. Derived from DATABASE_URL instead of stored —
   rotating the database rotates old links, which is acceptable. */
const INVOICE_SECRET = crypto.createHash('sha256')
  .update(String(process.env.DATABASE_URL || '') + '|medistock-invoice-share')
  .digest('hex');
function invoiceToken(saleId) {
  return crypto.createHmac('sha256', INVOICE_SECRET).update(String(saleId)).digest('hex').slice(0, 24);
}

app.set('trust proxy', true);
app.use(express.json({ limit: '15mb' })); // import upload sends the workbook as base64

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

const bad = (res, code, msg) => res.status(code).json({ error: msg });

// Route params used as ids are converted to numbers before touching the db.
const asId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };

// Normalize a company/brand name for matching: lowercase, & -> space, keep
// only a-z0-9, collapse spaces to dashes. Used everywhere a medicine's company
// is matched against the `companies` brand-logo directory.
const slugify = (s) => String(s || '')
  .toLowerCase()
  .replace(/&/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, '-');

/** Find the logo for a company name from the `companies` directory (or null). */
async function resolveCompanyLogo(companyName) {
  const key = slugify(companyName);
  if (!key) return null;
  const { rows } = await pool.query('SELECT name, aliases, logo_url FROM companies');
  for (const c of rows) {
    const keys = [c.name, ...String(c.aliases || '').split(',')].map(slugify).filter(Boolean);
    if (keys.includes(key)) return c.logo_url || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sessions — persisted in PostgreSQL so they survive serverless instances
// ---------------------------------------------------------------------------
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await pool.query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3::int))',
    [token, userId, SESSION_DAYS]
  );
  return token;
}

function requireAuth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in', code: 'session_invalid' });
  pool.query(
    'SELECT s.token, u.id, u.username, u.name, u.role, u.active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = $1 AND s.expires_at > now()',
    [token]
  ).then(({ rows }) => {
    const row = rows[0];
    if (!row || !row.active) {
      return res.status(401).json({ error: 'Session expired — please log in again', code: 'session_invalid' });
    }
    pool.query('UPDATE sessions SET last_seen = now() WHERE token = $1', [token]).catch(() => {});
    req.user = { id: row.id, username: row.username, name: row.name, role: row.role };
    req.token = token;
    next();
  }).catch(next);
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access only' });
  next();
}

// ---------------------------------------------------------------------------
// Login rate limiting
// ---------------------------------------------------------------------------
function recentFailures(username) {
  return pool.query(
    'SELECT COUNT(*)::int AS c FROM login_attempts WHERE username = $1 AND success = 0 AND created_at > now() - make_interval(mins => $2::int)',
    [username, LOCKOUT_MINUTES]
  ).then(r => r.rows[0].c);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// First-time Admin Signup (only allowed when NO owner exists)
// ---------------------------------------------------------------------------
app.post('/api/auth/signup', async (req, res, next) => {
  try {
    // Check if any owner already exists
    const owner = (await pool.query("SELECT id FROM users WHERE role = 'owner' AND active = 1 LIMIT 1")).rows[0];
    if (owner) {
      return bad(res, 403, 'Admin already exists. Please sign in or contact the admin.');
    }

    const { username, password, name } = req.body || {};
    if (!username?.trim() || !password || !name?.trim()) {
      return bad(res, 400, 'Name, username and password are required');
    }
    if (String(password).length < 6) {
      return bad(res, 400, 'Password must be at least 6 characters');
    }

    const uname = String(username).trim();
    const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [uname]);
    if (rows[0]) {
      return bad(res, 409, 'That username is already taken');
    }

    // Create the first owner
    const userId = await addUser(uname, String(password), String(name).trim(), 'owner');
    const token = await createSession(userId);
    res.json({ token, user: { id: userId, username: uname, name: String(name).trim(), role: 'owner' } });
  } catch (e) { next(e); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return bad(res, 400, 'Username and password required');
    const uname = String(username).trim();
    const ip = String(req.ip || '').slice(0, 100);

    if (await recentFailures(uname) >= MAX_FAILED_LOGINS) {
      return bad(res, 429, 'Too many failed attempts. Try again in a few minutes.');
    }

    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1 AND active = 1', [uname]);
    const u = rows[0];
    // Login attempts are recorded parameterized and clamped to the column
    // widths (username VARCHAR(255), ip VARCHAR(100)) — nothing user-supplied
    // reaches SQL raw. Old rows are purged to keep the table small.
    if (!u || !(await verifyPassword(u, String(password)))) {
      await pool.query('INSERT INTO login_attempts (username, ip, success) VALUES ($1, $2, $3)',
        [uname.slice(0, 255), ip.slice(0, 100), 0]);
      await pool.query("DELETE FROM login_attempts WHERE created_at < now() - interval '2 days'");
      return bad(res, 401, 'Invalid username or password');
    }
    await pool.query('INSERT INTO login_attempts (username, ip, success) VALUES ($1, $2, $3)',
      [uname.slice(0, 255), ip.slice(0, 100), 1]);
    await pool.query("DELETE FROM login_attempts WHERE created_at < now() - interval '2 days'");
    const token = await createSession(u.id);
    res.json({ token, user: { id: u.id, username: u.username, name: u.name, role: u.role } });
  } catch (e) { next(e); }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM sessions WHERE token = $1', [req.token]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json(req.user));

app.post('/api/auth/change-password', requireAuth, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) return bad(res, 400, 'Current and new password are required');
    if (String(new_password).length < 6) return bad(res, 400, 'New password must be at least 6 characters');
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.user.id]);
    const u = rows[0];
    // A wrong current password is a validation failure, not an invalid session —
    // 422 keeps the client from treating it as a logout.
    if (!(await verifyPassword(u, String(current_password)))) {
      return res.status(422).json({ error: 'Current password is incorrect' });
    }
    await setUserPassword(u.id, String(new_password));
    // log out every other device for this user
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token != $2', [u.id, req.token]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Medicines (catalog)
// ---------------------------------------------------------------------------
app.get('/api/medicines', requireAuth, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const like = '%' + q + '%';
    const { rows } = await pool.query(
      'SELECT m.id, m.name, m.company, m.type, m.shelf, m.buy_price::float8 AS buy_price, m.sell_price::float8 AS sell_price, m.gst_rate::float8 AS gst_rate, m.low_stock_threshold, m.logo_url, COALESCE(SUM(b.quantity), 0)::int AS stock, MIN(CASE WHEN b.quantity > 0 THEN b.expiry_date END) AS nearest_expiry FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id WHERE m.active = 1 AND (m.name ILIKE $1 OR m.company ILIKE $1) GROUP BY m.id ORDER BY m.name LIMIT 500',
      [like]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/medicines/:id/batches', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, batch_number, expiry_date, quantity, (expiry_date - CURRENT_DATE) AS days_left FROM batches WHERE medicine_id = $1 AND quantity > 0 ORDER BY expiry_date ASC',
      [asId(req.params.id)]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

/** Every batch of a medicine including empty ones, plus write-off history. */
app.get('/api/medicines/:id/detail', requireAuth, async (req, res, next) => {
  try {
    const medId = asId(req.params.id);
    const med = (await pool.query('SELECT * FROM medicines WHERE id = $1', [medId])).rows[0];
    if (!med) return bad(res, 404, 'Medicine not found');
    const batches = (await pool.query(
      'SELECT id, batch_number, expiry_date, quantity, (expiry_date - CURRENT_DATE) AS days_left FROM batches WHERE medicine_id = $1 ORDER BY expiry_date ASC',
      [medId]
    )).rows;
    const writeoffs = (await pool.query(
      'SELECT w.id, w.batch_number, w.expiry_date, w.quantity, w.cost_value::float8 AS cost_value, w.reason, w.note, w.created_at, u.name AS user_name FROM stock_writeoffs w JOIN users u ON u.id = w.user_id WHERE w.medicine_id = $1 ORDER BY w.id DESC LIMIT 50',
      [medId]
    )).rows;
    const totalStock = batches.reduce((s, b) => s + b.quantity, 0);
    res.json({ medicine: med, batches, writeoffs, totalStock });
  } catch (e) { next(e); }
});

/** Remove expired or damaged stock from a batch, keeping an audit record. */
app.post('/api/batches/:id/writeoff', requireAuth, async (req, res, next) => {
  try {
    const { quantity, reason, note } = req.body || {};
    const batch = (await pool.query(
      'SELECT b.*, m.name, m.company, m.buy_price::float8 AS buy_price FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.id = $1',
      [asId(req.params.id)]
    )).rows[0];
    if (!batch) return bad(res, 404, 'Batch not found');

    const qty = Math.floor(Number(quantity));
    if (!Number.isFinite(qty) || qty <= 0) return bad(res, 400, 'Quantity must be more than 0');
    if (qty > batch.quantity) return bad(res, 400, 'Only ' + batch.quantity + ' units left in batch ' + batch.batch_number);
    const allowed = ['expired', 'damaged', 'lost', 'other'];
    const why = allowed.includes(reason) ? reason : 'expired';

    await transaction(async (client) => {
      await client.query('UPDATE batches SET quantity = quantity - $1 WHERE id = $2', [qty, batch.id]);
      await client.query(
        'INSERT INTO stock_writeoffs (batch_id, medicine_id, medicine_name, company, batch_number, expiry_date, quantity, cost_value, reason, note, user_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)',
        [batch.id, batch.medicine_id, batch.name, batch.company, batch.batch_number,
         batch.expiry_date, qty, qty * batch.buy_price, why, String(note || '').trim(), req.user.id]
      );
    });
    res.json({ ok: true, removed: qty, cost_value: qty * batch.buy_price });
  } catch (e) { next(e); }
});

app.get('/api/writeoffs', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT w.*, w.cost_value::float8 AS cost_value, u.name AS user_name FROM stock_writeoffs w JOIN users u ON u.id = w.user_id ORDER BY w.id DESC LIMIT 200'
    );
    const total = rows.reduce((s, r) => s + Number(r.cost_value), 0);
    res.json({ rows, total_loss: total });
  } catch (e) { next(e); }
});

/** Soft delete — the medicine leaves the catalog but its sales history stays intact. */
app.delete('/api/medicines/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const medId = asId(req.params.id);
    const med = (await pool.query('SELECT * FROM medicines WHERE id = $1 AND active = 1', [medId])).rows[0];
    if (!med) return bad(res, 404, 'Medicine not found');
    const stock = (await pool.query('SELECT COALESCE(SUM(quantity),0)::int AS q FROM batches WHERE medicine_id = $1', [med.id])).rows[0].q;
    if (stock > 0 && !req.query.force) {
      return bad(res, 409, '"' + med.name + '" still has ' + stock + ' units in stock. Write off or sell the stock first, or confirm forced removal.');
    }
    await pool.query('UPDATE medicines SET active = 0 WHERE id = $1', [med.id]);
    res.json({ ok: true, had_stock: stock });
  } catch (e) { next(e); }
});

app.post('/api/medicines', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const { name, company, type, shelf, buy_price, sell_price, gst_rate, low_stock_threshold, logo_url } = req.body || {};
    if (!name?.trim() || !company?.trim()) return bad(res, 400, 'Medicine name and company are required');
    if (Number(sell_price) <= 0) return bad(res, 400, 'Sell price must be greater than 0');

    const nm = String(name).trim();
    const co = String(company).trim();
    const logo = String(logo_url || '').trim() || await resolveCompanyLogo(co);

    // A removed medicine keeps its row (sales history references it), so adding
    // the same name + company again revives that row instead of failing.
    const existing = (await pool.query('SELECT * FROM medicines WHERE name = $1 AND company = $2', [nm, co])).rows[0];
    if (existing && existing.active === 1) {
      return bad(res, 409, 'This medicine + company already exists in the catalog');
    }
    if (existing) {
      await pool.query(
        'UPDATE medicines SET active = 1, type = $1, shelf = $2, buy_price = $3, sell_price = $4, gst_rate = $5, low_stock_threshold = $6, logo_url = $7 WHERE id = $8',
        [String(type || 'Tablet'), String(shelf || '').trim(), Number(buy_price) || 0, Number(sell_price) || 0,
         Number(gst_rate) || 0, Number(low_stock_threshold) || 10, logo, existing.id]
      );
      return res.json({ id: existing.id, restored: true });
    }

    const r = await pool.query(
      'INSERT INTO medicines (name, company, type, shelf, buy_price, sell_price, gst_rate, low_stock_threshold, logo_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
      [nm, co, String(type || 'Tablet'), String(shelf || '').trim(),
       Number(buy_price) || 0, Number(sell_price) || 0, Number(gst_rate) || 0, Number(low_stock_threshold) || 10, logo]
    );
    res.json({ id: r.rows[0].id });
  } catch (e) { next(e); }
});

app.put('/api/medicines/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const m = (await pool.query('SELECT * FROM medicines WHERE id = $1', [asId(req.params.id)])).rows[0];
    if (!m) return bad(res, 404, 'Medicine not found');
    const b = req.body || {};
    const newCompany = String(b.company ?? m.company).trim();
    const companyChanged = newCompany.toLowerCase() !== String(m.company || '').toLowerCase();
    let logo;
    if (b.logo_url != null && String(b.logo_url).trim()) {
      logo = String(b.logo_url).trim();
    } else if ('logo_url' in b) {
      logo = null;
    } else if (companyChanged || !m.logo_url) {
      logo = await resolveCompanyLogo(newCompany);
    } else {
      logo = m.logo_url;
    }
    await pool.query(
      'UPDATE medicines SET name=$1, company=$2, type=$3, shelf=$4, buy_price=$5, sell_price=$6, gst_rate=$7, low_stock_threshold=$8, logo_url=$9 WHERE id=$10',
      [
        String(b.name ?? m.name).trim(), newCompany, String(b.type ?? m.type),
        String(b.shelf ?? m.shelf).trim(), Number(b.buy_price ?? m.buy_price) || 0,
        Number(b.sell_price ?? m.sell_price) || 0, Number(b.gst_rate ?? m.gst_rate) || 0,
        Number(b.low_stock_threshold ?? m.low_stock_threshold) || 0, logo, m.id
      ]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Companies (brand-logo directory)
// ---------------------------------------------------------------------------
app.get('/api/companies', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, slug, aliases, logo_url FROM companies ORDER BY name'
    );
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/companies', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const { name, aliases, logo_url } = req.body || {};
    const nm = String(name || '').trim();
    if (!nm) return bad(res, 400, 'Company name is required');
    const slug = slugify(nm);
    if (!slug) return bad(res, 400, 'Company name must contain letters or numbers');
    const r = await pool.query(
      'INSERT INTO companies (name, slug, aliases, logo_url) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING RETURNING id',
      [nm, slug, String(aliases || '').trim(), String(logo_url || '').trim() || null]
    );
    if (!r.rows[0]) return bad(res, 409, 'A company with this name already exists');
    res.json({ id: r.rows[0].id, slug });
  } catch (e) { next(e); }
});

app.put('/api/companies/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const c = (await pool.query('SELECT * FROM companies WHERE id = $1', [asId(req.params.id)])).rows[0];
    if (!c) return bad(res, 404, 'Company not found');
    const { name, aliases, logo_url } = req.body || {};
    const nm = String(name ?? c.name).trim();
    const slug = slugify(nm);
    if (!slug) return bad(res, 400, 'Company name must contain letters or numbers');
    await pool.query(
      'UPDATE companies SET name = $1, slug = $2, aliases = $3, logo_url = $4 WHERE id = $5',
      [nm, slug, 'aliases' in req.body ? String(aliases || '').trim() : c.aliases,
       'logo_url' in req.body ? (String(logo_url || '').trim() || null) : c.logo_url, c.id]
    );
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.delete('/api/companies/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM companies WHERE id = $1', [asId(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Purchases (stock IN - manual entry; invoice scanning comes later)
// ---------------------------------------------------------------------------
app.get('/api/purchases', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT p.id, p.invoice_number, p.supplier_name, p.total::float8 AS total, p.created_at, p.status, p.reversed_at, p.reverse_reason, u.name AS created_by, COUNT(pi.id)::int AS item_count FROM purchases p JOIN users u ON u.id = p.user_id LEFT JOIN purchase_items pi ON pi.purchase_id = p.id GROUP BY p.id, u.name ORDER BY p.id DESC LIMIT 200'
    );
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/purchases/:id', requireAuth, async (req, res, next) => {
  try {
    const p = (await pool.query(
      'SELECT p.*, p.total::float8 AS total, u.name AS created_by FROM purchases p JOIN users u ON u.id = p.user_id WHERE p.id = $1',
      [asId(req.params.id)]
    )).rows[0];
    if (!p) return bad(res, 404, 'Purchase not found');
    const items = (await pool.query(
      'SELECT pi.*, pi.buy_price::float8 AS buy_price, m.name AS medicine_name, m.company FROM purchase_items pi JOIN medicines m ON m.id = pi.medicine_id WHERE pi.purchase_id = $1',
      [p.id]
    )).rows;
    res.json({ purchase: p, items });
  } catch (e) { next(e); }
});

/**
 * Undo a purchase entered by mistake: pull the same quantities back out of the
 * batches. Refuses when the stock has already been sold, because reversing then
 * would make the batch quantity negative and corrupt the ledger.
 */
app.post('/api/purchases/:id/reverse', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const p = (await pool.query('SELECT * FROM purchases WHERE id = $1', [asId(req.params.id)])).rows[0];
    if (!p) return bad(res, 404, 'Purchase not found');
    if (p.status === 'reversed') return bad(res, 409, 'This purchase is already reversed');

    const items = (await pool.query('SELECT * FROM purchase_items WHERE purchase_id = $1', [p.id])).rows;
    if (!items.length) return bad(res, 400, 'This purchase has no items');

    // Check every line can be pulled back before changing anything.
    for (const it of items) {
      const b = (await pool.query(
        'SELECT b.*, m.name FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.medicine_id = $1 AND b.batch_number = $2',
        [it.medicine_id, it.batch_number]
      )).rows[0];
      if (!b) return bad(res, 409, 'Batch ' + it.batch_number + ' no longer exists — cannot reverse');
      if (b.quantity < it.quantity) {
        return bad(res, 409, 'Cannot reverse: only ' + b.quantity + ' of the ' + it.quantity + ' units of "' + b.name + '" batch ' + it.batch_number + ' are still in stock (the rest was already sold).');
      }
    }

    await transaction(async (client) => {
      for (const it of items) {
        await client.query(
          'UPDATE batches SET quantity = quantity - $1 WHERE medicine_id = $2 AND batch_number = $3',
          [it.quantity, it.medicine_id, it.batch_number]
        );
      }
      await client.query(
        "UPDATE purchases SET status = 'reversed', reversed_at = now(), reversed_by = $1, reverse_reason = $2 WHERE id = $3",
        [req.user.id, String(req.body?.reason || '').trim(), p.id]
      );
    });
    res.json({ ok: true, reversed_items: items.length });
  } catch (e) { next(e); }
});

app.post('/api/purchases', requireAuth, async (req, res, next) => {
  try {
    const { supplier_name, invoice_number, items } = req.body || {};
    if (!Array.isArray(items) || !items.length) return bad(res, 400, 'Add at least one item to the purchase');
    for (const it of items) {
      if (!it.medicine_id) return bad(res, 400, 'Select a medicine for every item');
      if (!it.batch_number?.trim()) return bad(res, 400, 'Batch number is required for every item');
      if (!DATE_RE.test(it.expiry_date || '')) return bad(res, 400, 'Valid expiry date is required for every item');
      if (!Number.isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) return bad(res, 400, 'Quantity must be more than 0');
      if (Number(it.buy_price) < 0) return bad(res, 400, 'Buy price cannot be negative');
    }

    let total = 0;
    const purchaseId = await transaction(async (client) => {
      const pr = await client.query(
        'INSERT INTO purchases (invoice_number, supplier_name, user_id, total) VALUES ($1, $2, $3, 0) RETURNING id',
        [String(invoice_number || '').trim() || 'PINV-' + Date.now(), String(supplier_name || '').trim(), req.user.id]
      );
      const pid = pr.rows[0].id;
      for (const it of items) {
        const qty = Math.floor(Number(it.quantity));
        const bp = Number(it.buy_price) || 0;
        const medId = asId(it.medicine_id);
        const bno = String(it.batch_number).trim();
        const exp = String(it.expiry_date);
        total += qty * bp;
        await client.query(
          'INSERT INTO purchase_items (purchase_id, medicine_id, batch_number, expiry_date, quantity, buy_price) VALUES ($1, $2, $3, $4, $5, $6)',
          [pid, medId, bno, exp, qty, bp]
        );
        // Add stock: create the batch if new, otherwise add quantity to the existing batch
        await client.query(
          'INSERT INTO batches (medicine_id, batch_number, expiry_date, quantity) VALUES ($1, $2, $3, $4) ON CONFLICT(medicine_id, batch_number) DO UPDATE SET quantity = batches.quantity + excluded.quantity',
          [medId, bno, exp, qty]
        );
        // Keep the medicine's buy price in sync with the latest purchase
        await client.query('UPDATE medicines SET buy_price = $1 WHERE id = $2', [bp, medId]);
      }
      await client.query('UPDATE purchases SET total = $1 WHERE id = $2', [total, pid]);
      return pid;
    });
    res.json({ id: purchaseId, total });
  } catch (e) {
    if (String(e.message).includes('unique_constraint') || String(e.message).includes('duplicate key')) {
      return bad(res, 409, 'Duplicate batch entry in this purchase');
    }
    next(e);
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
app.put('/api/purchases/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const p = (await pool.query('SELECT * FROM purchases WHERE id = $1', [asId(req.params.id)])).rows[0];
    if (!p) return bad(res, 404, 'Purchase not found');
    if (p.status === 'reversed') return bad(res, 409, 'Cannot edit a reversed purchase');

    const { supplier_name, invoice_number, items } = req.body || {};
    if (!Array.isArray(items) || !items.length) return bad(res, 400, 'Add at least one item to the purchase');
    for (const it of items) {
      if (!it.medicine_id) return bad(res, 400, 'Select a medicine for every item');
      if (!it.batch_number?.trim()) return bad(res, 400, 'Batch number is required for every item');
      if (!DATE_RE.test(it.expiry_date || '')) return bad(res, 400, 'Valid expiry date is required for every item');
      if (!Number.isFinite(Number(it.quantity)) || Number(it.quantity) <= 0) return bad(res, 400, 'Quantity must be more than 0');
      if (Number(it.buy_price) < 0) return bad(res, 400, 'Buy price cannot be negative');
    }

    const oldItems = (await pool.query('SELECT * FROM purchase_items WHERE purchase_id = $1', [p.id])).rows;
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
    const newAgg = agg(items, it => ({ medicine_id: asId(it.medicine_id), batch_number: String(it.batch_number).trim(), qty: Math.floor(Number(it.quantity)) }));
    for (const o of oldAgg) {
      const n = newAgg.find(x => x.medicine_id === o.medicine_id && x.batch_number === o.batch_number);
      const reduction = o.qty - (n ? n.qty : 0);
      if (reduction > 0) {
        const b = (await pool.query(
          'SELECT b.*, m.name FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.medicine_id = $1 AND b.batch_number = $2',
          [o.medicine_id, o.batch_number]
        )).rows[0];
        if (!b) return bad(res, 409, 'Batch ' + o.batch_number + ' no longer exists — cannot edit');
        if (b.quantity < reduction) {
          return bad(res, 409, 'Cannot reduce: only ' + b.quantity + ' of batch ' + o.batch_number + ' ("' + b.name + '") is still in stock — the rest was already sold.');
        }
      }
    }

    let total = 0;
    await transaction(async (client) => {
      // 1. Reverse the old line items — pull their quantities back out of batches.
      for (const it of oldItems) {
        await client.query(
          'UPDATE batches SET quantity = quantity - $1 WHERE medicine_id = $2 AND batch_number = $3',
          [it.quantity, it.medicine_id, it.batch_number]
        );
      }
      // 2. Replace the purchase_items rows.
      await client.query('DELETE FROM purchase_items WHERE purchase_id = $1', [p.id]);
      // 3. Apply the new line items — put their quantities back into batches.
      for (const it of items) {
        const qty = Math.floor(Number(it.quantity));
        const bp = Number(it.buy_price) || 0;
        const medId = asId(it.medicine_id);
        const bno = String(it.batch_number).trim();
        const exp = String(it.expiry_date);
        total += qty * bp;
        await client.query(
          'INSERT INTO purchase_items (purchase_id, medicine_id, batch_number, expiry_date, quantity, buy_price) VALUES ($1, $2, $3, $4, $5, $6)',
          [p.id, medId, bno, exp, qty, bp]
        );
        await client.query(
          'INSERT INTO batches (medicine_id, batch_number, expiry_date, quantity) VALUES ($1, $2, $3, $4) ON CONFLICT(medicine_id, batch_number) DO UPDATE SET quantity = batches.quantity + excluded.quantity',
          [medId, bno, exp, qty]
        );
        await client.query('UPDATE medicines SET buy_price = $1 WHERE id = $2', [bp, medId]);
      }
      // 4. Update the purchase header and the recalculated total.
      await client.query(
        'UPDATE purchases SET invoice_number = $1, supplier_name = $2, total = $3 WHERE id = $4',
        [String(invoice_number || '').trim() || 'PINV-' + Date.now(), String(supplier_name || '').trim(), total, p.id]
      );
    });
    res.json({ id: p.id, total });
  } catch (e) {
    if (String(e.message).includes('unique_constraint') || String(e.message).includes('duplicate key')) {
      return bad(res, 409, 'Duplicate batch entry in this purchase');
    }
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Sales / Billing (stock OUT - automatic, FEFO)
// ---------------------------------------------------------------------------
app.post('/api/sales', requireAuth, async (req, res, next) => {
  try {
    const { items, customer_name, customer_phone } = req.body || {};
    if (!Array.isArray(items) || !items.length) return bad(res, 400, 'Cart is empty');
    for (const it of items) {
      if (!Number.isInteger(Number(it.quantity)) || Number(it.quantity) <= 0)
        return bad(res, 400, 'Invalid quantity');
    }
    const settings = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const gstEnabled = !!settings?.gst_enabled;
    const custName = String(customer_name || '').trim();
    const custPhone = String(customer_phone || '').replace(/[^\d+]/g, '').slice(0, 20);

    const result = await transaction(async (client) => {
      const maxId = (await client.query('SELECT COALESCE(MAX(id), 0) AS m FROM sales')).rows[0].m + 1;
      const invNo = 'INV-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + String(maxId).padStart(4, '0') + '-' + crypto.randomInt(1000, 10000);
      const sr = await client.query(
        'INSERT INTO sales (invoice_number, user_id, customer_name, customer_phone, subtotal, gst_amount, total) VALUES ($1, $2, $3, $4, 0, 0, 0) RETURNING id',
        [invNo, req.user.id, custName, custPhone]
      );
      const saleId = sr.rows[0].id;

      let subtotal = 0, gstAmount = 0;
      const outItems = [];
      for (const it of items) {
        const m = (await client.query('SELECT * FROM medicines WHERE id = $1 AND active = 1', [asId(it.medicine_id)])).rows[0];
        if (!m) { const err = new Error('Medicine #' + asId(it.medicine_id) + ' not found'); err.status = 404; err.expose = true; throw err; }

        // FEFO: allocate from batches that expire soonest first
        const batches = (await client.query(
          'SELECT id, batch_number, expiry_date, quantity FROM batches WHERE medicine_id = $1 AND quantity > 0 ORDER BY expiry_date ASC, id ASC', [m.id]
        )).rows;
        let remaining = Number(it.quantity);
        for (const b of batches) {
          if (remaining <= 0) break;
          const take = Math.min(b.quantity, remaining);
          remaining -= take;
          const lineTotal = take * m.sell_price;
          const lineGst = gstEnabled ? (lineTotal * m.gst_rate) / 100 : 0;
          subtotal += lineTotal;
          gstAmount += lineGst;
          await client.query('UPDATE batches SET quantity = quantity - $1 WHERE id = $2', [take, b.id]);
          await client.query(
            'INSERT INTO sale_items (sale_id, medicine_id, batch_id, medicine_name, company, batch_number, expiry_date, quantity, unit_price, cost_price, gst_rate, line_total) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
            [saleId, m.id, b.id, m.name, m.company, b.batch_number, b.expiry_date,
             take, m.sell_price, m.buy_price, gstEnabled ? m.gst_rate : 0, lineTotal]
          );
          outItems.push({ medicine_name: m.name, company: m.company, batch_number: b.batch_number,
                          expiry_date: b.expiry_date, quantity: take, unit_price: Number(m.sell_price),
                          gst_rate: gstEnabled ? Number(m.gst_rate) : 0, line_total: Number(lineTotal) });
        }
        if (remaining > 0) {
          const err = new Error('Insufficient stock of "' + m.name + ' - ' + m.company + '". Only ' + (Number(it.quantity) - remaining) + ' available.');
          err.status = 400; err.expose = true; throw err;
        }
      }
      await client.query(
        'UPDATE sales SET subtotal = $1, gst_amount = $2, total = $3 WHERE id = $4',
        [subtotal, gstAmount, subtotal + gstAmount, saleId]
      );
      return { saleId, invNo, subtotal, gstAmount, outItems };
    });
    res.json({
      sale: { id: result.saleId, invoice_number: result.invNo, customer_name: custName,
              customer_phone: custPhone,
              subtotal: result.subtotal, gst_amount: result.gstAmount, total: result.subtotal + result.gstAmount,
              created_at: new Date().toISOString().slice(0, 19).replace('T', ' '), served_by: req.user.name,
              share_token: invoiceToken(result.saleId) },
      items: result.outItems,
    });
  } catch (e) {
    if (e.expose) return bad(res, e.status || 400, e.message);
    next(e);
  }
});

app.get('/api/sales', requireAuth, async (req, res, next) => {
  try {
    // Only well-formed YYYY-MM-DD filters reach the database; a missing or
    // malformed filter opens the bound to cover all history instead.
    const qFrom = String(req.query.from || '');
    const qTo = String(req.query.to || '');
    const from = DATE_RE.test(qFrom) ? qFrom : '1970-01-01';
    const to = DATE_RE.test(qTo) ? qTo : '2999-12-31';
    const { rows } = await pool.query(
      'SELECT s.id, s.invoice_number, s.customer_name, s.subtotal, s.gst_amount, s.total, s.created_at, s.status, s.cancelled_at, s.cancel_reason, u.name AS served_by, COUNT(si.id)::int AS item_count, COALESCE(SUM(si.quantity), 0)::int AS units, COALESCE(SUM(si.returned_qty), 0)::int AS returned_units FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.created_at::date BETWEEN $1 AND $2 GROUP BY s.id, u.name ORDER BY s.id DESC LIMIT 300',
      [from, to]
    );
    // NUMERIC comes back as strings — hand the client plain numbers.
    for (const r of rows) {
      r.subtotal = Number(r.subtotal);
      r.gst_amount = Number(r.gst_amount);
      r.total = Number(r.total);
    }
    res.json(rows);
  } catch (e) { next(e); }
});

/** Full bill: every line, what has already been returned, and refund history. */
app.get('/api/sales/:id', requireAuth, async (req, res, next) => {
  try {
    const sale = (await pool.query(
      'SELECT s.*, s.subtotal::float8 AS subtotal, s.gst_amount::float8 AS gst_amount, s.total::float8 AS total, u.name AS served_by FROM sales s JOIN users u ON u.id = s.user_id WHERE s.id = $1',
      [asId(req.params.id)]
    )).rows[0];
    if (!sale) return bad(res, 404, 'Bill not found');

    const items = (await pool.query(
      'SELECT id, medicine_id, batch_id, medicine_name, company, batch_number, expiry_date, quantity, returned_qty, (quantity - returned_qty) AS returnable_qty, unit_price::float8 AS unit_price, gst_rate::float8 AS gst_rate, line_total::float8 AS line_total FROM sale_items WHERE sale_id = $1 ORDER BY id',
      [sale.id]
    )).rows;

    const returns = (await pool.query(
      'SELECT r.id, r.kind, r.reason, r.refund_amount::float8 AS refund_amount, r.created_at, u.name AS user_name FROM sale_returns r JOIN users u ON u.id = r.user_id WHERE r.sale_id = $1 ORDER BY r.id DESC',
      [sale.id]
    )).rows;

    for (const r of returns) {
      r.items = (await pool.query(
        'SELECT ri.quantity, ri.refund_amount::float8 AS refund_amount, si.medicine_name, si.company, si.batch_number FROM sale_return_items ri JOIN sale_items si ON si.id = ri.sale_item_id WHERE ri.return_id = $1',
        [r.id]
      )).rows;
    }

    const refunded = returns.reduce((s, r) => s + Number(r.refund_amount), 0);
    res.json({ sale, items, returns, refunded, net_total: Number(sale.total) - refunded });
  } catch (e) { next(e); }
});

/**
 * Cancel a whole bill: every unreturned unit goes back into the exact batch it
 * came from, and the sale is marked cancelled so reports stop counting it.
 */
app.post('/api/sales/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const sale = (await pool.query('SELECT * FROM sales WHERE id = $1', [asId(req.params.id)])).rows[0];
    if (!sale) return bad(res, 404, 'Bill not found');
    if (sale.status === 'cancelled') return bad(res, 409, 'This bill is already cancelled');

    const reason = String(req.body?.reason || '').trim();
    const restock = req.body?.restock !== false; // default: put stock back
    const items = (await pool.query('SELECT * FROM sale_items WHERE sale_id = $1', [sale.id])).rows;
    const pending = items.filter((i) => i.quantity - i.returned_qty > 0);
    if (!pending.length) return bad(res, 409, 'Every item on this bill has already been returned');

    const out = await transaction(async (client) => {
      let refund = 0;
      const rr = await client.query(
        'INSERT INTO sale_returns (sale_id, user_id, kind, reason, refund_amount) VALUES ($1, $2, $3, $4, 0) RETURNING id',
        [sale.id, req.user.id, 'cancel', reason]
      );
      const rid = rr.rows[0].id;

      for (const it of pending) {
        const qty = it.quantity - it.returned_qty;
        const lineRefund = qty * it.unit_price * (1 + (it.gst_rate || 0) / 100);
        refund += lineRefund;
        if (restock) {
          await client.query('UPDATE batches SET quantity = quantity + $1 WHERE id = $2', [qty, it.batch_id]);
        }
        await client.query('UPDATE sale_items SET returned_qty = quantity WHERE id = $1', [it.id]);
        await client.query(
          'INSERT INTO sale_return_items (return_id, sale_item_id, medicine_id, batch_id, quantity, unit_price, gst_rate, refund_amount, restocked) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [rid, it.id, it.medicine_id, it.batch_id, qty, it.unit_price, it.gst_rate || 0, lineRefund, restock ? 1 : 0]
        );
      }

      await client.query('UPDATE sale_returns SET refund_amount = $1 WHERE id = $2', [refund, rid]);
      await client.query(
        "UPDATE sales SET status = 'cancelled', cancelled_at = now(), cancelled_by = $1, cancel_reason = $2 WHERE id = $3",
        [req.user.id, reason, sale.id]
      );
      return { refund, lines: pending.length };
    });
    res.json({ ok: true, refund_amount: Number(out.refund.toFixed(2)), restocked: restock, lines: out.lines });
  } catch (e) { next(e); }
});

/**
 * Partial return: customer brings back some units. Each returned unit goes back
 * into its original batch so expiry tracking stays correct.
 * Body: { items: [{ sale_item_id, quantity }], reason, restock }
 */
app.post('/api/sales/:id/return', requireAuth, async (req, res, next) => {
  try {
    const sale = (await pool.query('SELECT * FROM sales WHERE id = $1', [asId(req.params.id)])).rows[0];
    if (!sale) return bad(res, 404, 'Bill not found');
    if (sale.status === 'cancelled') return bad(res, 409, 'This bill is cancelled — nothing left to return');

    const { items, reason } = req.body || {};
    const restock = req.body?.restock !== false;
    if (!Array.isArray(items) || !items.length) return bad(res, 400, 'Select at least one item to return');

    // Validate everything before touching stock.
    const planned = [];
    for (const req_it of items) {
      const line = (await pool.query(
        'SELECT * FROM sale_items WHERE id = $1 AND sale_id = $2',
        [asId(req_it.sale_item_id), sale.id]
      )).rows[0];
      if (!line) return bad(res, 404, 'Item #' + asId(req_it.sale_item_id) + ' is not on this bill');
      const qty = Math.floor(Number(req_it.quantity));
      if (!Number.isFinite(qty) || qty <= 0) return bad(res, 400, 'Invalid return quantity for ' + line.medicine_name);
      const available = line.quantity - line.returned_qty;
      if (qty > available) {
        return bad(res, 400, 'Cannot return ' + qty + ' of "' + line.medicine_name + '" — only ' + available + ' unreturned unit(s) on this bill');
      }
      planned.push({ line, qty });
    }

    const out = await transaction(async (client) => {
      let refund = 0;
      const rr = await client.query(
        'INSERT INTO sale_returns (sale_id, user_id, kind, reason, refund_amount) VALUES ($1, $2, $3, $4, 0) RETURNING id',
        [sale.id, req.user.id, 'return', String(reason || '').trim()]
      );
      const rid = rr.rows[0].id;

      for (const { line, qty } of planned) {
        const lineRefund = qty * line.unit_price * (1 + (line.gst_rate || 0) / 100);
        refund += lineRefund;
        if (restock) {
          await client.query('UPDATE batches SET quantity = quantity + $1 WHERE id = $2', [qty, line.batch_id]);
        }
        await client.query('UPDATE sale_items SET returned_qty = returned_qty + $1 WHERE id = $2', [qty, line.id]);
        await client.query(
          'INSERT INTO sale_return_items (return_id, sale_item_id, medicine_id, batch_id, quantity, unit_price, gst_rate, refund_amount, restocked) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
          [rid, line.id, line.medicine_id, line.batch_id, qty, line.unit_price, line.gst_rate || 0, lineRefund, restock ? 1 : 0]
        );
      }
      await client.query('UPDATE sale_returns SET refund_amount = $1 WHERE id = $2', [refund, rid]);

      // If nothing is left unreturned, the bill becomes fully returned.
      const left = (await client.query(
        'SELECT COALESCE(SUM(quantity - returned_qty),0)::int AS q FROM sale_items WHERE sale_id = $1', [sale.id]
      )).rows[0].q;
      await client.query('UPDATE sales SET status = $1 WHERE id = $2',
        [left === 0 ? 'returned' : 'partial_return', sale.id]);
      return { refund, left };
    });
    res.json({ ok: true, refund_amount: Number(out.refund.toFixed(2)), restocked: restock, remaining_units: out.left });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
app.get('/api/alerts', requireAuth, async (req, res, next) => {
  try {
    const low = (await pool.query(
      'SELECT m.id, m.name, m.company, m.shelf, m.low_stock_threshold, COALESCE(SUM(b.quantity), 0)::int AS stock FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id WHERE m.active = 1 GROUP BY m.id HAVING COALESCE(SUM(b.quantity), 0) <= m.low_stock_threshold ORDER BY stock ASC'
    )).rows;

    const expiring = (await pool.query(
      'SELECT b.id, b.batch_number, b.expiry_date, b.quantity, m.name, m.company, m.shelf, (b.expiry_date - CURRENT_DATE) AS days_left FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.quantity > 0 AND b.expiry_date <= CURRENT_DATE + 90 ORDER BY b.expiry_date ASC'
    )).rows;

    res.json({
      low,
      expiring,
      counts: { low: low.length, expiring: expiring.length },
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Khata — the shop's udhaar (credit) book.
//
// A customer's balance = credits given - payments/discounts received. The
// billing screen can open a khata in a single call by passing customer_name:
// the customer is found (case-insensitive) or created on the spot.
// ---------------------------------------------------------------------------
app.get('/api/khata', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT c.id, c.name, c.phone, COALESCE(SUM(CASE l.kind WHEN 'credit' THEN l.amount ELSE -l.amount END), 0)::float8 AS balance, COALESCE(SUM(CASE WHEN l.kind = 'credit' THEN l.amount ELSE 0 END), 0)::float8 AS total_credit, COUNT(l.id)::int AS entries, MAX(l.created_at) AS last_entry FROM customers c LEFT JOIN customer_ledger l ON l.customer_id = c.id GROUP BY c.id ORDER BY balance DESC, c.name"
    );
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/khata/customers', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const phone = String(req.body?.phone || '').trim();
    if (!name) return bad(res, 400, 'Customer name is required');
    const { rows } = await pool.query(
      'INSERT INTO customers (name, phone) VALUES ($1, $2) RETURNING id, name, phone',
      [name.slice(0, 200), phone.slice(0, 20)]
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/khata/customers/:id', requireAuth, async (req, res, next) => {
  try {
    const cust = (await pool.query('SELECT id, name, phone, created_at FROM customers WHERE id = $1', [asId(req.params.id)])).rows[0];
    if (!cust) return bad(res, 404, 'Customer not found');

    const entries = (await pool.query(
      'SELECT l.id, l.kind, l.amount::float8 AS amount, l.note, l.created_at, l.sale_id, s.invoice_number, u.name AS by_name FROM customer_ledger l LEFT JOIN sales s ON s.id = l.sale_id LEFT JOIN users u ON u.id = l.user_id WHERE l.customer_id = $1 ORDER BY l.id DESC LIMIT 200',
      [cust.id]
    )).rows;

    const balance = (await pool.query(
      "SELECT COALESCE(SUM(CASE kind WHEN 'credit' THEN amount ELSE -amount END), 0)::float8 AS balance FROM customer_ledger WHERE customer_id = $1",
      [cust.id]
    )).rows[0].balance;

    res.json({ ...cust, balance, entries });
  } catch (e) { next(e); }
});

// Add a ledger entry. Body: { kind: 'credit'|'payment'|'discount', amount,
// note?, sale_id?, customer_id? | customer_name? } — when only a name is
// given the customer is matched case-insensitively or created, so billing
// needs exactly one call to put a bill on khata.
app.post('/api/khata/entries', requireAuth, async (req, res, next) => {
  try {
    const { kind, sale_id, customer_id, customer_name } = req.body || {};
    const amount = Number(req.body?.amount);
    const note = String(req.body?.note || '').trim();
    if (kind !== 'credit' && kind !== 'payment' && kind !== 'discount') {
      return bad(res, 400, 'Kind must be credit, payment or discount');
    }
    if (!Number.isFinite(amount) || amount <= 0) return bad(res, 400, 'Amount must be a positive number');

    let cid = asId(customer_id);
    if (!cid) {
      const nm = String(customer_name || '').trim();
      if (!nm) return bad(res, 400, 'Pick a customer or write a name');
      const existing = (await pool.query('SELECT id FROM customers WHERE LOWER(name) = LOWER($1)', [nm.slice(0, 200)])).rows[0];
      cid = existing
        ? existing.id
        : (await pool.query("INSERT INTO customers (name, phone) VALUES ($1, '') RETURNING id", [nm.slice(0, 200)])).rows[0].id;
    } else if (!(await pool.query('SELECT id FROM customers WHERE id = $1', [cid])).rows[0]) {
      return bad(res, 404, 'Customer not found');
    }

    const { rows } = await pool.query(
      'INSERT INTO customer_ledger (customer_id, sale_id, kind, amount, note, user_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, customer_id, kind, amount',
      [cid, asId(sale_id) || null, kind, Math.round(amount * 100) / 100, note.slice(0, 300), req.user.id]
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// WhatsApp daily summary
//
// The dashboard's "WhatsApp Summary" button turns today's numbers into a
// ready-to-send message. The server builds the text (single source of truth,
// same net-quantity math as reports); the client just opens a wa.me share
// link with it, so no WhatsApp API account or per-message cost is involved.
// ---------------------------------------------------------------------------
// Public, token-gated invoice view — the link a customer opens from WhatsApp.
// No auth: the 24-char HMAC token per sale is the credential.
app.get('/api/public/invoice/:id', async (req, res, next) => {
  try {
    const id = asId(req.params.id);
    const t = String(req.query.t || '');
    if (!id || !t || t !== invoiceToken(id)) return bad(res, 404, 'Invoice not found');

    const sale = (await pool.query(
      'SELECT id, invoice_number, customer_name, subtotal::float8 AS subtotal, gst_amount::float8 AS gst_amount, total::float8 AS total, status, created_at FROM sales WHERE id = $1',
      [id]
    )).rows[0];
    if (!sale || sale.status === 'cancelled') return bad(res, 404, 'Invoice not found');

    const settings = (await pool.query('SELECT store_name, phone, store_address, gst_number FROM settings WHERE id = 1')).rows[0] || {};
    const items = (await pool.query(
      'SELECT medicine_name, company, batch_number, expiry_date, quantity, unit_price::float8 AS unit_price, gst_rate::float8 AS gst_rate, line_total::float8 AS line_total FROM sale_items WHERE sale_id = $1 ORDER BY id',
      [id]
    )).rows;

    res.json({
      sale, items,
      store: {
        name: settings.store_name || 'MediStock Pharmacy',
        phone: settings.phone || '',
        address: settings.store_address || '',
        gstin: settings.gst_number || '',
      },
    });
  } catch (e) { next(e); }
});

// Same token-gated invoice, rendered as a real PDF (tap = download/view).
// "Rs." instead of ₹ because the built-in PDF fonts have no rupee glyph.
const PDFDocument = require('pdfkit');

app.get('/api/public/invoice/:id/pdf', async (req, res, next) => {
  try {
    const id = asId(req.params.id);
    const t = String(req.query.t || '');
    if (!id || !t || t !== invoiceToken(id)) return bad(res, 404, 'Invoice not found');

    const sale = (await pool.query(
      'SELECT id, invoice_number, customer_name, subtotal::float8 AS subtotal, gst_amount::float8 AS gst_amount, total::float8 AS total, status, created_at FROM sales WHERE id = $1',
      [id]
    )).rows[0];
    if (!sale || sale.status === 'cancelled') return bad(res, 404, 'Invoice not found');

    const settings = (await pool.query('SELECT store_name, phone, store_address, gst_number FROM settings WHERE id = 1')).rows[0] || {};
    const items = (await pool.query(
      'SELECT medicine_name, company, batch_number, quantity, unit_price::float8 AS unit_price, gst_rate::float8 AS gst_rate, line_total::float8 AS line_total FROM sale_items WHERE sale_id = $1 ORDER BY id',
      [id]
    )).rows;

    const inr = (n) => 'Rs. ' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const GREEN = '#0b695c';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline; filename="' + sale.invoice_number + '.pdf"');
    const doc = new PDFDocument({ size: 'A4', margin: 42 });
    doc.pipe(res);

    doc.font('Helvetica-Bold').fontSize(20).fillColor(GREEN)
      .text(settings.store_name || 'MediStock Pharmacy', { align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor('#555555');
    if (settings.store_address) doc.text(settings.store_address, { align: 'center' });
    const contact = [settings.phone, settings.gst_number ? 'GSTIN: ' + settings.gst_number : ''].filter(Boolean).join('   |   ');
    if (contact) doc.text(contact, { align: 'center' });
    doc.moveDown(0.4).font('Helvetica-Bold').fontSize(11).fillColor(GREEN).text('TAX INVOICE', { align: 'center' });

    doc.moveDown(1.2).font('Helvetica').fontSize(10).fillColor('#000000');
    doc.font('Helvetica-Bold').text('Invoice: ' + sale.invoice_number, { continued: true })
      .font('Helvetica').text('        Date: ' + new Date(sale.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }));
    if (sale.customer_name) doc.text('Customer: ' + sale.customer_name);
    doc.moveDown(0.8);

    // Items table (fixed columns within the 511pt printable width)
    const colItem = 42, colQty = 330, colRate = 395, colAmt = 475;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000');
    doc.text('Item', colItem, doc.y);
    doc.text('Qty', colQty, doc.y, { width: 55, align: 'center' });
    doc.text('Rate', colRate, doc.y, { width: 70, align: 'right' });
    doc.text('Amount', colAmt, doc.y, { width: 78, align: 'right' });
    doc.moveTo(colItem, doc.y + 14).lineTo(553, doc.y + 14).strokeColor('#999999').stroke();
    doc.moveDown(1);

    for (const it of items) {
      const yStart = doc.y;
      doc.font('Helvetica').fontSize(10).fillColor('#000000');
      doc.text(it.medicine_name, colItem, yStart, { width: 270 });
      doc.font('Helvetica').fontSize(8).fillColor('#777777')
        .text([it.company, it.batch_number].filter(Boolean).join(' | '), colItem, doc.y, { width: 270 });
      const yEnd = doc.y;
      doc.font('Helvetica').fontSize(10).fillColor('#000000');
      doc.text(String(it.quantity), colQty, yStart, { width: 55, align: 'center' });
      doc.text(inr(it.unit_price).replace('Rs. ', ''), colRate, yStart, { width: 70, align: 'right' });
      doc.text(inr(it.line_total).replace('Rs. ', ''), colAmt, yStart, { width: 78, align: 'right' });
      doc.y = yEnd + 6;
      if (doc.y > 700) { doc.addPage(); doc.y = 42; }
    }

    doc.moveTo(colItem, doc.y + 4).lineTo(553, doc.y + 4).strokeColor('#bbbbbb').stroke();
    doc.moveDown(1);

    const totalX = 330;
    const totalRow = (label, value, bold) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 13 : 10).fillColor(bold ? GREEN : '#000000');
      doc.text(label, totalX, y, { width: 110, align: 'right' });
      doc.text(value, totalX + 113, y, { width: 110, align: 'right' });
      doc.y = y + (bold ? 20 : 16);
    };
    totalRow('Subtotal', inr(sale.subtotal), false);
    if (sale.gst_amount > 0) totalRow('GST', inr(sale.gst_amount), false);
    doc.moveTo(totalX, doc.y).lineTo(553, doc.y).lineWidth(1.5).strokeColor(GREEN).stroke();
    doc.y += 6;
    totalRow('TOTAL', inr(sale.total), true);

    doc.moveDown(2).font('Helvetica').fontSize(9).fillColor('#777777')
      .text('Thank you for your visit!  -  Generated via MediStock', { align: 'center' });

    doc.end();
  } catch (e) { next(e); }
});

app.get('/api/whatsapp/summary', requireAuth, async (req, res, next) => {
  try {
    const [today, purchases, month, low, expiring, khata, settings] = await Promise.all([
      pool.query(
        "SELECT COUNT(DISTINCT s.id)::int AS bills, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue, COALESCE(SUM((si.unit_price - si.cost_price) * (si.quantity - si.returned_qty)), 0)::float8 AS profit FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.created_at::date = CURRENT_DATE AND s.status != 'cancelled'"
      ),
      pool.query(
        'SELECT COUNT(*)::int AS bills, COALESCE(SUM(total), 0)::float8 AS amount FROM purchases WHERE created_at::date = CURRENT_DATE AND reversed_at IS NULL'
      ),
      pool.query(
        "SELECT COUNT(DISTINCT s.id)::int AS bills, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.created_at::date >= date_trunc('month', CURRENT_DATE)::date AND s.status != 'cancelled'"
      ),
      pool.query(
        'SELECT m.name FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id WHERE m.active = 1 GROUP BY m.id HAVING COALESCE(SUM(b.quantity), 0) <= m.low_stock_threshold ORDER BY COALESCE(SUM(b.quantity), 0) ASC'
      ),
      pool.query(
        'SELECT m.name, b.batch_number, (b.expiry_date - CURRENT_DATE) AS days_left FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.quantity > 0 AND b.expiry_date <= CURRENT_DATE + 90 ORDER BY b.expiry_date ASC'
      ),
      pool.query(
        "SELECT COALESCE(SUM(CASE WHEN bal > 0 THEN bal ELSE 0 END), 0)::float8 AS due, COUNT(*) FILTER (WHERE bal > 0.004)::int AS customers FROM (SELECT c.id, COALESCE(SUM(CASE l.kind WHEN 'credit' THEN l.amount ELSE -l.amount END), 0)::float8 AS bal FROM customers c LEFT JOIN customer_ledger l ON l.customer_id = c.id GROUP BY c.id) t"
      ),
      pool.query('SELECT store_name FROM settings WHERE id = 1'),
    ]);

    const t = today.rows[0];
    const p = purchases.rows[0];
    const mo = month.rows[0];
    const store = (settings.rows[0] || {}).store_name || 'MediStock';
    const inr = (n) => '₹' + Math.round(Number(n)).toLocaleString('en-IN');

    const lines = [];
    lines.push(`🏥 *${store}* — *Daily Business Summary*`);
    lines.push(`📅 *Date:* ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`);
    lines.push('━━━━━━━━━━━━━━━━━━━━━');
    lines.push('💵 *TODAY\'S PERFORMANCE*');
    lines.push(`• 💰 *Sales:* ${inr(t.revenue)} *(${t.bills} ${t.bills === 1 ? 'bill' : 'bills'})*`);
    lines.push(`• 📈 *Gross Profit:* ${inr(t.profit)}`);
    if (p.bills > 0) {
      lines.push(`• 🛒 *Purchases:* ${inr(p.amount)} *(${p.bills} ${p.bills === 1 ? 'bill' : 'bills'})*`);
    }

    const k = khata.rows[0];
    lines.push('');
    lines.push('📒 *CREDIT BOOK (KHATA)*');
    lines.push(`• 🔴 *Pending Dues:* ${inr(k.due)} *(${k.customers} ${k.customers === 1 ? 'customer' : 'customers'})*`);

    if (low.rows.length > 0 || expiring.rows.length > 0) {
      lines.push('');
      lines.push('⚠️ *INVENTORY ALERTS*');
      if (low.rows.length > 0) {
        lines.push(`• 🔻 *Low Stock (${low.rows.length}):*`);
        low.rows.slice(0, 5).forEach((r) => lines.push(`   - ${r.name}`));
        if (low.rows.length > 5) lines.push(`   _+${low.rows.length - 5} more_`);
      }
      if (expiring.rows.length > 0) {
        lines.push(`• ⏳ *Expiring Soon (${expiring.rows.length}):*`);
        expiring.rows.slice(0, 4).forEach((r) => {
          const daysStr = r.days_left < 0 ? 'EXPIRED' : `in ${r.days_left} days`;
          lines.push(`   - ${r.name} *(${daysStr})*`);
        });
        if (expiring.rows.length > 4) lines.push(`   _+${expiring.rows.length - 4} more_`);
      }
    }

    lines.push('');
    lines.push('📊 *THIS MONTH TOTAL*');
    lines.push(`• 📈 *Monthly Revenue:* ${inr(mo.revenue)} *(${mo.bills} ${mo.bills === 1 ? 'bill' : 'bills'})*`);

    lines.push('━━━━━━━━━━━━━━━━━━━━━');
    lines.push('✨ _Generated automatically via MediStock App_');

    res.json({
      text: lines.join('\n'),
      today: { revenue: Number(t.revenue), profit: Number(t.profit), bills: t.bills },
      purchases: { amount: Number(p.amount), bills: p.bills },
      month: { revenue: Number(mo.revenue), bills: mo.bills },
      low_stock: low.rows.length,
      expiring: expiring.rows.length,
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Reports
//
// Money and units are always counted from *net* quantities: a cancelled bill
// contributes nothing, and a partially returned line only counts the units the
// customer kept. The (si.quantity - si.returned_qty) expression is that
// surviving quantity.
// ---------------------------------------------------------------------------
app.get('/api/reports/dashboard', requireAuth, async (req, res, next) => {
  try {
    const today = (await pool.query(
      "SELECT COUNT(DISTINCT s.id)::int AS bills, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.created_at::date = CURRENT_DATE AND s.status != 'cancelled'"
    )).rows[0];

    const todayProfit = (await pool.query(
      "SELECT COALESCE(SUM((si.unit_price - si.cost_price) * (si.quantity - si.returned_qty)), 0)::float8 AS profit FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.created_at::date = CURRENT_DATE AND s.status != 'cancelled'"
    )).rows[0].profit;

    const last7 = (await pool.query(
      "SELECT s.created_at::date AS day, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue, COUNT(DISTINCT s.id)::int AS bills FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.created_at::date >= CURRENT_DATE - 6 AND s.status != 'cancelled' GROUP BY day ORDER BY day"
    )).rows;

    const alerts = (await pool.query(
      'SELECT (SELECT COUNT(*)::int FROM (SELECT m.id FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id WHERE m.active = 1 GROUP BY m.id HAVING COALESCE(SUM(b.quantity), 0) <= m.low_stock_threshold) t_low) AS low, (SELECT COUNT(*)::int FROM batches WHERE quantity > 0 AND expiry_date <= CURRENT_DATE + 90) AS expiring'
    )).rows[0];

    const topSellers = (await pool.query(
      "SELECT si.medicine_name AS name, si.company, SUM(si.quantity - si.returned_qty)::int AS qty, SUM((si.quantity - si.returned_qty) * si.unit_price)::float8 AS revenue FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.created_at::date >= CURRENT_DATE - 6 AND s.status != 'cancelled' GROUP BY si.medicine_id, si.medicine_name, si.company HAVING SUM(si.quantity - si.returned_qty) > 0 ORDER BY qty DESC LIMIT 5"
    )).rows;

    res.json({ today, todayProfit, last7, alerts, topSellers });
  } catch (e) { next(e); }
});

app.get('/api/reports/sales', requireAuth, async (req, res, next) => {
  try {
    // Only well-formed YYYY-MM-DD filters reach the database; anything else
    // falls back to the default 30-day window.
    const qFrom = String(req.query.from || '');
    const qTo = String(req.query.to || '');
    const from = DATE_RE.test(qFrom) ? qFrom : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const to = DATE_RE.test(qTo) ? qTo : new Date().toISOString().slice(0, 10);

    const summary = (await pool.query(
      "SELECT COUNT(DISTINCT s.id)::int AS bills, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue, COALESCE(SUM(si.quantity - si.returned_qty), 0)::int AS units, COALESCE(SUM((si.unit_price - si.cost_price) * (si.quantity - si.returned_qty)), 0)::float8 AS profit FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.created_at::date BETWEEN $1 AND $2 AND s.status != 'cancelled'",
      [from, to]
    )).rows[0];

    // Cancellations, returns and written-off stock for the same window.
    const refunds = (await pool.query(
      'SELECT COUNT(*)::int AS count, COALESCE(SUM(refund_amount),0)::float8 AS amount FROM sale_returns WHERE created_at::date BETWEEN $1 AND $2',
      [from, to]
    )).rows[0];

    const cancelled = (await pool.query(
      "SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0)::float8 AS amount FROM sales WHERE status = 'cancelled' AND created_at::date BETWEEN $1 AND $2",
      [from, to]
    )).rows[0];

    const writeoffs = (await pool.query(
      'SELECT COUNT(*)::int AS count, COALESCE(SUM(quantity),0)::int AS units, COALESCE(SUM(cost_value),0)::float8 AS loss FROM stock_writeoffs WHERE created_at::date BETWEEN $1 AND $2',
      [from, to]
    )).rows[0];

    const bestSellers = (await pool.query(
      "SELECT si.medicine_name AS name, si.company, SUM(si.quantity - si.returned_qty)::int AS qty, SUM((si.quantity - si.returned_qty) * si.unit_price)::float8 AS revenue, SUM((si.unit_price - si.cost_price) * (si.quantity - si.returned_qty))::float8 AS profit FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.created_at::date BETWEEN $1 AND $2 AND s.status != 'cancelled' GROUP BY si.medicine_id, si.medicine_name, si.company HAVING SUM(si.quantity - si.returned_qty) > 0 ORDER BY qty DESC LIMIT 10",
      [from, to]
    )).rows;

    const sales = (await pool.query(
      'SELECT s.id, s.invoice_number, s.total::float8 AS total, s.subtotal::float8 AS subtotal, s.gst_amount::float8 AS gst_amount, s.created_at, s.status, u.name AS served_by, COUNT(si.id)::int AS item_count, COALESCE(SUM(si.returned_qty),0)::int AS returned_units FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.created_at::date BETWEEN $1 AND $2 GROUP BY s.id, u.name ORDER BY s.id DESC LIMIT 100',
      [from, to]
    )).rows;

    res.json({ from, to, summary, refunds, cancelled, writeoffs, bestSellers, sales });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Settings & Users
// ---------------------------------------------------------------------------
app.get('/api/settings', requireAuth, async (req, res, next) => {
  try {
    const s = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    res.json(s);
  } catch (e) { next(e); }
});

app.put('/api/settings', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const s = (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const b = req.body || {};
    const updated = await pool.query(
      'UPDATE settings SET store_name=$1, store_address=$2, phone=$3, license_number=$4, gst_enabled=$5, gst_number=$6 WHERE id=1 RETURNING *',
      [
        String(b.store_name ?? s.store_name).trim(), String(b.store_address ?? s.store_address).trim(),
        String(b.phone ?? s.phone).trim(), String(b.license_number ?? s.license_number).trim(),
        b.gst_enabled !== undefined ? (b.gst_enabled ? 1 : 0) : s.gst_enabled,
        String(b.gst_number ?? s.gst_number).trim()
      ]
    );
    res.json(updated.rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/users', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, username, name, role, active, created_at FROM users ORDER BY id');
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/users', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const { username, password, name, role } = req.body || {};
    if (!username?.trim() || !password || !name?.trim()) return bad(res, 400, 'Name, username and password are required');
    if (String(password).length < 5) return bad(res, 400, 'Password must be at least 5 characters');
    if (!['owner', 'employee'].includes(role)) return bad(res, 400, 'Invalid role');
    await addUser(String(username).trim(), String(password), String(name).trim(), role);
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('unique_constraint') || String(e.message).includes('duplicate key')) {
      return bad(res, 409, 'That username is already taken');
    }
    next(e);
  }
});

app.put('/api/users/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const u = (await pool.query('SELECT * FROM users WHERE id = $1', [asId(req.params.id)])).rows[0];
    if (!u) return bad(res, 404, 'User not found');
    const b = req.body || {};
    if (u.id === req.user.id && b.active === false) return bad(res, 400, 'You cannot deactivate your own account');
    await pool.query('UPDATE users SET active = $1 WHERE id = $2', [b.active === false ? 0 : 1, u.id]);
    // A deactivated user must lose their open sessions immediately.
    if (b.active === false) await pool.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Owner resets a staff password (for the "I forgot my password" case). */
app.post('/api/users/:id/reset-password', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const u = (await pool.query('SELECT * FROM users WHERE id = $1', [asId(req.params.id)])).rows[0];
    if (!u) return bad(res, 404, 'User not found');
    const pw = String(req.body?.new_password || '');
    if (pw.length < 6) return bad(res, 400, 'Password must be at least 6 characters');
    await setUserPassword(u.id, pw);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [u.id]); // force re-login
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// One-time data import (owner) — bring a shop's existing stock over from its
// old software (Marg / TradeEasy / any Excel export). Two calls:
//   POST /api/import/parse  — workbook (base64) → headers + raw rows
//   POST /api/import/commit — mapped rows (≤300) → medicines + batches
// The client maps columns and chunks the rows; each commit is one transaction.
// ---------------------------------------------------------------------------
const XLSX = require('xlsx');
const IMPORT_MAX_ROWS = 5000;
const IMPORT_CHUNK_LIMIT = 300;

/* Accepts Date objects (cellDates), Excel serial days, and the common text
   formats Indian ERPs export (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YY, YYYY-MM-DD).
   Returns 'YYYY-MM-DD' or null when the value cannot be understood. */
function importDateToISO(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  }
  if (typeof v === 'number' && isFinite(v)) {
    // Excel day serial (1900 epoch); clamp absurd values out
    if (v < 20000 || v > 80000) return null;
    return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (!m) m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (!m) return null;
  let y, mo, d;
  if (/^\d{4}-/.test(s)) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt.toISOString().slice(0, 10);
}

/* Loose number reader: tolerates ₹, commas, spaces ("1,250.50"). */
function importNumber(v) {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'number') return isFinite(v) ? v : NaN;
  const n = Number(String(v).replace(/[₹,\s]/g, ''));
  return isFinite(n) ? n : NaN;
}

app.post('/api/import/parse', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const b64 = String((req.body || {}).file_base64 || '');
    if (!b64) return bad(res, 400, 'No file received');
    let wb;
    try {
      wb = XLSX.read(Buffer.from(b64, 'base64'), { cellDates: true });
    } catch {
      return bad(res, 400, 'Could not read the file — please use .xlsx, .xls or .csv');
    }
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return bad(res, 400, 'The file has no sheets');
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
    if (matrix.length < 2) return bad(res, 400, 'The file only has a header row or is empty');

    const headers = matrix[0].map((h) => String(h).trim());
    if (headers.every((h) => !h)) return bad(res, 400, 'The first row must be the column headers');

    const rows = [];
    for (let r = 1; r < matrix.length && rows.length < IMPORT_MAX_ROWS; r++) {
      const cells = {};
      let any = false;
      headers.forEach((h, c) => {
        if (!h) return;
        const v = matrix[r][c];
        let out;
        if (v instanceof Date && !isNaN(v.getTime())) out = v.toISOString().slice(0, 10);
        else if (v === null || v === undefined) out = '';
        else out = String(v).trim();
        cells[h] = out;
        if (out !== '') any = true;
      });
      if (any) rows.push({ i: r + 1, cells });
    }
    res.json({ sheet: wb.SheetNames[0], headers: headers.filter(Boolean), rows });
  } catch (e) { next(e); }
});

app.post('/api/import/commit', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const rows = Array.isArray((req.body || {}).rows) ? req.body.rows : [];
    if (!rows.length) return bad(res, 400, 'No rows to import');
    if (rows.length > IMPORT_CHUNK_LIMIT) return bad(res, 400, 'Send at most 300 rows per request');

    // One companies snapshot per chunk — same slug+aliases matching as
    // resolveCompanyLogo, without a query per row.
    const companies = (await pool.query('SELECT name, aliases, logo_url FROM companies')).rows;
    const logoFor = (companyName) => {
      const key = slugify(companyName);
      if (!key) return null;
      for (const c of companies) {
        const keys = [c.name, ...String(c.aliases || '').split(',')].map(slugify).filter(Boolean);
        if (keys.includes(key)) return c.logo_url || null;
      }
      return null;
    };

    const summary = { created: 0, revived: 0, existing: 0, batches_added: 0, batches_updated: 0, stock_skipped: 0, skipped: [] };

    await transaction(async (client) => {
      const medCache = new Map();
      for (let idx = 0; idx < rows.length; idx++) {
        const r = rows[idx] || {};
        const rowNum = Number(r.i) || idx + 1;
        const nm = String(r.name || '').trim();
        const co = (String(r.company || '').trim() || 'General');
        if (!nm) { summary.skipped.push({ i: rowNum, reason: 'Medicine name missing' }); continue; }

        const cacheKey = nm.toLowerCase() + '|' + co.toLowerCase();
        let med = medCache.get(cacheKey);
        if (med === undefined) {
          const found = (await client.query(
            'SELECT id, active FROM medicines WHERE lower(name) = lower($1) AND lower(company) = lower($2) ORDER BY id LIMIT 1',
            [nm, co]
          )).rows[0];
          med = found || null;
          medCache.set(cacheKey, med);
        }

        if (!med) {
          const type = (String(r.type || '').trim() || 'Tablet').slice(0, 100);
          const shelf = (String(r.shelf || '').trim() || '').slice(0, 50);
          const buy = Math.max(0, importNumber(r.buy_price) || 0);
          const sell = Math.max(0, importNumber(r.sell_price) || 0);
          let gst = importNumber(r.gst_rate);
          if (!isFinite(gst) || gst < 0 || gst > 100) gst = 12;
          const ins = await client.query(
            'INSERT INTO medicines (name, company, type, shelf, buy_price, sell_price, gst_rate, low_stock_threshold, logo_url) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
            [nm, co, type, shelf, buy, sell, gst, 10, logoFor(co)]
          );
          med = { id: ins.rows[0].id, active: 1 };
          medCache.set(cacheKey, med);
          summary.created++;
        } else if (med.active !== 1) {
          // Same name+company was removed earlier — revive with the imported values
          await client.query(
            'UPDATE medicines SET active = 1, type = $1, shelf = $2, buy_price = $3, sell_price = $4, gst_rate = $5 WHERE id = $6',
            [(String(r.type || '').trim() || 'Tablet').slice(0, 100), (String(r.shelf || '').trim() || '').slice(0, 50),
             Math.max(0, importNumber(r.buy_price) || 0), Math.max(0, importNumber(r.sell_price) || 0),
             (importNumber(r.gst_rate) >= 0 && importNumber(r.gst_rate) <= 100 ? importNumber(r.gst_rate) : 12), med.id]
          );
          med.active = 1;
          summary.revived++;
        } else {
          summary.existing++;
        }

        const qty = Math.trunc(importNumber(r.quantity));
        if (qty > 0) {
          const expiryISO = importDateToISO(r.expiry_date);
          if (!expiryISO) {
            summary.stock_skipped++;
            summary.skipped.push({ i: rowNum, reason: 'Stock not added — expiry date not readable (' + String(r.expiry_date || 'blank') + ')' });
          } else {
            const bn = (String(r.batch_no || '').trim() || 'OPENING').slice(0, 255);
            const existing = (await client.query(
              'SELECT id FROM batches WHERE medicine_id = $1 AND batch_number = $2',
              [med.id, bn]
            )).rows[0];
            if (existing) {
              await client.query('UPDATE batches SET quantity = quantity + $1, expiry_date = $2 WHERE id = $3', [qty, expiryISO, existing.id]);
              summary.batches_updated++;
            } else {
              await client.query('INSERT INTO batches (medicine_id, batch_number, expiry_date, quantity) VALUES ($1, $2, $3, $4)', [med.id, bn, expiryISO, qty]);
              summary.batches_added++;
            }
          }
        }
      }
    });

    res.json(summary);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error: ' + err.message });
});

module.exports = app;
