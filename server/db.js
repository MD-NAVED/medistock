const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'medistock.db'));
db.exec('PRAGMA foreign_keys = ON');

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK(role IN ('owner','employee')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS medicines (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  company             TEXT NOT NULL,
  type                TEXT NOT NULL DEFAULT 'Tablet',
  shelf               TEXT NOT NULL DEFAULT '',
  buy_price           REAL NOT NULL DEFAULT 0,
  sell_price          REAL NOT NULL DEFAULT 0,
  gst_rate            REAL NOT NULL DEFAULT 12,
  low_stock_threshold INTEGER NOT NULL DEFAULT 10,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(name, company)
);

CREATE TABLE IF NOT EXISTS batches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  medicine_id  INTEGER NOT NULL REFERENCES medicines(id),
  batch_number TEXT NOT NULL,
  expiry_date  TEXT NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(medicine_id, batch_number)
);

CREATE TABLE IF NOT EXISTS purchases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT NOT NULL,
  supplier_name  TEXT NOT NULL DEFAULT '',
  user_id        INTEGER NOT NULL REFERENCES users(id),
  total          REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchase_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id  INTEGER NOT NULL REFERENCES purchases(id),
  medicine_id  INTEGER NOT NULL REFERENCES medicines(id),
  batch_number TEXT NOT NULL,
  expiry_date  TEXT NOT NULL,
  quantity     INTEGER NOT NULL,
  buy_price    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_number TEXT UNIQUE NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  customer_name  TEXT NOT NULL DEFAULT '',
  subtotal       REAL NOT NULL DEFAULT 0,
  gst_amount     REAL NOT NULL DEFAULT 0,
  total          REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sale_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id       INTEGER NOT NULL REFERENCES sales(id),
  medicine_id   INTEGER NOT NULL REFERENCES medicines(id),
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  medicine_name TEXT NOT NULL,
  company       TEXT NOT NULL,
  batch_number  TEXT NOT NULL,
  expiry_date   TEXT NOT NULL,
  quantity      INTEGER NOT NULL,
  unit_price    REAL NOT NULL,
  cost_price    REAL NOT NULL,
  gst_rate      REAL NOT NULL DEFAULT 0,
  line_total    REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  store_name      TEXT NOT NULL DEFAULT 'My Medical Store',
  store_address   TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  license_number  TEXT NOT NULL DEFAULT '',
  gst_enabled     INTEGER NOT NULL DEFAULT 0,
  gst_number      TEXT NOT NULL DEFAULT '',
  currency        TEXT NOT NULL DEFAULT '₹'
);
`);

// ---------------------------------------------------------------------------
// Migrations — additive, safe to run on an existing database
// ---------------------------------------------------------------------------
function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumn(table, column, definition) {
  if (!columnExists(table, column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// A sale can be active, fully cancelled, or partially returned.
addColumn('sales', 'status', `TEXT NOT NULL DEFAULT 'active'`);
addColumn('sales', 'cancelled_at', 'TEXT');
addColumn('sales', 'cancelled_by', 'INTEGER');
addColumn('sales', 'cancel_reason', 'TEXT');
// Quantity of each line already returned to stock (0 = nothing returned).
addColumn('sale_items', 'returned_qty', 'INTEGER NOT NULL DEFAULT 0');
// A purchase can be reversed if it was entered by mistake.
addColumn('purchases', 'status', `TEXT NOT NULL DEFAULT 'active'`);
addColumn('purchases', 'reversed_at', 'TEXT');
addColumn('purchases', 'reversed_by', 'INTEGER');
addColumn('purchases', 'reverse_reason', 'TEXT');
// Soft delete for the medicine catalog already exists as medicines.active.
// Password hashing algorithm marker so old sha256 rows can be upgraded on login.
addColumn('users', 'algo', `TEXT NOT NULL DEFAULT 'sha256'`);

db.exec(`
CREATE TABLE IF NOT EXISTS sale_returns (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id        INTEGER NOT NULL REFERENCES sales(id),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  kind           TEXT NOT NULL CHECK(kind IN ('cancel','return')),
  reason         TEXT NOT NULL DEFAULT '',
  refund_amount  REAL NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sale_return_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id      INTEGER NOT NULL REFERENCES sale_returns(id),
  sale_item_id   INTEGER NOT NULL REFERENCES sale_items(id),
  medicine_id    INTEGER NOT NULL REFERENCES medicines(id),
  batch_id       INTEGER NOT NULL REFERENCES batches(id),
  quantity       INTEGER NOT NULL,
  unit_price     REAL NOT NULL,
  gst_rate       REAL NOT NULL DEFAULT 0,
  refund_amount  REAL NOT NULL DEFAULT 0,
  restocked      INTEGER NOT NULL DEFAULT 1
);

