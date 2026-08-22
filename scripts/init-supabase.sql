-- ============================================================================
-- MediStock PostgreSQL Database Schema for Supabase
-- Run this script in the Supabase SQL Editor to initialize all tables & seed data.
-- ============================================================================

-- Enable UUID extension if needed in future
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- 1. Users Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt          TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          VARCHAR(50) NOT NULL CHECK(role IN ('owner','employee')),
  active        INTEGER NOT NULL DEFAULT 1,
  algo          VARCHAR(50) NOT NULL DEFAULT 'scrypt',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 2. Medicines Catalog Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS medicines (
  id                  SERIAL PRIMARY KEY,
  name                TEXT NOT NULL,
  company             TEXT NOT NULL,
  type                VARCHAR(100) NOT NULL DEFAULT 'Tablet',
  shelf               VARCHAR(50) NOT NULL DEFAULT '',
  buy_price           NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  sell_price          NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  gst_rate            NUMERIC(5, 2) NOT NULL DEFAULT 12.00,
  low_stock_threshold INTEGER NOT NULL DEFAULT 10,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_medicine_company UNIQUE(name, company)
);

-- ----------------------------------------------------------------------------
-- 3. Batches Inventory Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS batches (
  id           SERIAL PRIMARY KEY,
  medicine_id  INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  batch_number VARCHAR(255) NOT NULL,
  expiry_date  DATE NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_medicine_batch UNIQUE(medicine_id, batch_number)
);

-- ----------------------------------------------------------------------------
-- 4. Purchases (Stock-In Header)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  id             SERIAL PRIMARY KEY,
  invoice_number VARCHAR(255) NOT NULL,
  supplier_name  TEXT NOT NULL DEFAULT '',
  user_id        INTEGER NOT NULL REFERENCES users(id),
  total          NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  status         VARCHAR(50) NOT NULL DEFAULT 'active',
  reversed_at    TIMESTAMPTZ,
  reversed_by    INTEGER REFERENCES users(id),
  reverse_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 5. Purchase Items (Stock-In Line Items)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchase_items (
  id           SERIAL PRIMARY KEY,
  purchase_id  INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  medicine_id  INTEGER NOT NULL REFERENCES medicines(id),
  batch_number VARCHAR(255) NOT NULL,
  expiry_date  DATE NOT NULL,
  quantity     INTEGER NOT NULL,
  buy_price    NUMERIC(12, 2) NOT NULL
);

-- ----------------------------------------------------------------------------
-- 6. Sales (POS Invoice Header)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id             SERIAL PRIMARY KEY,
  invoice_number VARCHAR(255) UNIQUE NOT NULL,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  customer_name  TEXT NOT NULL DEFAULT '',
  subtotal       NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  gst_amount     NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  total          NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  status         VARCHAR(50) NOT NULL DEFAULT 'active',
  cancelled_at   TIMESTAMPTZ,
  cancelled_by   INTEGER REFERENCES users(id),
  cancel_reason  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 7. Sale Items (POS Line Items)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_items (
  id            SERIAL PRIMARY KEY,
  sale_id       INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  medicine_id   INTEGER NOT NULL REFERENCES medicines(id),
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  medicine_name TEXT NOT NULL,
  company       TEXT NOT NULL,
  batch_number  VARCHAR(255) NOT NULL,
  expiry_date   DATE NOT NULL,
  quantity      INTEGER NOT NULL,
  unit_price    NUMERIC(12, 2) NOT NULL,
  cost_price    NUMERIC(12, 2) NOT NULL,
  gst_rate      NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  line_total    NUMERIC(12, 2) NOT NULL,
  returned_qty  INTEGER NOT NULL DEFAULT 0
);