-- Expired / damaged stock removed from inventory, kept as an audit trail.
CREATE TABLE IF NOT EXISTS stock_writeoffs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  medicine_id   INTEGER NOT NULL REFERENCES medicines(id),
  medicine_name TEXT NOT NULL,
  company       TEXT NOT NULL,
  batch_number  TEXT NOT NULL,
  expiry_date   TEXT NOT NULL,
  quantity      INTEGER NOT NULL,
  cost_value    REAL NOT NULL DEFAULT 0,
  reason        TEXT NOT NULL DEFAULT 'expired',
  note          TEXT NOT NULL DEFAULT '',
  user_id       INTEGER NOT NULL REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Login sessions survive a server restart.
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at  TEXT NOT NULL,
  last_seen   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Failed login attempts, used to lock out brute-force guessing.
CREATE TABLE IF NOT EXISTS login_attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  ip          TEXT NOT NULL DEFAULT '',
  success     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_batches_medicine ON batches(medicine_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, created_at);
`);

// ---------------------------------------------------------------------------
// Passwords — scrypt (built into Node, no native build step)
// ---------------------------------------------------------------------------
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_OPTS.keylen, {
    N: SCRYPT_OPTS.N, r: SCRYPT_OPTS.r, p: SCRYPT_OPTS.p,
  }).toString('hex');
}

/** Legacy hash kept only so existing accounts can log in once and be upgraded. */
function legacySha256(password, salt) {
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function setUserPassword(userId, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE users SET password_hash = ?, salt = ?, algo = ? WHERE id = ?')
    .run(scryptHash(password, salt), salt, 'scrypt', userId);
}

/**
 * Verify a password. Old sha256 rows are transparently re-hashed with scrypt
 * on the first successful login so no account is left on the weak algorithm.
 */
function verifyPassword(user, password) {
  if (user.algo === 'scrypt') {
    return timingSafeEqualHex(scryptHash(password, user.salt), user.password_hash);
  }
  const ok = timingSafeEqualHex(legacySha256(password, user.salt), user.password_hash);
  if (ok) setUserPassword(user.id, password); // upgrade in place
  return ok;
}

function addUser(username, password, name, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  const r = db.prepare(
    'INSERT INTO users (username, password_hash, salt, name, role, algo) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(username, scryptHash(password, salt), salt, name, role, 'scrypt');
  return Number(r.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Seed demo data (only on first run)
// ---------------------------------------------------------------------------
function seedIfEmpty() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 0) return;

  console.log('First run detected - seeding demo data...');

  addUser('owner', 'owner123', 'Store Owner', 'owner');
  addUser('staff', 'staff123', 'Counter Staff', 'employee');

  db.prepare(
    `INSERT INTO settings (id, store_name, store_address, phone, license_number, gst_enabled, gst_number)
     VALUES (1, 'MediStock Demo Pharmacy', 'Shop No. 12, Main Market Road', '+91 98765 43210', 'DL-PH-2024-001', 1, '22AAAAA0000A1Z5')`
  ).run();

  // name, company, type, shelf, buy, sell, gst, threshold, [batches: batchNo, expiry, qty]
  const daysFromNow = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  const medicines = [
    ['Dolo 650mg', 'Micro Labs', 'Tablet', 'A1', 1.2, 2.0, 12, 30, [['DL2401', daysFromNow(420), 200], ['DL2402', daysFromNow(150), 150]]],
    ['Crocin Advance 500mg', 'GSK', 'Tablet', 'A1', 1.0, 1.8, 12, 30, [['CR4501', daysFromNow(380), 180]]],
    ['Paracetamol 500mg', 'Cipla', 'Tablet', 'A1', 0.6, 1.2, 12, 40, [['PC3301', daysFromNow(500), 300]]],
    ['Azithral 500mg', 'Alembic', 'Tablet', 'A2', 15.5, 22.0, 12, 20, [['AZ2201', daysFromNow(240), 80], ['AZ2202', daysFromNow(60), 20]]],
    ['Augmentin 625 Duo', 'GSK', 'Tablet', 'A2', 14.0, 19.5, 12, 20, [['AG6101', daysFromNow(300), 60]]],
    ['Pantop 40mg', 'Aristo', 'Tablet', 'A3', 5.5, 8.5, 12, 30, [['PT4402', daysFromNow(45), 40], ['PT4401', daysFromNow(365), 120]]],
    ['Shelcal 500', 'Torrent', 'Tablet', 'A3', 6.0, 9.0, 12, 25, [['SH5501', daysFromNow(540), 90]]],
    ['Telma 40mg', 'Glenmark', 'Tablet', 'A4', 7.5, 11.0, 12, 15, [['TL4001', daysFromNow(200), 45]]],
    ['Glycomet GP2', 'USV', 'Tablet', 'A4', 6.8, 10.5, 12, 20, [['GM2201', daysFromNow(350), 70]]],
    ['Ecosprin 75mg', 'USV', 'Tablet', 'A5', 0.9, 1.5, 5, 40, [['EC7501', daysFromNow(460), 250]]],
    ['Benadryl Syrup 150ml', 'J&J', 'Syrup', 'B1', 92.0, 118.0, 12, 10, [['BD1501', daysFromNow(280), 25]]],
    ['Ascoril LS Syrup', 'Glenmark', 'Syrup', 'B1', 98.0, 125.0, 12, 10, [['AS1001', daysFromNow(20), 8]]],
    ['Digene Gel 200ml', 'Abbott', 'Syrup', 'B2', 105.0, 135.0, 12, 8, [['DG2001', daysFromNow(330), 18]]],
    ['ORS Powder Sachet', 'FDC', 'Powder', 'B2', 3.5, 6.0, 5, 50, [['OR0051', daysFromNow(600), 150]]],
    ['Dettol Antiseptic 250ml', 'Reckitt', 'Other', 'C1', 130.0, 165.0, 18, 8, [['DT2501', daysFromNow(700), 15]]],
    ['Volini Spray 60g', 'Sun Pharma', 'Other', 'C1', 160.0, 198.0, 18, 6, [['VL0601', daysFromNow(400), 10]]],
    ['Insulin Glargine 100IU', 'Biocon', 'Injection', 'C2', 420.0, 495.0, 5, 5, [['IN1001', daysFromNow(120), 6]]],
    ['Human Albumin 20%', 'Baxalta', 'Injection', 'C2', 1250.0, 1450.0, 5, 3, [['HA2001', daysFromNow(-15), 2]]], // already expired -> shows red alert
  ];

  const insMed = db.prepare(
    `INSERT INTO medicines (name, company, type, shelf, buy_price, sell_price, gst_rate, low_stock_threshold)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insBatch = db.prepare(
    'INSERT INTO batches (medicine_id, batch_number, expiry_date, quantity) VALUES (?, ?, ?, ?)'
  );

  const medIds = {};
  for (const [name, company, type, shelf, buy, sell, gst, thr, batches] of medicines) {
    const r = insMed.run(name, company, type, shelf, buy, sell, gst, thr);
    medIds[name + '|' + company] = r.lastInsertRowid;
    for (const [bn, exp, qty] of batches) insBatch.run(r.lastInsertRowid, bn, exp, qty);
  }

  // ----- seed historical purchases (last 3 weeks) -----
  const owner = db.prepare(`SELECT id FROM users WHERE username='owner'`).get();
  const insPurchase = db.prepare('INSERT INTO purchases (invoice_number, supplier_name, user_id, total, created_at) VALUES (?, ?, ?, ?, ?)');
  const insPItem = db.prepare('INSERT INTO purchase_items (purchase_id, medicine_id, batch_number, expiry_date, quantity, buy_price) VALUES (?, ?, ?, ?, ?, ?)');
  let pno = 1;
  const suppliers = ['MedPlus Distributors', 'Sri Balaji Agencies', 'HealthFirst Wholesale'];
  for (const med of medicines.slice(0, 10)) {
    const medId = medIds[med[0] + '|' + med[1]];
    const m = db.prepare('SELECT * FROM medicines WHERE id=?').get(medId);
    const b = med[8][0]; // first batch of this medicine
    const dt = new Date(Date.now() - (3 + pno) * 86400000)
      .toISOString().slice(0, 19).replace('T', ' ');
    const total = b[2] * m.buy_price;
    const pr = insPurchase.run('PINV-' + String(1000 + pno), suppliers[pno % 3], owner.id, total, dt);
    insPItem.run(pr.lastInsertRowid, medId, b[0], b[1], b[2], m.buy_price);
    pno++;
  }

  // ----- seed historical sales (last 7 days, so dashboard & reports look alive) -----
  const insSale = db.prepare('INSERT INTO sales (invoice_number, user_id, customer_name, subtotal, gst_amount, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insSItem = db.prepare('INSERT INTO sale_items (sale_id, medicine_id, batch_id, medicine_name, company, batch_number, expiry_date, quantity, unit_price, cost_price, gst_rate, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const decBatch = db.prepare('UPDATE batches SET quantity = quantity - ? WHERE id = ?');
  const staff = db.prepare(`SELECT id FROM users WHERE username='staff'`).get();

  const allMeds = db.prepare('SELECT * FROM medicines').all();
  let sno = 1;
  for (let d = 6; d >= 0; d--) {
    const salesToday = 6 + Math.floor(Math.random() * 6);
    for (let s = 0; s < salesToday; s++) {
      const hour = 9 + Math.floor(Math.random() * 12);
      const minute = Math.floor(Math.random() * 60);
      const when = new Date(Date.now() - d * 86400000);
      const dtStr = when.toISOString().slice(0, 10) + ' ' +
        String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':00';
      const nItems = 1 + Math.floor(Math.random() * 3);
      let subtotal = 0, gst = 0;
      const lines = [];
      const used = new Set();
      for (let i = 0; i < nItems; i++) {
        const m = allMeds[Math.floor(Math.random() * (allMeds.length - 1))];
        if (used.has(m.id)) continue;
        used.add(m.id);
        const batches = db.prepare(
          'SELECT * FROM batches WHERE medicine_id = ? AND quantity > 0 ORDER BY expiry_date ASC'
        ).all(m.id);
        if (!batches.length) continue;
        let want = 1 + Math.floor(Math.random() * 3);
        for (const b of batches) {
          if (want <= 0) break;
          const take = Math.min(b.quantity, want);
          want -= take;
          const lineTotal = take * m.sell_price;
          const lineGst = (lineTotal * m.gst_rate) / 100;
          subtotal += lineTotal;
          gst += lineGst;
          lines.push([m.id, b.id, m.name, m.company, b.batch_number, b.expiry_date, take, m.sell_price, m.buy_price, m.gst_rate, lineTotal]);
          decBatch.run(take, b.id);
        }
      }
      if (!lines.length) continue;
      const uid = Math.random() < 0.6 ? owner.id : staff.id;
      const sr = insSale.run('INV-' + String(10000 + sno), uid, '', subtotal, gst, subtotal + gst, dtStr);
      for (const l of lines) insSItem.run(sr.lastInsertRowid, ...l);
      sno++;
    }
  }

  console.log('Demo data seeded: 2 users, 18 medicines, purchases & 7 days of sales.');
}

seedIfEmpty();

module.exports = { db, addUser, verifyPassword, setUserPassword };