-- ----------------------------------------------------------------------------
-- 8. Sale Returns (Returns / Cancellations Audit Header)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_returns (
  id             SERIAL PRIMARY KEY,
  sale_id        INTEGER NOT NULL REFERENCES sales(id),
  user_id        INTEGER NOT NULL REFERENCES users(id),
  kind           VARCHAR(50) NOT NULL CHECK(kind IN ('cancel','return')),
  reason         TEXT NOT NULL DEFAULT '',
  refund_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 9. Sale Return Items
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_return_items (
  id             SERIAL PRIMARY KEY,
  return_id      INTEGER NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
  sale_item_id   INTEGER NOT NULL REFERENCES sale_items(id),
  medicine_id    INTEGER NOT NULL REFERENCES medicines(id),
  batch_id       INTEGER NOT NULL REFERENCES batches(id),
  quantity       INTEGER NOT NULL,
  unit_price     NUMERIC(12, 2) NOT NULL,
  gst_rate       NUMERIC(5, 2) NOT NULL DEFAULT 0.00,
  refund_amount  NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  restocked      INTEGER NOT NULL DEFAULT 1
);

-- ----------------------------------------------------------------------------
-- 10. Stock Writeoffs Audit Log
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_writeoffs (
  id            SERIAL PRIMARY KEY,
  batch_id      INTEGER NOT NULL REFERENCES batches(id),
  medicine_id   INTEGER NOT NULL REFERENCES medicines(id),
  medicine_name TEXT NOT NULL,
  company       TEXT NOT NULL,
  batch_number  VARCHAR(255) NOT NULL,
  expiry_date   DATE NOT NULL,
  quantity      INTEGER NOT NULL,
  cost_value    NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  reason        TEXT NOT NULL DEFAULT 'expired',
  note          TEXT NOT NULL DEFAULT '',
  user_id       INTEGER NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 11. Store Settings
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  store_name      TEXT NOT NULL DEFAULT 'My Medical Store',
  store_address   TEXT NOT NULL DEFAULT '',
  phone           VARCHAR(50) NOT NULL DEFAULT '',
  license_number  VARCHAR(100) NOT NULL DEFAULT '',
  gst_enabled     INTEGER NOT NULL DEFAULT 0,
  gst_number      VARCHAR(50) NOT NULL DEFAULT '',
  currency        VARCHAR(10) NOT NULL DEFAULT '₹'
);

-- ----------------------------------------------------------------------------
-- 12. Sessions Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at  TIMESTAMPTZ NOT NULL,
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 13. Login Attempts Table
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS login_attempts (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(255) NOT NULL,
  ip          VARCHAR(100) NOT NULL DEFAULT '',
  success     INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- Performance Indexes
-- ----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_batches_medicine ON batches(medicine_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS idx_login_attempts_user ON login_attempts(username, created_at);

-- ----------------------------------------------------------------------------
-- Seed Store Settings (Default)
-- ----------------------------------------------------------------------------
INSERT INTO settings (id, store_name, store_address, phone, license_number, gst_enabled, gst_number, currency)
VALUES (1, 'MediStock Pharmacy', 'Shop No. 12, Main Market Road', '+91 98765 43210', 'DL-PH-2024-001', 1, '22AAAAA0000A1Z5', '₹')
ON CONFLICT (id) DO NOTHING;

-- Seed Default Accounts (Passwords: owner123 / staff123 hashed with scrypt)
-- Hashes generated with Node crypto.scryptSync(password, salt, 64, {N:16384, r:8, p:1})
INSERT INTO users (username, password_hash, salt, name, role, active, algo)
VALUES 
  ('owner', '080b11ba57691e061a77cd649e2484e72ef49c889bbdbb45d525d6f6f043ba927ff69cfde9fb564bc1ae6af99e4fa18deaca0665db97aadde28ec4966fcc073b', '11223344556677889900aabbccddeeff', 'Store Owner', 'owner', 1, 'scrypt'),
  ('staff', '56248f1da8e18679704b625f32ed6e5a6d406058b72163569dd7348e4176c7d4362a21324d9b36853b2b84b43bb6dc8f9b93e44ebc2c422cbfed7804b27934c5', 'ffeeddccbbaa00998877665544332211', 'Counter Staff', 'employee', 1, 'scrypt')
ON CONFLICT (username) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Seed Demo Catalog + Opening Stock
-- (mirrors the original demo data; safe to skip by removing this block)
-- ----------------------------------------------------------------------------
INSERT INTO medicines (id, name, company, type, shelf, buy_price, sell_price, gst_rate, low_stock_threshold, active)
VALUES
  (1,  'Dolo 650mg',              'Micro Labs', 'Tablet',    'A1', 1.30,   2.00,  12.00, 30, 1),
  (2,  'Crocin Advance 500mg',    'GSK',        'Tablet',    'A1', 1.00,   1.80,  12.00, 30, 1),
  (3,  'Paracetamol 500mg',       'Cipla',      'Tablet',    'A1', 0.60,   1.20,  12.00, 40, 1),
  (4,  'Azithral 500mg',          'Alembic',    'Tablet',    'A2', 15.50,  22.00, 12.00, 20, 1),
  (5,  'Augmentin 625 Duo',       'GSK',        'Tablet',    'A2', 10.00,  19.50, 12.00, 20, 1),
  (6,  'Pantop 40mg',             'Aristo',     'Tablet',    'A3', 10.00,  8.50,  12.00, 30, 1),
  (7,  'Shelcal 500',             'Torrent',    'Tablet',    'A3', 6.00,   9.00,  12.00, 25, 1),
  (8,  'Telma 40mg',              'Glenmark',   'Tablet',    'A4', 7.50,   11.00, 12.00, 15, 1),
  (9,  'Glycomet GP2',            'USV',        'Tablet',    'A4', 6.80,   10.50, 12.00, 20, 1),
  (10, 'Ecosprin 75mg',           'USV',        'Tablet',    'A5', 0.90,   1.50,   5.00, 40, 1),
  (11, 'Benadryl Syrup 150ml',    'J&J',        'Syrup',     'B1', 92.00,  118.00, 12.00, 10, 1),
  (12, 'Ascoril LS Syrup',        'Glenmark',   'Syrup',     'B1', 98.00,  125.00, 12.00, 10, 1),
  (13, 'Digene Gel 200ml',        'Abbott',     'Syrup',     'B2', 105.00, 135.00, 12.00,  8, 1),
  (14, 'ORS Powder Sachet',       'FDC',        'Powder',    'B2', 3.50,   6.00,   5.00, 50, 1),
  (15, 'Dettol Antiseptic 250ml', 'Reckitt',    'Other',     'C1', 130.00, 165.00, 18.00,  8, 1),
  (16, 'Volini Spray 60g',        'Sun Pharma', 'Other',     'C1', 160.00, 198.00, 18.00,  6, 1),
  (17, 'Insulin Glargine 100IU',  'Biocon',     'Injection', 'C2', 420.00, 495.00,  5.00,  5, 1),
  (18, 'Human Albumin 20%',       'Baxalta',    'Injection', 'C2', 1250.00, 1450.00, 5.00, 3, 1)
ON CONFLICT (id) DO NOTHING;

-- One demo purchase carrying the opening stock batches (total 7606.30)
INSERT INTO purchases (id, invoice_number, supplier_name, user_id, total, status)
VALUES (1, 'PINV-1001', 'Sri Balaji Agencies', 1, 7606.30, 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO purchase_items (purchase_id, medicine_id, batch_number, expiry_date, quantity, buy_price)
VALUES
  (1, 1,  'DL2401', '2027-10-08', 200, 1.30),
  (1, 1,  'DL2402', '2027-01-11', 120, 1.30),
  (1, 2,  'CR4501', '2027-08-29', 172, 1.00),
  (1, 3,  'PC3301', '2027-12-27', 289, 0.60),
  (1, 4,  'AZ2201', '2027-04-11',  80, 15.50),
  (1, 4,  'AZ2202', '2026-10-13',  13, 15.50),
  (1, 5,  'AG6101', '2027-06-10',  38, 10.00),
  (1, 6,  'PT4402', '2026-09-28',  21, 10.00),
  (1, 6,  'PT4401', '2027-08-14', 120, 10.00),
  (1, 7,  'SH5501', '2028-02-05',  78, 6.00),
  (1, 8,  'TL4001', '2027-03-02',  35, 7.50),
  (1, 9,  'GM2201', '2027-07-30',  60, 6.80),
  (1, 10, 'EC7501', '2027-11-17', 241, 0.90),
  (1, 11, 'BD1501', '2027-05-21',   5, 92.00),
  (1, 13, 'DG2001', '2027-07-10',  11, 105.00),
  (1, 14, 'OR0051', '2028-04-05', 138, 3.50),
  (1, 16, 'VL0601', '2027-09-18',   1, 160.00);

INSERT INTO batches (medicine_id, batch_number, expiry_date, quantity)
VALUES
  (1,  'DL2401', '2027-10-08', 200),
  (1,  'DL2402', '2027-01-11', 120),
  (2,  'CR4501', '2027-08-29', 172),
  (3,  'PC3301', '2027-12-27', 289),
  (4,  'AZ2201', '2027-04-11',  80),
  (4,  'AZ2202', '2026-10-13',  13),
  (5,  'AG6101', '2027-06-10',  38),
  (6,  'PT4402', '2026-09-28',  21),
  (6,  'PT4401', '2027-08-14', 120),
  (7,  'SH5501', '2028-02-05',  78),
  (8,  'TL4001', '2027-03-02',  35),
  (9,  'GM2201', '2027-07-30',  60),
  (10, 'EC7501', '2027-11-17', 241),
  (11, 'BD1501', '2027-05-21',   5),
  (13, 'DG2001', '2027-07-10',  11),
  (14, 'OR0051', '2028-04-05', 138),
  (16, 'VL0601', '2027-09-18',   1)
ON CONFLICT (medicine_id, batch_number) DO NOTHING;

-- Advance the id sequences past the explicitly-seeded rows, so the first
-- INSERT from the app does not collide with the seed ids.
SELECT setval('medicines_id_seq', COALESCE((SELECT MAX(id) FROM medicines), 1));
SELECT setval('purchases_id_seq', COALESCE((SELECT MAX(id) FROM purchases), 1));
