let Sentry = null;
try {
  Sentry = require('@sentry/node');
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 0.1,
      environment: process.env.NODE_ENV || 'development',
    });
    console.log('[Sentry] Initialized backend APM & error tracking.');
  }
} catch (e) {}

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { pool, transaction, addUser, verifyPassword, setUserPassword } = require('./db');
const {
  loginIpLimiter,
  publicPdfLimiter,
  billingLimiter,
  aiScannerLimiter,
  importLimiter,
  getRateLimitStatus,
} = require('./lib/rateLimit');

const app = express();

// CORS — allow the deployed frontend origin(s) and local dev
const allowedOrigins = [
  'http://localhost:5173',           // Vite dev server
  'http://localhost:3001',           // Local dev (server serves client)
  'http://localhost:3002',           // Local dev (medistock-admin)
  'http://localhost:3000',           // Next.js default port
  'http://localhost',                // Capacitor Android WebView (default scheme, no port)
  'https://localhost',               // Capacitor Android WebView (default scheme)
  'capacitor://localhost',           // Capacitor iOS WebView
  'ionic://localhost',               // Ionic WebView
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
  'https://medistock.vercel.app',    // Main Vercel frontend
  'https://medistock-api.vercel.app', // API domain if different
  /^http:\/\/localhost:\d+$/,        // Any local dev port
  /^http:\/\/127\.0\.0\.1:\d+$/,     // Any local 127.0.0.1 port
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

/* Every shop runs on Indian time, so "day" boundaries follow the shop's wall
   clock (IST), not the database server's timezone — a bill saved at 00:30
   stays on today's list instead of landing on yesterday. */
const istDay = (col) => `(${col} AT TIME ZONE 'Asia/Kolkata')::date`;
const IST_TODAY = "(now() AT TIME ZONE 'Asia/Kolkata')::date";

/* Shareable invoice links: an unguessable token per sale so customers can open
   their bill without logging in. Pinned to INVOICE_SHARE_SECRET so rotating
   the database connection string does not invalidate active invoice links. */
const INVOICE_SECRET = process.env.INVOICE_SHARE_SECRET;
if (!INVOICE_SECRET) {
  throw new Error('INVOICE_SHARE_SECRET env var is required. Generate via: ' +
    'crypto.createHash("sha256").update(OLD_DATABASE_URL + "|medistock-invoice-share").digest("hex")');
}
function invoiceToken(saleId) {
  return crypto.createHmac('sha256', INVOICE_SECRET).update(String(saleId)).digest('hex').slice(0, 24);
}

function verifyInvoiceToken(saleId, candidateToken) {
  if (!saleId || !candidateToken || typeof candidateToken !== 'string') return false;
  const expected = invoiceToken(saleId);
  const bufA = Buffer.from(candidateToken, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
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

// ---------------------------------------------------------------------------
// Health Check Endpoint — verifies pool connectivity with a 1-second timeout
// ---------------------------------------------------------------------------
app.get('/api/health', async (req, res) => {
  const start = Date.now();
  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Database ping timeout (2.5s exceeded)')), 2500)
    );
    await Promise.race([pool.query('SELECT 1'), timeoutPromise]);
    const latency_ms = Date.now() - start;
    res.json({
      status: 'ok',
      db: { connected: true, latency_ms },
      ratelimit: getRateLimitStatus(),
      uptime_seconds: Math.floor(process.uptime()),
      version: '1.0.0',
    });
  } catch (err) {
    const latency_ms = Date.now() - start;
    if (Sentry && process.env.SENTRY_DSN) Sentry.captureException(err);
    res.status(503).json({
      status: 'error',
      db: { connected: false, latency_ms, error: err.message },
      ratelimit: getRateLimitStatus(),
      uptime_seconds: Math.floor(process.uptime()),
      version: '1.0.0',
    });
  }
});

// ---------------------------------------------------------------------------
// DB Hygiene Cron Endpoint — Daily automated cleanup of expired records
// Protected by CRON_SECRET header comparison (crypto.timingSafeEqual)
// ---------------------------------------------------------------------------
app.post('/api/cron/cleanup', async (req, res, next) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret) {
      return res.status(500).json({ error: 'CRON_SECRET environment variable is not set' });
    }

    const authHeader = String(req.headers.authorization || '');
    const candidate = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    const bufCandidate = Buffer.from(candidate, 'utf8');
    const bufExpected = Buffer.from(cronSecret, 'utf8');

    if (bufCandidate.length !== bufExpected.length || !crypto.timingSafeEqual(bufCandidate, bufExpected)) {
      return res.status(401).json({ error: 'Unauthorized — invalid or missing cron secret' });
    }

    await ensureSchema();

    // 1. Delete expired sessions
    let deletedSessions = 0;
    await transaction(async (client) => {
      const { rowCount } = await client.query('DELETE FROM sessions WHERE expires_at < NOW()');
      deletedSessions = rowCount;
    });

    // 2. Delete login attempts older than 30 days
    let deletedLoginAttempts = 0;
    await transaction(async (client) => {
      const { rowCount } = await client.query("DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '30 days'");
      deletedLoginAttempts = rowCount;
    });

    // 3. Delete webhook deduplication events older than 30 days
    let deletedWebhookEvents = 0;
    await transaction(async (client) => {
      const { rowCount } = await client.query("DELETE FROM webhook_events WHERE processed_at < NOW() - INTERVAL '30 days'");
      deletedWebhookEvents = rowCount;
    });

    const deleted = {
      sessions: deletedSessions,
      login_attempts: deletedLoginAttempts,
      webhook_events: deletedWebhookEvents,
    };

    console.log('[Cron Cleanup] Executed daily database hygiene:', JSON.stringify(deleted));

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      deleted,
    });
  } catch (e) { next(e); }
});

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

// ---------------------------------------------------------------------------
// Multi-tenant schema — adds store_id scoping to every business table and
// migrates pre-existing single-tenant data into one default store. Runs once
// at boot; requireAuth awaits it so no request ever sees a half-migrated DB.
// ---------------------------------------------------------------------------
let schemaReadyPromise = null;
function ensureSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tenants (
          id SERIAL PRIMARY KEY,
          store_name TEXT NOT NULL,
          owner_name TEXT NOT NULL,
          phone VARCHAR(30) NOT NULL,
          email VARCHAR(255) DEFAULT '',
          city VARCHAR(100) DEFAULT '',
          state VARCHAR(100) DEFAULT '',
          address TEXT DEFAULT '',
          license_number VARCHAR(100) DEFAULT '',
          plan VARCHAR(50) NOT NULL DEFAULT 'trial',
          status VARCHAR(50) NOT NULL DEFAULT 'trial',
          tier VARCHAR(20) NOT NULL DEFAULT 'starter',
          price_per_month NUMERIC(10, 2) NOT NULL DEFAULT 999.00,
          trial_ends_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + interval '30 days'),
          subscription_ends_at TIMESTAMPTZ,
          total_bills INTEGER NOT NULL DEFAULT 0,
          total_medicines INTEGER NOT NULL DEFAULT 0,
          last_active_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const { rows: tc } = await pool.query('SELECT COUNT(*)::int AS count FROM tenants');
      if (tc[0].count === 0) {
        await pool.query(`
          INSERT INTO tenants (store_name, owner_name, phone, city, state, license_number, plan, status, price_per_month, trial_ends_at, subscription_ends_at, total_bills, total_medicines, last_active_at, created_at)
          VALUES
            ('Apollo Medicos', 'Suresh Sharma', '+91 98234 11223', 'Mumbai', 'Maharashtra', 'DL-MH-2024-991', 'monthly', 'active', 999.00, now() - interval '60 days', now() + interval '24 days', 1420, 850, now() - interval '10 minutes', now() - interval '90 days'),
            ('Gupta Chemist & Druggist', 'Rajesh Gupta', '+91 98111 22334', 'Delhi', 'Delhi', 'DL-DL-2024-442', 'monthly', 'active', 999.00, now() - interval '45 days', now() + interval '12 days', 980, 620, now() - interval '25 minutes', now() - interval '75 days'),
            ('City Pharmacy & Surgical', 'Mohammed Naved', '+91 99887 76655', 'Lucknow', 'Uttar Pradesh', 'DL-UP-2024-118', 'yearly', 'active', 833.00, now() - interval '120 days', now() + interval '210 days', 3420, 1420, now() - interval '5 minutes', now() - interval '150 days'),
            ('Al-Shifa Medical Store', 'Dr. Farhan Ali', '+91 97654 32109', 'Hyderabad', 'Telangana', 'DL-TS-2024-773', 'monthly', 'active', 999.00, now() - interval '30 days', now() + interval '2 days', 640, 480, now() - interval '1 hour', now() - interval '60 days'),
            ('Metro Care Pharmacy', 'Anil Verma', '+91 98333 44556', 'Bangalore', 'Karnataka', 'DL-KA-2024-301', 'trial', 'trial', 999.00, now() + interval '3 days', null, 145, 230, now() - interval '2 hours', now() - interval '27 days'),
            ('Sharma Medical Hall', 'Vikram Sharma', '+91 98777 66554', 'Jaipur', 'Rajasthan', 'DL-RJ-2024-812', 'trial', 'trial', 999.00, now() + interval '18 days', null, 82, 190, now() - interval '4 hours', now() - interval '12 days'),
            ('Modern Chemist', 'Amit Patel', '+91 98980 12345', 'Ahmedabad', 'Gujarat', 'DL-GJ-2024-521', 'monthly', 'active', 999.00, now() - interval '90 days', now() + interval '18 days', 1890, 950, now() - interval '30 minutes', now() - interval '120 days'),
            ('Kolkata Life Care', 'Subhash Bose', '+91 98310 98765', 'Kolkata', 'West Bengal', 'DL-WB-2024-609', 'trial', 'trial', 999.00, now() + interval '1 day', null, 110, 310, now() - interval '3 hours', now() - interval '29 days'),
            ('Janata Aushadhi Kendra', 'Pankaj Tiwari', '+91 94500 11223', 'Varanasi', 'Uttar Pradesh', 'DL-UP-2024-904', 'trial', 'expired', 999.00, now() - interval '4 days', null, 95, 140, now() - interval '5 days', now() - interval '34 days'),
            ('National Pharmacy', 'Sunil Deshmukh', '+91 98220 55443', 'Pune', 'Maharashtra', 'DL-MH-2024-114', 'monthly', 'suspended', 999.00, now() - interval '60 days', now() - interval '8 days', 430, 290, now() - interval '8 days', now() - interval '80 days')
        `);
      }

      // Per-store scoping columns on every business table.
      for (const t of ['users', 'medicines', 'batches', 'purchases', 'sales', 'customers', 'stock_writeoffs', 'settings']) {
        await pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS store_id INTEGER`);
      }
      // Platform admin flag: the SaaS operator (you), not a store owner.
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS platform_admin INTEGER NOT NULL DEFAULT 0');
      // settings.id used to be pinned to 1; per-store rows need that check gone.
      try { await pool.query('ALTER TABLE settings DROP CONSTRAINT settings_id_check'); } catch { /* already dropped */ }
      // Scope medicine name+company uniqueness per-store instead of globally
      try {
        await pool.query('ALTER TABLE medicines DROP CONSTRAINT IF EXISTS unique_medicine_company');
        await pool.query('ALTER TABLE medicines ADD CONSTRAINT unique_medicine_company_store UNIQUE (name, company, store_id)');
      } catch { /* already migrated */ }
      // Scope purchase invoice numbers per-store (prevent accidental duplicate entries & stock doubling)
      try {
        await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_store_invoice ON purchases (store_id, invoice_number)');
      } catch (e) {
        console.warn('idx_purchases_store_invoice index note:', e.message);
      }

      // One-time migration: pull every orphan (pre-multi-tenant) row into the
      // default store created from the original single-tenant settings row.
      const orphans = (await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE store_id IS NULL')).rows[0].c;
      if (orphans > 0) {
        const s = (await pool.query('SELECT * FROM settings WHERE store_id IS NULL ORDER BY id LIMIT 1')).rows[0]
          || (await pool.query('SELECT * FROM settings ORDER BY id LIMIT 1')).rows[0];
        const storeName = (s && s.store_name) || 'My Medical Store';
        let tid = (await pool.query('SELECT id FROM tenants WHERE store_name = $1 ORDER BY id LIMIT 1', [storeName])).rows[0]?.id;
        if (!tid) {
          tid = (await pool.query(
            `INSERT INTO tenants (store_name, owner_name, phone, plan, status, price_per_month, trial_ends_at, subscription_ends_at)
             VALUES ($1, 'Owner', '', 'lifetime', 'active', 0, now() - interval '1 day', now() + interval '10 years')
             RETURNING id`,
            [storeName]
          )).rows[0].id;
        }
        for (const t of ['users', 'medicines', 'batches', 'purchases', 'sales', 'customers', 'stock_writeoffs', 'settings']) {
          await pool.query(`UPDATE ${t} SET store_id = $1 WHERE store_id IS NULL`, [tid]);
        }
        // The original owners operate the SaaS platform itself.
        await pool.query("UPDATE users SET platform_admin = 1 WHERE role = 'owner' AND store_id = $1", [tid]);
      }

      // Feature-tier pricing ladder (Starter / Pro / Elite). Backfill: active
      // trials get Elite (the trial is the full experience), paid legacy plans
      // map to their closest tier.
      await pool.query("ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'starter'");
      await pool.query("UPDATE tenants SET tier = 'elite' WHERE plan = 'lifetime' AND tier = 'starter'");
      await pool.query("UPDATE tenants SET tier = 'pro' WHERE plan IN ('monthly', 'yearly') AND tier = 'starter'");
      await pool.query("UPDATE tenants SET tier = 'elite' WHERE status = 'trial' AND tier = 'starter'");

      // Refer & Earn ecosystem columns & ledger
      await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS referral_code VARCHAR(50)');
      await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS referred_by_tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL');
      await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS referral_wallet_balance NUMERIC(10, 2) NOT NULL DEFAULT 0.00');
      await pool.query('ALTER TABLE tenants ADD COLUMN IF NOT EXISTS referral_total_earned NUMERIC(10, 2) NOT NULL DEFAULT 0.00');
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_referral_code ON tenants(referral_code)');

      await pool.query(`
        CREATE TABLE IF NOT EXISTS referral_transactions (
          id SERIAL PRIMARY KEY,
          tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          referred_tenant_id INTEGER REFERENCES tenants(id) ON DELETE SET NULL,
          type VARCHAR(30) NOT NULL,
          amount NUMERIC(10, 2) NOT NULL,
          plan_id VARCHAR(50),
          plan_amount NUMERIC(10, 2),
          upi_id VARCHAR(100),
          status VARCHAR(30) NOT NULL DEFAULT 'completed',
          note TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_ref_tx_tenant ON referral_transactions(tenant_id)');

      const noCodes = (await pool.query('SELECT id, store_name FROM tenants WHERE referral_code IS NULL')).rows;
      for (const t of noCodes) {
        const clean = String(t.store_name || 'STORE')
          .toUpperCase()
          .replace(/[^A-Z0-9]/g, '')
          .slice(0, 6) || 'MEDI';
        const code = `${clean}${t.id}`;
        await pool.query('UPDATE tenants SET referral_code = $1 WHERE id = $2', [code, t.id]);
      }

      await ensureTenantPaymentsTable();

      // Production performance composite indexes
      await pool.query('CREATE INDEX IF NOT EXISTS idx_sales_store_created ON sales(store_id, created_at DESC)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_batches_store_expiry ON batches(store_id, expiry_date ASC)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_customer_ledger_customer_created ON customer_ledger(customer_id, created_at DESC)');
      await pool.query('CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)');
    })().catch((e) => { schemaReadyPromise = null; throw e; });
  }
  return schemaReadyPromise;
}
// Kick off at load, but never crash the process if the DB is briefly down —
// requireAuth re-awaits the (reset) promise on every request until it succeeds.
ensureSchema().catch((e) => console.error('schema init deferred:', e.message));

function requireAuth(req, res, next) {
  ensureSchema().then(() => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Not logged in', code: 'session_invalid' });
    return pool.query(
      "SELECT s.token, u.id, u.username, u.name, u.role, u.active, u.store_id, u.platform_admin, t.status AS tenant_status, t.plan AS tenant_plan, t.tier AS tenant_tier, t.trial_ends_at, t.subscription_ends_at FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN tenants t ON t.id = u.store_id WHERE s.token = $1 AND s.expires_at > now()",
      [token]
    ).then(({ rows }) => {
      const row = rows[0];
      if (!row || !row.active) {
        return res.status(401).json({ error: 'Session expired — please log in again', code: 'session_invalid' });
      }
      pool.query('UPDATE sessions SET last_seen = now() WHERE token = $1', [token]).catch(() => {});
      req.user = { id: row.id, username: row.username, name: row.name, role: row.role,
                   storeId: row.store_id, platformAdmin: row.platform_admin === 1,
                   tenantStatus: row.tenant_status, tenantPlan: row.tenant_plan,
                   trialEndsAt: row.trial_ends_at, subscriptionEndsAt: row.subscription_ends_at };
      req.storeId = row.store_id;
      req.token = token;
      // Feature tier reflects the store's actual subscription plan.
      req.tier = row.tenant_tier || 'starter';

      if (Sentry && process.env.SENTRY_DSN) {
        Sentry.setUser({ id: String(row.id), username: row.username });
        Sentry.setTags({
          store_id: String(row.store_id || ''),
          role: row.role,
          tier: req.tier,
        });
      }
      // Kill-switch & trial enforcement: a suspended/expired store stops
      // working everywhere EXCEPT auth and billing, so the paywall itself
      // stays reachable and a renewal can unlock the store again.
      const openPath = req.path.startsWith('/api/auth') || req.path.startsWith('/api/billing');
      if (!openPath && !row.platform_admin && row.store_id) {
        const nowMs = Date.now();
        const st = row.tenant_status;
        const trialOver = st === 'trial' && row.trial_ends_at && new Date(row.trial_ends_at).getTime() < nowMs;
        const subOver = st === 'active' && row.subscription_ends_at && new Date(row.subscription_ends_at).getTime() < nowMs;
        if (st === 'suspended' || st === 'expired' || trialOver || subOver) {
          return res.status(403).json({
            error: 'Store locked — your trial has ended or payment is pending. Renew to unlock instantly.',
            code: 'subscription_locked',
          });
        }
      }
      next();
    });
  }).catch(next);
}

function requireOwner(req, res, next) {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner access only' });
  next();
}

// The SaaS operator's guard — founder panel / billing management only.
function requirePlatformAdmin(req, res, next) {
  if (!req.user || !req.user.platformAdmin) return res.status(403).json({ error: 'Platform admin only' });
  next();
}

// ---------------------------------------------------------------------------
// Feature tiers (the pricing ladder). Gating lives HERE on the server — hiding
// a button in the app UI is only cosmetic and is never the security boundary.
// ---------------------------------------------------------------------------
const TIER_RANK = { starter: 0, pro: 1, elite: 2 };
const FEATURE_MIN_TIER = {
  khata: 'pro',             // udhaar book writes (reads stay open for everyone)
  whatsapp_bill: 'pro',     // WhatsApp bill sharing after checkout
  import: 'pro',            // Excel/CSV import wizard
  reports: 'pro',           // full sales/purchase reports
  staff_unlimited: 'elite', // Starter = 3 staff (4 total), Pro = 5 staff (6 total), Elite = Unlimited
  scanner: 'elite',         // camera invoice scanner
  whatsapp_summary: 'elite' // daily WhatsApp business summary
};
function tierAllows(tier, feature) {
  const need = FEATURE_MIN_TIER[feature];
  if (!need) return true;
  return (TIER_RANK[tier] ?? 0) >= TIER_RANK[need];
}
function requireFeature(feature) {
  return (req, res, next) => {
    if (req.user.platformAdmin || tierAllows(req.tier, feature)) return next();
    const need = FEATURE_MIN_TIER[feature];
    res.status(402).json({
      error: 'This feature is not part of your current plan. Upgrade on the Subscription page to unlock it.',
      code: 'feature_locked', feature, required_tier: need,
    });
  };
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
// First-time Store Registration — anyone can register a NEW pharmacy and get
// their own isolated store space with a 14-day free trial. Every store's data
// (medicines, bills, khata) is private to that store.
// ---------------------------------------------------------------------------
app.post('/api/auth/signup', async (req, res, next) => {
  try {
    await ensureSchema();
    const { store_name, name, username, password, phone, referral_code } = req.body || {};
    if (!store_name?.trim() || !username?.trim() || !password || !name?.trim()) {
      return bad(res, 400, 'Store name, owner name, username and password are required');
    }
    if (String(password).length < 6) {
      return bad(res, 400, 'Password must be at least 6 characters');
    }

    const uname = String(username).trim();
    const dupe = (await pool.query('SELECT id FROM users WHERE username = $1', [uname])).rows[0];
    if (dupe) {
      return bad(res, 409, 'That username is already taken');
    }

    // Optional referral code: if valid, grant bonus 7 days (28-day trial) and link referrer
    const refCode = String(referral_code || '').trim().toUpperCase();
    let referrerTenantId = null;
    let trialDays = 21; // Baseline trial is 21 days
    if (refCode) {
      const refRow = (await pool.query('SELECT id FROM tenants WHERE UPPER(referral_code) = $1', [refCode])).rows[0];
      if (refRow) {
        referrerTenantId = refRow.id;
        trialDays = 28; // Bonus 7 days for using referral code (28 days)!
      }
    }

    // 1. Create the store (tenant) with trial (21 days, or 28 with referral).
    const tenantRes = (await pool.query(
      `INSERT INTO tenants (store_name, owner_name, phone, plan, status, tier, trial_ends_at, referred_by_tenant_id)
       VALUES ($1, $2, $3, 'trial', 'trial', 'elite', now() + make_interval(days => $4::int), $5)
       RETURNING id, trial_ends_at, status, plan, tier`,
      [String(store_name).trim().slice(0, 200), String(name).trim().slice(0, 200), String(phone || '').trim().slice(0, 30), trialDays, referrerTenantId]
    )).rows[0];
    const tid = tenantRes.id;

    // Generate unique referral code for the new store
    const cleanPrefix = String(store_name || 'STORE')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 6) || 'MEDI';
    const myCode = `${cleanPrefix}${tid}`;
    await pool.query('UPDATE tenants SET referral_code = $1 WHERE id = $2', [myCode, tid]);

    // 2. Give the store its own settings row (bill header uses it).
    await pool.query(
      `INSERT INTO settings (id, store_id, store_name, store_address, phone, license_number, gst_enabled, gst_number, currency)
       VALUES ($1, $1, $2, '', $3, '', 0, '', '₹')`,
      [tid, String(store_name).trim(), String(phone || '').trim()]
    );

    // 3. Create the store owner account and log them in.
    const userId = await addUser(uname, String(password), String(name).trim(), 'owner', tid);
    const token = await createSession(userId);
    res.json({
      token,
      user: {
        id: userId,
        username: uname,
        name: String(name).trim(),
        role: 'owner',
        store_id: tid,
        tier: 'elite',
        tenantStatus: tenantRes.status,
        tenantPlan: tenantRes.plan,
        trialEndsAt: tenantRes.trial_ends_at,
      }
    });
  } catch (e) { next(e); }
});

app.post('/api/auth/login', loginIpLimiter, async (req, res, next) => {
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

    // Kill-switch & trial enforcement at the front door: a suspended or
    // expired store cannot even log in (renewal re-opens it instantly).
    let loginTier = 'starter';
    let tenantRow = null;
    if (u.store_id) {
      tenantRow = (await pool.query('SELECT status, plan, tier, trial_ends_at, subscription_ends_at FROM tenants WHERE id = $1', [u.store_id])).rows[0];
      if (tenantRow) loginTier = tenantRow.tier || 'starter';
      if (tenantRow) {
        const nowMs = Date.now();
        const trialOver = tenantRow.status === 'trial' && tenantRow.trial_ends_at && new Date(tenantRow.trial_ends_at).getTime() < nowMs;
        const subOver = tenantRow.status === 'active' && tenantRow.subscription_ends_at && new Date(tenantRow.subscription_ends_at).getTime() < nowMs;
        if (tenantRow.status === 'suspended' || tenantRow.status === 'expired' || trialOver || subOver) {
          return res.status(403).json({
            error: 'Your store account is locked — trial ended or payment pending. Contact MediStock support to renew.',
            code: 'subscription_locked',
          });
        }
      }
    }

    const token = await createSession(u.id);
    res.json({
      token,
      user: {
        id: u.id,
        username: u.username,
        name: u.name,
        role: u.role,
        platform_admin: u.platform_admin === 1,
        store_id: u.store_id,
        tier: loginTier,
        tenantStatus: tenantRow?.status,
        tenantPlan: tenantRow?.plan,
        trialEndsAt: tenantRow?.trial_ends_at,
        subscriptionEndsAt: tenantRow?.subscription_ends_at,
      }
    });
  } catch (e) { next(e); }
});

app.post('/api/auth/logout', requireAuth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM sessions WHERE token = $1', [req.token]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ ...req.user, tier: req.tier }));

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
      'SELECT m.id, m.name, m.company, m.type, m.shelf, m.buy_price::float8 AS buy_price, m.sell_price::float8 AS sell_price, m.gst_rate::float8 AS gst_rate, m.low_stock_threshold, m.logo_url, COALESCE(SUM(b.quantity), 0)::int AS stock, MIN(CASE WHEN b.quantity > 0 THEN b.expiry_date END) AS nearest_expiry FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id WHERE m.store_id = $2 AND m.active = 1 AND (m.name ILIKE $1 OR m.company ILIKE $1) GROUP BY m.id ORDER BY m.name LIMIT 500',
      [like, req.storeId]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/medicines/:id/batches', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.id, b.batch_number, b.expiry_date, b.quantity, (b.expiry_date - ${IST_TODAY}) AS days_left FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.medicine_id = $1 AND m.store_id = $2 AND b.quantity > 0 ORDER BY b.expiry_date ASC`,
      [asId(req.params.id), req.storeId]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

/** Every batch of a medicine including empty ones, plus write-off history. */
app.get('/api/medicines/:id/detail', requireAuth, async (req, res, next) => {
  try {
    const medId = asId(req.params.id);
    const med = (await pool.query('SELECT * FROM medicines WHERE id = $1 AND store_id = $2', [medId, req.storeId])).rows[0];
    if (!med) return bad(res, 404, 'Medicine not found');
    const batches = (await pool.query(
      `SELECT id, batch_number, expiry_date, quantity, (expiry_date - ${IST_TODAY}) AS days_left FROM batches WHERE medicine_id = $1 ORDER BY expiry_date ASC`,
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
      'SELECT b.*, m.name, m.company, m.buy_price::float8 AS buy_price FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE b.id = $1 AND m.store_id = $2',
      [asId(req.params.id), req.storeId]
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
        'INSERT INTO stock_writeoffs (batch_id, medicine_id, medicine_name, company, batch_number, expiry_date, quantity, cost_value, reason, note, user_id, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)',
        [batch.id, batch.medicine_id, batch.name, batch.company, batch.batch_number,
         batch.expiry_date, qty, qty * batch.buy_price, why, String(note || '').trim(), req.user.id, req.storeId]
      );
    });
    res.json({ ok: true, removed: qty, cost_value: qty * batch.buy_price });
  } catch (e) { next(e); }
});

app.get('/api/writeoffs', requireAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT w.*, w.cost_value::float8 AS cost_value, u.name AS user_name FROM stock_writeoffs w JOIN users u ON u.id = w.user_id WHERE w.store_id = $1 ORDER BY w.id DESC LIMIT 200',
      [req.storeId]
    );
    const total = rows.reduce((s, r) => s + Number(r.cost_value), 0);
    res.json({ rows, total_loss: total });
  } catch (e) { next(e); }
});

/** Soft delete — the medicine leaves the catalog but its sales history stays intact. */
app.delete('/api/medicines/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const medId = asId(req.params.id);
    const med = (await pool.query('SELECT * FROM medicines WHERE id = $1 AND active = 1 AND store_id = $2', [medId, req.storeId])).rows[0];
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
    const existing = (await pool.query('SELECT * FROM medicines WHERE name = $1 AND company = $2 AND store_id = $3', [nm, co, req.storeId])).rows[0];
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
      'INSERT INTO medicines (name, company, type, shelf, buy_price, sell_price, gst_rate, low_stock_threshold, logo_url, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
      [nm, co, String(type || 'Tablet'), String(shelf || '').trim(),
       Number(buy_price) || 0, Number(sell_price) || 0, Number(gst_rate) || 0, Number(low_stock_threshold) || 10, logo, req.storeId]
    );
    res.json({ id: r.rows[0].id });
  } catch (e) { next(e); }
});

app.put('/api/medicines/:id', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const m = (await pool.query('SELECT * FROM medicines WHERE id = $1 AND store_id = $2', [asId(req.params.id), req.storeId])).rows[0];
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
    // Optional YYYY-MM-DD window (IST days); missing/malformed bounds stay open.
    const qFrom = String(req.query.from || '');
    const qTo = String(req.query.to || '');
    const from = DATE_RE.test(qFrom) ? qFrom : '1970-01-01';
    const to = DATE_RE.test(qTo) ? qTo : '2999-12-31';
    const { rows } = await pool.query(
      `SELECT p.id, p.invoice_number, p.supplier_name, p.total::float8 AS total, p.created_at, p.status, p.reversed_at, p.reverse_reason, u.name AS created_by, COUNT(pi.id)::int AS item_count FROM purchases p JOIN users u ON u.id = p.user_id LEFT JOIN purchase_items pi ON pi.purchase_id = p.id WHERE p.store_id = $1 AND ${istDay('p.created_at')} BETWEEN $2 AND $3 GROUP BY p.id, u.name ORDER BY p.id DESC LIMIT 200`,
      [req.storeId, from, to]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

app.get('/api/purchases/:id', requireAuth, async (req, res, next) => {
  try {
    const p = (await pool.query(
      'SELECT p.*, p.total::float8 AS total, u.name AS created_by FROM purchases p JOIN users u ON u.id = p.user_id WHERE p.id = $1 AND p.store_id = $2',
      [asId(req.params.id), req.storeId]
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
    const p = (await pool.query('SELECT * FROM purchases WHERE id = $1 AND store_id = $2', [asId(req.params.id), req.storeId])).rows[0];
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


// ==========================================
// GEMINI AI SCANNER ENDPOINT (L2 Vision)
// ==========================================
app.post('/api/purchases/scan-invoice', requireAuth, requireFeature('scanner'), aiScannerLimiter, async (req, res, next) => {
  try {
    const { image_base64 } = req.body;
    if (!image_base64) {
      return res.status(400).json({ error: 'image_base64 is required' });
    }
    
    const base64Data = image_base64.replace(/^data:image\/\w+;base64,/, '');
    
    // 2MB server-side guard
    const bufferSize = Buffer.byteLength(base64Data, 'base64');
    if (bufferSize > 2 * 1024 * 1024) {
      return res.status(400).json({ error: 'Image exceeds 2MB limit.' });
    }
    
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      if (typeof Sentry !== 'undefined') {
        Sentry.captureException(new Error('GEMINI_API_KEY missing in production environment'));
      }
      return res.status(500).json({ error: 'Server configuration error.' });
    }

    const prompt = `Ye ek Indian pharmaceutical wholesale distributor ki TAX INVOICE ki photo hai. Isse parse karke SIRF ye JSON return karo — koi explanation, koi markdown, koi extra text NahI:
{
  "supplier_name": string|null,
  "invoice_number": string|null,
  "invoice_date": string|null,
  "items": [
    {
      "medicine_name": string,
      "company": string|null,
      "batch_number": string|null,
      "expiry": string|null,
      "quantity": number|null,
      "free_quantity": number|null,
      "rate": number|null
    }
  ]
}

RULES:
Unreadable/unclear field → null (GUESS MAT KARO)
quantity = strips/bottles PURCHASED (paid column only)
free_quantity = bonus/free column, ALAG se
rate = per-unit price, line total NahI
expiry normalize karo: 08/2027 → 2027-08-31 (month-end), 08-2027 → 2027-08-31, Aug-2027 → 2027-08-31, 12/27 → 2027-12-31
Agar items table me multiple pages/split rows hain, sab merge karo
Ye handwritten ho sakta hai — handwriting dhyan se padho`;

    // Support both classic ('AIzaSy') and new v2 ('AQ.') API key formats
    const isClassicKey = apiKey.startsWith('AIzaSy');
    const geminiUrl = isClassicKey
      ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`
      : `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`;
    const geminiHeaders = {
      'Content-Type': 'application/json',
      ...(!isClassicKey ? { 'x-goog-api-key': apiKey } : {})
    };

    const makeGeminiRequest = async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);
      try {
        const response = await fetch(geminiUrl, {
          method: 'POST',
          headers: geminiHeaders,
          body: JSON.stringify({
            contents: [{
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: 'image/jpeg',
                    data: base64Data
                  }
                }
              ]
            }],
            generationConfig: {
              response_mime_type: 'application/json'
            }
          }),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
      } catch (err) {
        clearTimeout(timeoutId);
        throw err;
      }
    };

    const startTime = Date.now();
    let geminiRes;
    try {
      geminiRes = await makeGeminiRequest();
    } catch (e) {
      console.error('[Gemini] API call failed:', e.name || 'Error', e.message || e);
      if (typeof Sentry !== 'undefined') {
        Sentry.captureException(e);
      }
      if (e.name === 'AbortError' || e.type === 'aborted') {
        return res.status(503).json({ error: 'AI service timeout — dobara try karo ya manual entry karo', engine: 'none' });
      }
      return res.status(503).json({ error: 'AI service unavailable.' });
    }

    if (geminiRes.status === 429) {
      console.warn('[Gemini] Rate limit hit (429)');
      return res.status(503).json({ error: 'AI quota exceeded — thodi der me try karo' });
    }
    
    if (!geminiRes.ok) {
      const status = geminiRes.status;
      const errorText = await geminiRes.text().catch(() => 'Unknown upstream error');
      console.error('[Gemini] API call failed:', status, errorText);
      if (status === 404) {
        console.error('[Gemini] Model gemini-2.0-flash not found or not available for this key. Check available models.');
      }
      if (typeof Sentry !== 'undefined' && status >= 500) {
        Sentry.captureMessage(`[Gemini] API upstream error ${status}: ${errorText}`);
      }
      return res.status(502).json({ error: 'Upstream AI error.' });
    }

    const resJson = await geminiRes.json();
    let rawText = resJson.candidates?.[0]?.content?.parts?.[0]?.text;
    
    let parsedData = null;
    try {
      if (rawText) {
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        parsedData = JSON.parse(rawText);
      }
    } catch (e) {
      // 1 retry for malformed JSON
      try {
        const retryRes = await makeGeminiRequest();
        if (!retryRes.ok) {
          const retryStatus = retryRes.status;
          const retryErrText = await retryRes.text().catch(() => 'Unknown error text');
          console.error('[Gemini] Retry API call failed:', retryStatus, retryErrText);
          return res.status(502).json({ error: 'Upstream AI error.' });
        }
        const retryResJson = await retryRes.json();
        let retryRaw = retryResJson.candidates?.[0]?.content?.parts?.[0]?.text;
        if (retryRaw) {
          retryRaw = retryRaw.replace(/```json/g, '').replace(/```/g, '').trim();
          parsedData = JSON.parse(retryRaw);
        }
      } catch (retryErr) {
        return res.status(502).json({ error: 'AI returned malformed data.' });
      }
    }
    
    if (!parsedData || !Array.isArray(parsedData.items)) {
      return res.status(502).json({ error: 'AI returned malformed data.' });
    }

    // Validation after response bounds
    parsedData.items = parsedData.items.map(item => {
      let qty = item.quantity;
      if (qty !== null && qty !== undefined) {
        qty = Number(qty);
        if (isNaN(qty) || qty < 0 || qty > 10000) qty = null;
      } else {
        qty = null;
      }
      
      let rate = item.rate;
      if (rate !== null && rate !== undefined) {
        rate = Number(rate);
        if (isNaN(rate) || rate < 0 || rate > 100000) rate = null;
      } else {
        rate = null;
      }
      
      let expiry = item.expiry;
      if (expiry) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(expiry)) expiry = null;
      }

      return { ...item, quantity: qty, rate, expiry };
    });

    const latency_ms = Date.now() - startTime;
    console.log(`[Gemini Scanner] latency=${latency_ms}ms items=${parsedData.items.length} success=true`);

    return res.json({
      engine: 'gemini',
      invoice_number: parsedData.invoice_number || '',
      supplier_name: parsedData.supplier_name || '',
      invoice_date: parsedData.invoice_date || '',
      items: parsedData.items
    });

  } catch (err) {
    next(err);
  }
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
        'INSERT INTO purchases (invoice_number, supplier_name, user_id, total, store_id) VALUES ($1, $2, $3, 0, $4) RETURNING id',
        [String(invoice_number || '').trim() || 'PINV-' + Date.now(), String(supplier_name || '').trim(), req.user.id, req.storeId]
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
    if (e.code === '23505' || String(e.message).includes('unique_constraint') || String(e.message).includes('duplicate key')) {
      if (e.constraint === 'idx_purchases_store_invoice' || String(e.detail || '').includes('invoice_number') || String(e.message).includes('idx_purchases_store_invoice')) {
        const inv = String(req.body?.invoice_number || '').trim();
        const existing = (await pool.query(
          'SELECT id FROM purchases WHERE store_id = $1 AND invoice_number = $2',
          [req.storeId, inv]
        )).rows[0];
        return res.status(409).json({
          error: 'Invoice number already exists for this store. Re-adding will double your stock — are you sure?',
          code: 'INVOICE_EXISTS',
          existing_purchase_id: existing?.id || null,
        });
      }
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
    const p = (await pool.query('SELECT * FROM purchases WHERE id = $1 AND store_id = $2', [asId(req.params.id), req.storeId])).rows[0];
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
    if (e.code === '23505' || String(e.message).includes('unique_constraint') || String(e.message).includes('duplicate key')) {
      if (e.constraint === 'idx_purchases_store_invoice' || String(e.detail || '').includes('invoice_number') || String(e.message).includes('idx_purchases_store_invoice')) {
        return bad(res, 409, 'Invoice number already exists for another purchase in this store');
      }
      return bad(res, 409, 'Duplicate batch entry in this purchase');
    }
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Sales / Billing (stock OUT - automatic, FEFO)
// ---------------------------------------------------------------------------
app.post('/api/sales', requireAuth, billingLimiter, async (req, res, next) => {
  try {
    const { items, customer_name, customer_phone } = req.body || {};
    if (!Array.isArray(items) || !items.length) return bad(res, 400, 'Cart is empty');
    for (const it of items) {
      if (!Number.isInteger(Number(it.quantity)) || Number(it.quantity) <= 0)
        return bad(res, 400, 'Invalid quantity');
    }
    const settings = (await pool.query('SELECT * FROM settings WHERE store_id = $1', [req.storeId])).rows[0]
      || (await pool.query('SELECT * FROM settings WHERE id = 1')).rows[0];
    const gstEnabled = !!settings?.gst_enabled;
    const custName = String(customer_name || '').trim();
    const custPhone = String(customer_phone || '').replace(/[^\d+]/g, '').slice(0, 20);

    const result = await transaction(async (client) => {
      const maxId = (await client.query('SELECT COALESCE(MAX(id), 0) AS m FROM sales')).rows[0].m + 1;
      const invNo = 'INV-' + new Date().toISOString().slice(0, 10).replaceAll('-', '') + '-' + String(maxId).padStart(4, '0') + '-' + crypto.randomInt(1000, 10000);
      const sr = await client.query(
        'INSERT INTO sales (invoice_number, user_id, customer_name, customer_phone, subtotal, gst_amount, total, store_id) VALUES ($1, $2, $3, $4, 0, 0, 0, $5) RETURNING id',
        [invNo, req.user.id, custName, custPhone, req.storeId]
      );
      const saleId = sr.rows[0].id;

      let subtotal = 0, gstAmount = 0;
      const outItems = [];
      for (const it of items) {
        const m = (await client.query('SELECT * FROM medicines WHERE id = $1 AND active = 1 AND store_id = $2', [asId(it.medicine_id), req.storeId])).rows[0];
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
      'SELECT s.id, s.invoice_number, s.customer_name, s.subtotal, s.gst_amount, s.total, s.created_at, s.status, s.cancelled_at, s.cancel_reason, u.name AS served_by, COUNT(si.id)::int AS item_count, COALESCE(SUM(si.quantity), 0)::int AS units, COALESCE(SUM(si.returned_qty), 0)::int AS returned_units FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.store_id = $3 AND ' + istDay('s.created_at') + ' BETWEEN $1 AND $2 GROUP BY s.id, u.name ORDER BY s.id DESC LIMIT 300',
      [from, to, req.storeId]
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
      'SELECT s.*, s.subtotal::float8 AS subtotal, s.gst_amount::float8 AS gst_amount, s.total::float8 AS total, u.name AS served_by FROM sales s JOIN users u ON u.id = s.user_id WHERE s.id = $1 AND s.store_id = $2',
      [asId(req.params.id), req.storeId]
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
    const sale = (await pool.query('SELECT * FROM sales WHERE id = $1 AND store_id = $2', [asId(req.params.id), req.storeId])).rows[0];
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
    const sale = (await pool.query('SELECT * FROM sales WHERE id = $1 AND store_id = $2', [asId(req.params.id), req.storeId])).rows[0];
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
      'SELECT m.id, m.name, m.company, m.shelf, m.low_stock_threshold, COALESCE(SUM(b.quantity), 0)::int AS stock FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id WHERE m.store_id = $1 AND m.active = 1 GROUP BY m.id HAVING COALESCE(SUM(b.quantity), 0) <= m.low_stock_threshold ORDER BY stock ASC',
      [req.storeId]
    )).rows;

    const expiring = (await pool.query(
      `SELECT b.id, b.batch_number, b.expiry_date, b.quantity, m.name, m.company, m.shelf, (b.expiry_date - ${IST_TODAY}) AS days_left FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.store_id = $1 AND b.quantity > 0 AND b.expiry_date <= ${IST_TODAY} + 90 ORDER BY b.expiry_date ASC`,
      [req.storeId]
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
      "SELECT c.id, c.name, c.phone, COALESCE(SUM(CASE l.kind WHEN 'credit' THEN l.amount ELSE -l.amount END), 0)::float8 AS balance, COALESCE(SUM(CASE WHEN l.kind = 'credit' THEN l.amount ELSE 0 END), 0)::float8 AS total_credit, COUNT(l.id)::int AS entries, MAX(l.created_at) AS last_entry FROM customers c LEFT JOIN customer_ledger l ON l.customer_id = c.id WHERE c.store_id = $1 GROUP BY c.id ORDER BY balance DESC, c.name",
      [req.storeId]
    );
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/khata/customers', requireAuth, requireFeature('khata'), async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const phone = String(req.body?.phone || '').trim();
    if (!name) return bad(res, 400, 'Customer name is required');
    const { rows } = await pool.query(
      'INSERT INTO customers (name, phone, store_id) VALUES ($1, $2, $3) RETURNING id, name, phone',
      [name.slice(0, 200), phone.slice(0, 20), req.storeId]
    );
    res.json(rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/khata/customers/:id', requireAuth, async (req, res, next) => {
  try {
    const cust = (await pool.query('SELECT id, name, phone, created_at FROM customers WHERE id = $1 AND store_id = $2', [asId(req.params.id), req.storeId])).rows[0];
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
app.post('/api/khata/entries', requireAuth, requireFeature('khata'), async (req, res, next) => {
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
      const existing = (await pool.query('SELECT id FROM customers WHERE LOWER(name) = LOWER($1) AND store_id = $2', [nm.slice(0, 200), req.storeId])).rows[0];
      cid = existing
        ? existing.id
        : (await pool.query("INSERT INTO customers (name, phone, store_id) VALUES ($1, '', $2) RETURNING id", [nm.slice(0, 200), req.storeId])).rows[0].id;
    } else if (!(await pool.query('SELECT id FROM customers WHERE id = $1 AND store_id = $2', [cid, req.storeId])).rows[0]) {
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
    if (!id || !verifyInvoiceToken(id, t)) return bad(res, 404, 'Invoice not found');

    const sale = (await pool.query(
      'SELECT id, invoice_number, customer_name, subtotal::float8 AS subtotal, gst_amount::float8 AS gst_amount, total::float8 AS total, status, created_at FROM sales WHERE id = $1',
      [id]
    )).rows[0];
    if (!sale || sale.status === 'cancelled') return bad(res, 404, 'Invoice not found');

    const settings = (await pool.query('SELECT store_name, phone, store_address, gst_number FROM settings WHERE store_id = $1', [sale.store_id])).rows[0] || {};
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
// Uses self-contained standalone PDFKit with embedded standard fonts.
const PDFDocument = require('./lib/pdfkit');

app.get('/api/public/invoice/:id/pdf', publicPdfLimiter, async (req, res, next) => {
  try {
    const id = asId(req.params.id);
    const t = String(req.query.t || '');
    if (!id || !verifyInvoiceToken(id, t)) return bad(res, 404, 'Invoice not found');

    const sale = (await pool.query(
      'SELECT id, invoice_number, customer_name, subtotal::float8 AS subtotal, gst_amount::float8 AS gst_amount, total::float8 AS total, status, created_at FROM sales WHERE id = $1',
      [id]
    )).rows[0];
    if (!sale || sale.status === 'cancelled') return bad(res, 404, 'Invoice not found');

    const settings = (await pool.query('SELECT store_name, phone, store_address, gst_number FROM settings WHERE store_id = $1', [sale.store_id])).rows[0] || {};
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

    // Items table (fixed columns within the 511pt printable width).
    // All header cells share one captured y — doc.y advances after every
    // text() call, so reading it per-cell produces a staircase.
    const colItem = 42, colQty = 330, colRate = 395, colAmt = 475;
    const headY = doc.y;
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000000');
    doc.text('Item', colItem, headY);
    doc.text('Qty', colQty, headY, { width: 55, align: 'center' });
    doc.text('Rate', colRate, headY, { width: 70, align: 'right' });
    doc.text('Amount', colAmt, headY, { width: 78, align: 'right' });
    doc.y = headY + 16;
    doc.moveTo(colItem, doc.y).lineTo(553, doc.y).strokeColor('#999999').stroke();
    doc.y += 8;

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

app.get('/api/whatsapp/summary', requireAuth, requireFeature('whatsapp_summary'), async (req, res, next) => {
  try {
    const [today, purchases, month, low, expiring, khata, settings] = await Promise.all([
      pool.query(
        `SELECT COUNT(DISTINCT s.id)::int AS bills, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue, COALESCE(SUM((si.unit_price - si.cost_price) * (si.quantity - si.returned_qty)), 0)::float8 AS profit FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.store_id = $1 AND ${istDay('s.created_at')} = ${IST_TODAY} AND s.status != 'cancelled'`,
        [req.storeId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS bills, COALESCE(SUM(total), 0)::float8 AS amount FROM purchases WHERE store_id = $1 AND ${istDay('created_at')} = ${IST_TODAY} AND reversed_at IS NULL`,
        [req.storeId]
      ),
      pool.query(
        `SELECT COUNT(DISTINCT s.id)::int AS bills, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.store_id = $1 AND ${istDay('s.created_at')} >= date_trunc('month', ${IST_TODAY})::date AND s.status != 'cancelled'`,
        [req.storeId]
      ),
      pool.query(
        'SELECT m.name FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id WHERE m.store_id = $1 AND m.active = 1 GROUP BY m.id HAVING COALESCE(SUM(b.quantity), 0) <= m.low_stock_threshold ORDER BY COALESCE(SUM(b.quantity), 0) ASC',
        [req.storeId]
      ),
      pool.query(
        `SELECT m.name, b.batch_number, (b.expiry_date - ${IST_TODAY}) AS days_left FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.store_id = $1 AND b.quantity > 0 AND b.expiry_date <= ${IST_TODAY} + 90 ORDER BY b.expiry_date ASC`,
        [req.storeId]
      ),
      pool.query(
        "SELECT COALESCE(SUM(CASE WHEN bal > 0 THEN bal ELSE 0 END), 0)::float8 AS due, COUNT(*) FILTER (WHERE bal > 0.004)::int AS customers FROM (SELECT c.id, COALESCE(SUM(CASE l.kind WHEN 'credit' THEN l.amount ELSE -l.amount END), 0)::float8 AS bal FROM customers c LEFT JOIN customer_ledger l ON l.customer_id = c.id WHERE c.store_id = $1 GROUP BY c.id) t",
        [req.storeId]
      ),
      pool.query('SELECT store_name FROM settings WHERE store_id = $1', [req.storeId]),
    ]);

    const t = today.rows[0];
    const p = purchases.rows[0];
    const mo = month.rows[0];
    const store = (settings.rows[0] || {}).store_name || 'MediStock';
    const inr = (n) => '₹' + Math.round(Number(n)).toLocaleString('en-IN');

    const lines = [];
    lines.push(`🏥 *${store}* — *Daily Business Summary*`);
    lines.push(`📅 *Date:* ${new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })}`);
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
      `SELECT COUNT(DISTINCT s.id)::int AS bills, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.store_id = $1 AND ${istDay('s.created_at')} = ${IST_TODAY} AND s.status != 'cancelled'`,
      [req.storeId]
    )).rows[0];

    const todayProfit = (await pool.query(
      `SELECT COALESCE(SUM((si.unit_price - si.cost_price) * (si.quantity - si.returned_qty)), 0)::float8 AS profit FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.store_id = $1 AND ${istDay('s.created_at')} = ${IST_TODAY} AND s.status != 'cancelled'`,
      [req.storeId]
    )).rows[0].profit;

    const last7 = (await pool.query(
      `SELECT ${istDay('s.created_at')} AS day, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue, COUNT(DISTINCT s.id)::int AS bills FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.store_id = $1 AND ${istDay('s.created_at')} >= ${IST_TODAY} - 6 AND s.status != 'cancelled' GROUP BY day ORDER BY day`,
      [req.storeId]
    )).rows;

    const alerts = (await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM (SELECT m.id FROM medicines m LEFT JOIN batches b ON b.medicine_id = m.id WHERE m.store_id = $1 AND m.active = 1 GROUP BY m.id HAVING COALESCE(SUM(b.quantity), 0) <= m.low_stock_threshold) t_low) AS low, (SELECT COUNT(*)::int FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.store_id = $1 AND b.quantity > 0 AND b.expiry_date <= ${IST_TODAY} + 90) AS expiring`,
      [req.storeId]
    )).rows[0];

    const topSellers = (await pool.query(
      `SELECT si.medicine_name AS name, si.company, SUM(si.quantity - si.returned_qty)::int AS qty, SUM((si.quantity - si.returned_qty) * si.unit_price)::float8 AS revenue FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.store_id = $1 AND ${istDay('s.created_at')} >= ${IST_TODAY} - 6 AND s.status != 'cancelled' GROUP BY si.medicine_id, si.medicine_name, si.company HAVING SUM(si.quantity - si.returned_qty) > 0 ORDER BY qty DESC LIMIT 5`,
      [req.storeId]
    )).rows;

    res.json({ today, todayProfit, last7, alerts, topSellers });
  } catch (e) { next(e); }
});

app.get('/api/reports/sales', requireAuth, requireFeature('reports'), async (req, res, next) => {
  try {
    // Only well-formed YYYY-MM-DD filters reach the database; anything else
    // falls back to the default 30-day window (IST days).
    const qFrom = String(req.query.from || '');
    const qTo = String(req.query.to || '');
    const istDate = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
    const from = DATE_RE.test(qFrom) ? qFrom : istDate(Date.now() - 29 * 86400000);
    const to = DATE_RE.test(qTo) ? qTo : istDate(Date.now());

    const summary = (await pool.query(
      `SELECT COUNT(DISTINCT s.id)::int AS bills, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue, COALESCE(SUM(si.quantity - si.returned_qty), 0)::int AS units, COALESCE(SUM((si.unit_price - si.cost_price) * (si.quantity - si.returned_qty)), 0)::float8 AS profit FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.store_id = $3 AND ${istDay('s.created_at')} BETWEEN $1 AND $2 AND s.status != 'cancelled'`,
      [from, to, req.storeId]
    )).rows[0];

    // Cancellations, returns and written-off stock for the same window.
    const refunds = (await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(r.refund_amount),0)::float8 AS amount FROM sale_returns r JOIN sales s ON s.id = r.sale_id WHERE s.store_id = $3 AND ${istDay('r.created_at')} BETWEEN $1 AND $2`,
      [from, to, req.storeId]
    )).rows[0];

    const cancelled = (await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0)::float8 AS amount FROM sales WHERE store_id = $3 AND status = 'cancelled' AND ${istDay('created_at')} BETWEEN $1 AND $2`,
      [from, to, req.storeId]
    )).rows[0];

    const writeoffs = (await pool.query(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(quantity),0)::int AS units, COALESCE(SUM(cost_value),0)::float8 AS loss FROM stock_writeoffs WHERE store_id = $3 AND ${istDay('created_at')} BETWEEN $1 AND $2`,
      [from, to, req.storeId]
    )).rows[0];

    const bestSellers = (await pool.query(
      `SELECT si.medicine_name AS name, si.company, SUM(si.quantity - si.returned_qty)::int AS qty, SUM((si.quantity - si.returned_qty) * si.unit_price)::float8 AS revenue, SUM((si.unit_price - si.cost_price) * (si.quantity - si.returned_qty))::float8 AS profit FROM sale_items si JOIN sales s ON s.id = si.sale_id WHERE s.store_id = $3 AND ${istDay('s.created_at')} BETWEEN $1 AND $2 AND s.status != 'cancelled' GROUP BY si.medicine_id, si.medicine_name, si.company HAVING SUM(si.quantity - si.returned_qty) > 0 ORDER BY qty DESC LIMIT 10`,
      [from, to, req.storeId]
    )).rows;

    const sales = (await pool.query(
      `SELECT s.id, s.invoice_number, s.total::float8 AS total, s.subtotal::float8 AS subtotal, s.gst_amount::float8 AS gst_amount, s.created_at, s.status, u.name AS served_by, COUNT(si.id)::int AS item_count, COALESCE(SUM(si.returned_qty),0)::int AS returned_units FROM sales s JOIN users u ON u.id = s.user_id LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.store_id = $3 AND ${istDay('s.created_at')} BETWEEN $1 AND $2 GROUP BY s.id, u.name ORDER BY s.id DESC LIMIT 100`,
      [from, to, req.storeId]
    )).rows;

    res.json({ from, to, summary, refunds, cancelled, writeoffs, bestSellers, sales });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Settings & Users
// ---------------------------------------------------------------------------
app.get('/api/settings', requireAuth, async (req, res, next) => {
  try {
    let s = (await pool.query('SELECT * FROM settings WHERE store_id = $1', [req.storeId])).rows[0];
    if (!s) {
      // A freshly registered store without a settings row yet gets defaults.
      const t = (await pool.query('SELECT store_name FROM tenants WHERE id = $1', [req.storeId])).rows[0];
      s = (await pool.query(
        'INSERT INTO settings (id, store_id, store_name, store_address, phone, license_number, gst_enabled, gst_number, currency) VALUES ($1, $1, $2, \'\', \'\', \'\', 0, \'\', \'\u20b9\') ON CONFLICT (id) DO UPDATE SET store_id = $1 RETURNING *',
        [req.storeId, (t && t.store_name) || 'My Medical Store']
      )).rows[0];
    }
    res.json(s);
  } catch (e) { next(e); }
});

app.put('/api/settings', requireAuth, requireOwner, async (req, res, next) => {
  try {
    let s = (await pool.query('SELECT * FROM settings WHERE store_id = $1', [req.storeId])).rows[0];
    if (!s) {
      const t = (await pool.query('SELECT store_name FROM tenants WHERE id = $1', [req.storeId])).rows[0];
      s = (await pool.query(
        'INSERT INTO settings (id, store_id, store_name, store_address, phone, license_number, gst_enabled, gst_number, currency) VALUES ($1, $1, $2, \'\', \'\', \'\', 0, \'\', \'\u20b9\') ON CONFLICT (id) DO UPDATE SET store_id = $1 RETURNING *',
        [req.storeId, (t && t.store_name) || 'My Medical Store']
      )).rows[0];
    }
    const b = req.body || {};
    const updated = await pool.query(
      'UPDATE settings SET store_name=$1, store_address=$2, phone=$3, license_number=$4, gst_enabled=$5, gst_number=$6 WHERE store_id=$7 RETURNING *',
      [
        String(b.store_name ?? s.store_name).trim(), String(b.store_address ?? s.store_address).trim(),
        String(b.phone ?? s.phone).trim(), String(b.license_number ?? s.license_number).trim(),
        b.gst_enabled !== undefined ? (b.gst_enabled ? 1 : 0) : s.gst_enabled,
        String(b.gst_number ?? s.gst_number).trim(),
        req.storeId
      ]
    );
    res.json(updated.rows[0]);
  } catch (e) { next(e); }
});

app.get('/api/users', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT id, username, name, role, active, created_at FROM users WHERE store_id = $1 ORDER BY id', [req.storeId]);
    res.json(rows);
  } catch (e) { next(e); }
});

app.post('/api/users', requireAuth, requireOwner, async (req, res, next) => {
  try {
    const { username, password, name, role } = req.body || {};
    if (!username?.trim() || !password || !name?.trim()) return bad(res, 400, 'Name, username and password are required');
    if (String(password).length < 5) return bad(res, 400, 'Password must be at least 5 characters');
    if (!['owner', 'employee'].includes(role)) return bad(res, 400, 'Invalid role');
    // Staff limits: Starter = 3 staff (4 accounts total), Pro = 5 staff (6 accounts total), Elite = Unlimited.
    // Existing accounts from a higher plan keep working — only new additions are blocked.
    const STAFF_ACCOUNT_LIMIT = { starter: 4, pro: 6 };
    const limit = STAFF_ACCOUNT_LIMIT[req.tier];
    if (limit) {
      const c = (await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE store_id = $1 AND active = 1', [req.storeId])).rows[0].c;
      if (c >= limit) {
        const staffCount = limit - 1;
        const nextTier = req.tier === 'starter' ? 'Pro (5 staff)' : 'Elite (Unlimited staff)';
        const reqTier = req.tier === 'starter' ? 'pro' : 'elite';
        return res.status(402).json({
          error: `Your current ${req.tier.toUpperCase()} plan allows up to ${staffCount} staff accounts. Upgrade to ${nextTier} to add more staff logins.`,
          code: 'feature_locked', feature: 'staff_unlimited', required_tier: reqTier,
        });
      }
    }
    await addUser(String(username).trim(), String(password), String(name).trim(), role, req.storeId);
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
    const u = (await pool.query('SELECT * FROM users WHERE id = $1 AND store_id = $2', [asId(req.params.id), req.storeId])).rows[0];
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
    const u = (await pool.query('SELECT * FROM users WHERE id = $1 AND store_id = $2', [asId(req.params.id), req.storeId])).rows[0];
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
   formats Indian ERPs export (DD/MM/YYYY, DD-MM-YYYY, DD.MM.YY, YYYY-MM-DD,
   MM/YYYY, M/YYYY, MM-YYYY, M-YYYY).
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
  // Full date: YYYY-MM-DD or DD/MM/YYYY, DD-MM-YYYY, DD.MM.YY
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (!m) m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  // Month/Year only: MM/YYYY, M/YYYY, MM-YYYY, M-YYYY (common for pharma expiry)
  if (!m) m = /^(\d{1,2})[\/\-](\d{4})$/.exec(s);
  if (!m) return null;
  let y, mo, d;
  if (/^\d{4}-/.test(s)) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if (m[1].length <= 2 && m[2].length === 4) { mo = +m[1]; y = +m[2]; d = 1; } // MM/YYYY -> 1st of month
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

app.post('/api/import/parse', requireAuth, requireFeature('import'), requireOwner, async (req, res, next) => {
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

app.post('/api/import/commit', requireAuth, requireOwner, requireFeature('import'), importLimiter, async (req, res, next) => {
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
            'SELECT id, active FROM medicines WHERE lower(name) = lower($1) AND lower(company) = lower($2) AND store_id = $3 ORDER BY id LIMIT 1',
            [nm, co, req.storeId]
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
            'INSERT INTO medicines (name, company, type, shelf, buy_price, sell_price, gst_rate, low_stock_threshold, logo_url, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id',
            [nm, co, type, shelf, buy, sell, gst, 10, logoFor(co), req.storeId]
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
              await client.query('INSERT INTO batches (medicine_id, batch_number, expiry_date, quantity, store_id) VALUES ($1, $2, $3, $4, $5)', [med.id, bn, expiryISO, qty, req.storeId]);
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
// SaaS Founder Platform Management (Developer / Superadmin Console)
// Controls all 100+ pharmacy clients (tenants), subscriptions, MRR & kill-switch
// ---------------------------------------------------------------------------

// 1. Founder Platform Summary (MRR, Total Tenants, Active Subscriptions, Expiring Trials)
app.get('/api/founder/stats', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    await ensureSchema();
    const statsQuery = await pool.query(`
      SELECT
        COUNT(*)::int AS total_tenants,
        COUNT(*) FILTER (WHERE status = 'active')::int AS active_tenants,
        COUNT(*) FILTER (WHERE status = 'trial' AND trial_ends_at > now())::int AS trial_tenants,
        COUNT(*) FILTER (WHERE status = 'expired' OR (status = 'trial' AND trial_ends_at <= now()))::int AS expired_tenants,
        COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended_tenants,
        COUNT(*) FILTER (WHERE status = 'trial' AND trial_ends_at BETWEEN now() AND now() + interval '3 days')::int AS expiring_soon_trials,
        COALESCE(SUM(CASE WHEN status = 'active' THEN price_per_month ELSE 0 END), 0)::float8 AS mrr,
        (SELECT COUNT(*)::int FROM sales) AS platform_total_bills,
        (SELECT COUNT(*)::int FROM medicines WHERE active = 1) AS platform_total_medicines
      FROM tenants
    `);

    const row = statsQuery.rows[0];
    const arr = row.mrr * 12;

    res.json({
      totalTenants: row.total_tenants,
      activeTenants: row.active_tenants,
      trialTenants: row.trial_tenants,
      expiredTenants: row.expired_tenants,
      suspendedTenants: row.suspended_tenants,
      expiringSoonTrials: row.expiring_soon_trials,
      mrr: row.mrr,
      arr,
      platformTotalBills: row.platform_total_bills,
      platformTotalMedicines: row.platform_total_medicines,
    });
  } catch (e) { next(e); }
});

// 2. Tenants Directory List with Search & Status Filter
app.get('/api/founder/tenants', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    await ensureSchema();
    const q = String(req.query.q || '').trim();
    const status = String(req.query.status || 'all').trim();
    const like = '%' + q + '%';

    let query = `
      SELECT
        id, store_name, owner_name, phone, email, city, state, license_number,
        plan, status, tier, price_per_month::float8 AS price_per_month,
        trial_ends_at, subscription_ends_at,
        (SELECT COUNT(*) FROM sales s WHERE s.store_id = t.id)::int AS total_bills,
        (SELECT COUNT(*) FROM medicines m WHERE m.store_id = t.id AND m.active = 1)::int AS total_medicines,
        last_active_at, created_at,
        ROUND(EXTRACT(EPOCH FROM (trial_ends_at - now())) / 86400)::int AS trial_days_left,
        ROUND(EXTRACT(EPOCH FROM (subscription_ends_at - now())) / 86400)::int AS sub_days_left
      FROM tenants t
      WHERE (store_name ILIKE $1 OR owner_name ILIKE $1 OR phone ILIKE $1 OR city ILIKE $1)
    `;
    const params = [like];

    if (status === 'active') {
      query += ` AND status = 'active'`;
    } else if (status === 'trial') {
      query += ` AND status = 'trial' AND trial_ends_at > now()`;
    } else if (status === 'expiring') {
      query += ` AND status = 'trial' AND trial_ends_at BETWEEN now() AND now() + interval '3 days'`;
    } else if (status === 'expired') {
      query += ` AND (status = 'expired' OR (status = 'trial' AND trial_ends_at <= now()))`;
    } else if (status === 'suspended') {
      query += ` AND status = 'suspended'`;
    }

    query += ` ORDER BY id DESC LIMIT 200`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (e) { next(e); }
});

// 3. Onboard New Pharmacy Client / Store Provisioning
app.post('/api/founder/tenants', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    await ensureSchema();
    const {
      store_name,
      owner_name,
      phone,
      email,
      city,
      state,
      address,
      license_number,
      plan,
      trial_days,
      tier,
    } = req.body || {};

    if (!store_name?.trim() || !owner_name?.trim() || !phone?.trim()) {
      return bad(res, 400, 'Store name, owner name, and phone number are required');
    }

    const trialDuration = parseInt(trial_days, 10) || 14;
    const assignedPlan = ['monthly', 'yearly', 'lifetime'].includes(plan) ? plan : 'trial';
    const status = assignedPlan === 'trial' ? 'trial' : 'active';
    const perMonth = { monthly: 599.00, yearly: 416.00, lifetime: 277.00 }; // matches BILLING_PLANS
    const planMonths = { monthly: 1, yearly: 12, lifetime: 36 };
    const price = perMonth[assignedPlan] || 599.00;
    // Feature tier: explicit choice wins, otherwise trial/lifetime = Elite.
    const assignedTier = ['starter', 'pro', 'elite'].includes(tier)
      ? tier
      : (assignedPlan === 'trial' || assignedPlan === 'lifetime' ? 'elite' : 'pro');

    const { rows } = await pool.query(
      `INSERT INTO tenants (
        store_name, owner_name, phone, email, city, state, address, license_number,
        plan, status, price_per_month, trial_ends_at, subscription_ends_at, tier
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => $12::int), CASE WHEN $9 = 'trial' THEN NULL ELSE now() + make_interval(months => $13::int) END, $14)
      RETURNING *`,
      [
        String(store_name).trim(),
        String(owner_name).trim(),
        String(phone).trim(),
        String(email || '').trim(),
        String(city || '').trim(),
        String(state || '').trim(),
        String(address || '').trim(),
        String(license_number || '').trim(),
        assignedPlan,
        status,
        price,
        trialDuration,
        planMonths[assignedPlan] || 1,
        assignedTier,
      ]
    );

    const newTenant = rows[0];

    // Create the store's REAL owner login (globally-unique username) plus its
    // settings row, so the customer can sign in to their own isolated store.
    let uname = String(phone).replace(/[^\d]/g, '').slice(-10) || ('store' + newTenant.id);
    const taken = (await pool.query('SELECT id FROM users WHERE username = $1', [uname])).rows[0];
    if (taken) uname = uname + newTenant.id;
    const initialPassword = 'medistock' + String(newTenant.id) + 'ok';
    await addUser(uname, initialPassword, String(owner_name).trim(), 'owner', newTenant.id);
    await pool.query(
      `INSERT INTO settings (id, store_id, store_name, store_address, phone, license_number, gst_enabled, gst_number, currency)
       VALUES ($1, $1, $2, $3, $4, $5, 0, '', '₹')
       ON CONFLICT (id) DO UPDATE SET store_id = $1`,
      [newTenant.id, String(store_name).trim(), String(address || '').trim(), String(phone).trim(), String(license_number || '').trim()]
    );

    // Build ready-to-send WhatsApp onboarding text for the client
    const cleanPhone = String(phone).replace(/[^\d]/g, '');
    const loginUrl = 'https://medistock-pharma.vercel.app';
    const waText = encodeURIComponent(
      `🏥 *Namaste ${owner_name}! Welcome to MediStock Pharmacy Software.*\n\n` +
      `Aapka medical store *${store_name}* setup ho gaya hai!\n\n` +
      `🔗 *Login URL:* ${loginUrl}\n` +
      `👤 *Username:* ${uname}\n` +
      `🔑 *Initial Password:* ${initialPassword}\n` +
      `📅 *Free Trial Validity:* ${trialDuration} Days (Until ${new Date(Date.now() + trialDuration * 86400000).toLocaleDateString('en-IN')})\n\n` +
      `Login ke baad Settings se apna password badal lein. Madad ke liye isi number par WhatsApp karein. Thank you!`
    );

    const waLink = `https://wa.me/91${cleanPhone.slice(-10)}?text=${waText}`;

    res.json({
      tenant: newTenant,
      whatsappLink: waLink,
      initialPassword,
      username: uname,
    });
  } catch (e) { next(e); }
});

// 4. Remote Kill-Switch (Activate / Suspend / Lock Access)
app.put('/api/founder/tenants/:id/status', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const id = asId(req.params.id);
    const { status } = req.body || {};
    const valid = ['active', 'trial', 'expired', 'suspended'];
    if (!valid.includes(status)) return bad(res, 400, 'Invalid status code');

    const { rows } = await pool.query(
      'UPDATE tenants SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    if (!rows[0]) return bad(res, 404, 'Pharmacy tenant not found');
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// 5. Extend Trial Duration (+15 / +30 Days)
app.put('/api/founder/tenants/:id/extend-trial', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const id = asId(req.params.id);
    const days = parseInt(req.body?.days, 10) || 15;

    const { rows } = await pool.query(
      `UPDATE tenants
       SET trial_ends_at = GREATEST(trial_ends_at, now()) + make_interval(days => $1::int),
           status = 'trial'
       WHERE id = $2 RETURNING *`,
      [days, id]
    );
    if (!rows[0]) return bad(res, 404, 'Pharmacy tenant not found');
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// 6. Change Subscription Plan (Trial -> Paid Monthly / Yearly)
app.put('/api/founder/tenants/:id/plan', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const id = asId(req.params.id);
    const { plan, duration_months, tier } = req.body || {};

    // Accept either a full SKU id ("pro-yearly") or a legacy cycle id
    // ("monthly"/"yearly"/"lifetime"/"trial") — tier follows the SKU unless
    // the founder picks one explicitly.
    const sku = resolvePlanId(plan);
    let months;
    let price;
    let assignedTier;
    if (sku) {
      const p = BILLING_PLANS[sku];
      months = parseInt(duration_months, 10) || p.months;
      price = p.price_per_month;
      assignedTier = ['starter', 'pro', 'elite'].includes(tier) ? tier : p.tier;
    } else {
      const valid = ['trial', 'monthly', 'yearly', 'lifetime'];
      if (!valid.includes(plan)) return bad(res, 400, 'Invalid plan type');
      const defaultMonths = { monthly: 1, yearly: 12, lifetime: 36 };
      const perMonth = { monthly: 599.00, yearly: 416.00, lifetime: 277.00 }; // matches Razorpay BILLING_PLANS
      months = parseInt(duration_months, 10) || defaultMonths[plan] || 1;
      price = perMonth[plan] || 599.00;
      assignedTier = ['starter', 'pro', 'elite'].includes(tier)
        ? tier
        : (plan === 'trial' || plan === 'lifetime' ? 'elite' : 'pro');
    }

    const { rows } = await pool.query(
      `UPDATE tenants
       SET plan = $1,
           status = 'active',
           tier = $5,
           price_per_month = $2,
           subscription_ends_at = now() + make_interval(months => $3::int)
       WHERE id = $4 RETURNING *`,
      [sku || plan, price, months, id, assignedTier]
    );
    if (!rows[0]) return bad(res, 404, 'Pharmacy tenant not found');
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// 7. Impersonate Tenant / Remote Access Token
app.post('/api/founder/tenants/:id/impersonate', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const id = asId(req.params.id);
    const tenant = (await pool.query('SELECT * FROM tenants WHERE id = $1', [id])).rows[0];
    if (!tenant) return bad(res, 404, 'Tenant not found');

    // Real impersonation: create a session for THIS store's owner user, so
    // the founder lands inside the customer's actual store view.
    const owner = (await pool.query(
      "SELECT id FROM users WHERE store_id = $1 AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1",
      [id]
    )).rows[0];
    if (!owner) return bad(res, 409, 'This store has no active owner login yet — onboard it first');
    const token = await createSession(owner.id);
    res.json({
      token,
      tenant,
      redirectUrl: 'https://medistock-pharma.vercel.app/#impersonate_token=' + token,
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Razorpay Billing Gateway — customers pay INSIDE the app (no personal UPI,
// so they never suspect a scam). Checkout shows the business name; payment
// success auto-activates the tenant subscription.
// Config: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
// ---------------------------------------------------------------------------
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

let razorpay = null;
function getRazorpay() {
  if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) return null;
  if (!razorpay) {
    const Razorpay = require('razorpay');
    razorpay = new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET });
  }
  return razorpay;
}

// Public plan catalog (used by both the client paywall and the founder panel).
// Plans are <tier>-<cycle>; `tier` decides the feature set, the cycle decides
// the billing duration.
const BILLING_PLANS = {
  'starter-monthly': { tier: 'starter', label: 'Starter — Monthly', amount: 29900, months: 1, price_per_month: 299.0, tagline: 'Billing, stock & expiry alerts' },
  'starter-yearly': { tier: 'starter', label: 'Starter — Yearly', amount: 299900, months: 12, price_per_month: 250.0, tagline: '2 months free vs monthly' },
  'pro-monthly': { tier: 'pro', label: 'Pro — Monthly', amount: 59900, months: 1, price_per_month: 599.0, tagline: 'Khata, WhatsApp bills, full reports' },
  'pro-yearly': { tier: 'pro', label: 'Pro — Yearly (Best Value)', amount: 499900, months: 12, price_per_month: 416.0, tagline: '2 months free + priority support' },
  'elite-monthly': { tier: 'elite', label: 'Elite — Monthly', amount: 99900, months: 1, price_per_month: 999.0, tagline: 'Scanner + WhatsApp daily summary' },
  'elite-yearly': { tier: 'elite', label: 'Elite — Yearly', amount: 799900, months: 12, price_per_month: 666.0, tagline: 'Full power at the best Elite price' },
  'elite-3yr': { tier: 'elite', label: 'Founder Pack — 3 Years', amount: 1499900, months: 36, price_per_month: 416.0, tagline: 'Launch offer: 3 years of Elite (Save ₹9,000)' },
  // Gated QA test SKU: never exposed on public paywall; accessible only by platform admin payment links
  'test-1': { tier: 'starter', label: 'Founder Smoke Test — ₹1', amount: 100, months: 1, price_per_month: 1.0, tagline: 'Internal verification only' },
};
// Legacy plan ids sent by older app builds already in the field map onto the
// closest new SKU so those clients keep renewing correctly.
const PLAN_ALIASES = { monthly: 'pro-monthly', yearly: 'pro-yearly', lifetime: 'elite-3yr', starter: 'starter-monthly' };
function resolvePlanId(raw) {
  const id = String(raw || '').trim();
  return BILLING_PLANS[id] ? id : (PLAN_ALIASES[id] || null);
}

app.get('/api/billing/plans', (req, res) => {
  // Filter out internal test plans from the public customer paywall
  const publicPlans = Object.entries(BILLING_PLANS)
    .filter(([id]) => id !== 'test-1')
    .map(([id, p]) => ({
      id, tier: p.tier, label: p.label, amount: p.amount, months: p.months,
      price_per_month: p.price_per_month, tagline: p.tagline,
    }));
  res.json({
    plans: publicPlans,
    gateway: getRazorpay() ? 'razorpay' : 'not_configured',
    key_id: RAZORPAY_KEY_ID || null,
  });
});

// Payments ledger (one row per Razorpay attempt; updated by verify/webhook)
async function ensureTenantPaymentsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenant_payments (
      id SERIAL PRIMARY KEY,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      plan VARCHAR(50) NOT NULL,
      months INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      currency VARCHAR(10) NOT NULL DEFAULT 'INR',
      razorpay_order_id TEXT,
      razorpay_payment_id TEXT,
      razorpay_signature TEXT,
      status VARCHAR(50) NOT NULL DEFAULT 'created',
      method VARCHAR(50) DEFAULT '',
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Webhook event deduplication ledger
  await pool.query(`
    CREATE TABLE IF NOT EXISTS webhook_events (
      event_id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // DB-level backstop: Prevent duplicate 'paid' records for the same razorpay_payment_id.
  // Note on index creation: Non-concurrent execution during bootstrap/schema
  // ensures table safety while keeping deployment simple.
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_payments_paid_once
      ON tenant_payments(razorpay_payment_id) WHERE status = 'paid'
  `);
}
ensureTenantPaymentsTable().catch(() => {});

/** Mark a tenant paid: extend subscription from today (or from existing expiry
    if still valid, so renewals stack) and flip status to active. `tier` comes
    from the purchased SKU and upgrades/downgrades the store's feature tier. */
async function activateTenantSubscription(tenantId, months, tier, pricePerMonth, dbClient = pool) {
  const { rows } = await dbClient.query(
    `UPDATE tenants t
     SET status = 'active',
         plan = CASE WHEN $2::int >= 36 THEN 'lifetime' WHEN $2::int >= 12 THEN 'yearly' ELSE 'monthly' END,
         tier = COALESCE($4, t.tier),
         price_per_month = $3,
         subscription_ends_at = GREATEST(t.subscription_ends_at, now()) + make_interval(months => $2::int)
     WHERE t.id = $1
     RETURNING *`,
    [tenantId, months, pricePerMonth || 416.0, tier || null]
  );
  return rows[0] || null;
}

/** Shared atomic success handler for verify() and webhook. */
async function handlePaymentSuccess(orderId, paymentId, signature, method, fallbackContext = null) {
  return await transaction(async (client) => {
    let pr = null;

    // 1. Primary Lookup: by razorpay_order_id
    if (orderId) {
      const { rows: pRows } = await client.query(
        'SELECT * FROM tenant_payments WHERE razorpay_order_id = $1 FOR UPDATE',
        [orderId]
      );
      pr = pRows[0];
    }

    // 2. Secondary Lookup: by pre-created payment id (from notes.payment_id)
    if (!pr && fallbackContext?.fallbackPaymentId) {
      const { rows: pRows } = await client.query(
        'SELECT * FROM tenant_payments WHERE id = $1 FOR UPDATE',
        [fallbackContext.fallbackPaymentId]
      );
      pr = pRows[0];
      if (pr && orderId && !pr.razorpay_order_id) {
        await client.query('UPDATE tenant_payments SET razorpay_order_id = $1 WHERE id = $2', [orderId, pr.id]);
      }
    }

    // 3. Fallback Auto-Creation: if no pre-created row exists (e.g. ad-hoc payment links, replayed captures)
    if (!pr && fallbackContext) {
      const { tenantId, planId, amount, months } = fallbackContext;

      // Idempotency: verify if this paymentId was already processed
      const { rows: paidRows } = await client.query(
        'SELECT * FROM tenant_payments WHERE razorpay_payment_id = $1 FOR UPDATE',
        [paymentId]
      );
      if (paidRows.length > 0) {
        return paidRows[0];
      }

      const { rows: newRows } = await client.query(
        `INSERT INTO tenant_payments (tenant_id, plan, months, amount, razorpay_order_id, status)
         VALUES ($1, $2, $3, $4, $5, 'created')
         RETURNING *`,
        [tenantId, planId, months, amount, orderId || paymentId]
      );
      pr = newRows[0];
    }

    if (!pr) throw new Error('Unknown order: ' + (orderId || paymentId));

    // 4. Atomic conditional update: transitions only if status <> 'paid'
    const { rows: uRows } = await client.query(
      `UPDATE tenant_payments
       SET status = 'paid', paid_at = now(), razorpay_payment_id = $1, razorpay_signature = $2, method = $3
       WHERE id = $4 AND status <> 'paid'
       RETURNING id`,
      [paymentId, signature || '', method || '', pr.id]
    );

    // If 0 rows returned, status was already 'paid' (processed by another concurrent worker) -> return early
    if (uRows.length === 0) {
      return pr;
    }

    // 3. Extend subscription (strictly once)
    const purchased = BILLING_PLANS[pr.plan];
    await activateTenantSubscription(pr.tenant_id, pr.months, purchased?.tier, purchased?.price_per_month, client);

    // 4. Referral Commission Auto-Credit (strictly once)
    try {
      const tenant = (await client.query('SELECT store_name, referred_by_tenant_id FROM tenants WHERE id = $1', [pr.tenant_id])).rows[0];
      if (tenant && tenant.referred_by_tenant_id && purchased) {
        // 15% commission of plan amount (e.g. ₹4,999 -> ₹750, ₹14,999 -> ₹2,250)
        const commissionAmount = Math.round((purchased.amount / 100) * 0.15);
        if (commissionAmount > 0) {
          await client.query(
            `INSERT INTO referral_transactions (tenant_id, referred_tenant_id, type, amount, plan_id, plan_amount, status, note)
             VALUES ($1, $2, 'reward_earned', $3, $4, $5, 'completed', $6)`,
            [
              tenant.referred_by_tenant_id,
              pr.tenant_id,
              commissionAmount,
              pr.plan,
              purchased.amount / 100,
              `Commission (15%) for ${tenant.store_name} subscribing to ${purchased.label}`,
            ]
          );
          await client.query(
            `UPDATE tenants
             SET referral_wallet_balance = referral_wallet_balance + $1,
                 referral_total_earned = referral_total_earned + $1
             WHERE id = $2`,
            [commissionAmount, tenant.referred_by_tenant_id]
          );
        }
      }
    } catch (refErr) {
      console.error('Referral credit error:', refErr.message);
    }

    return pr;
  });
}

// Client POS app: create a Razorpay order for its own tenant renewal.
// The client sends its plan choice; amount is enforced server-side so a
// tampered request cannot buy a year for ₹1.
app.post('/api/billing/create-order', requireAuth, async (req, res, next) => {
  try {
    const rp = getRazorpay();
    if (!rp) return bad(res, 503, 'Payment gateway is not configured yet. Please contact support.');

    const planId = resolvePlanId(req.body?.plan) || 'pro-yearly';
    if (planId === 'test-1' && !req.user?.platformAdmin) {
      return bad(res, 403, 'This plan SKU is restricted to internal founder verification.');
    }
    const plan = BILLING_PLANS[planId];
    if (!plan) return bad(res, 400, 'Invalid plan');

    // The logged-in user always belongs to exactly one store.
    const t = (await pool.query('SELECT id, store_name FROM tenants WHERE id = $1', [req.storeId])).rows[0];
    if (!t) return bad(res, 404, 'No store subscription is linked to this account. Ask your MediStock partner to link it.');

    const order = await rp.orders.create({
      amount: plan.amount,
      currency: 'INR',
      receipt: 'T' + t.id + '-' + planId + '-' + Date.now(),
      notes: { tenant_id: String(t.id), plan: planId, store: t.store_name },
    });

    await pool.query(
      `INSERT INTO tenant_payments (tenant_id, plan, months, amount, razorpay_order_id, status)
       VALUES ($1, $2, $3, $4, $5, 'created')`,
      [t.id, planId, plan.months, plan.amount, order.id]
    );

    res.json({
      order_id: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: RAZORPAY_KEY_ID,
      plan: planId,
      months: plan.months,
      store_name: t.store_name,
    });
  } catch (e) { next(e); }
});

// Client POS app: verify checkout signature after payment and activate.
app.post('/api/billing/verify', requireAuth, async (req, res, next) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return bad(res, 400, 'Missing payment confirmation fields');
    }
    const expected = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');
    if (expected !== String(razorpay_signature)) {
      return bad(res, 400, 'Payment signature verification failed');
    }
    const pr = await handlePaymentSuccess(razorpay_order_id, razorpay_payment_id, razorpay_signature, 'checkout');
    const tenant = (await pool.query('SELECT * FROM tenants WHERE id = $1', [pr.tenant_id])).rows[0];
    res.json({ ok: true, tenant });
  } catch (e) { next(e); }
});

// Razorpay server-to-server webhook (signed with RAZORPAY_WEBHOOK_SECRET).
// Backup for the verify call: if the user's browser died mid-checkout, the
// webhook still activates the subscription.
app.post('/api/billing/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res, next) => {
  try {
    if (!RAZORPAY_WEBHOOK_SECRET) return res.status(200).json({ ok: true, skipped: 'webhook secret not set' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body || {}));
    const sig = String(req.headers['x-razorpay-signature'] || '');
    const expected = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex');
    if (sig !== expected) return bad(res, 400, 'Invalid webhook signature');

    const eventId = String(req.headers['x-razorpay-event-id'] || '');
    const event = JSON.parse(raw.toString('utf8'));

    // Webhook event deduplication: return 200 immediately if event was already successfully processed
    if (eventId) {
      const { rows: existingEvt } = await pool.query(
        'SELECT event_id FROM webhook_events WHERE event_id = $1',
        [eventId]
      );
      if (existingEvt.length > 0) {
        return res.status(200).json({ ok: true, deduplicated: true });
      }
    }

    if (event.event === 'payment.captured') {
      const pay = event.payload?.payment?.entity || {};
      const orderId = pay.order_id || null;
      const notes = pay.notes || {};
      const fallbackPaymentId = asId(notes.payment_id);
      const tenantId = asId(notes.tenant_id);
      const planId = resolvePlanId(notes.plan);

      let fallbackContext = null;
      if (tenantId && planId) {
        const plan = BILLING_PLANS[planId];
        if (plan) {
          if (Number(pay.amount) === Number(plan.amount)) {
            fallbackContext = {
              tenantId,
              planId,
              amount: plan.amount,
              months: plan.months,
              fallbackPaymentId,
            };
          } else {
            console.warn('[Webhook Guard] Ignored payment with mismatched amount:', {
              payId: pay.id,
              receivedAmount: pay.amount,
              expectedAmount: plan.amount,
              planId,
            });
          }
        } else {
          console.warn('[Webhook Guard] Ignored payment with invalid plan in notes:', { payId: pay.id, plan: notes.plan });
        }
      } else if (!orderId) {
        console.warn('[Webhook Guard] Ignored payment without order_id and incomplete notes:', {
          payId: pay.id,
          orderId,
          notes,
        });
      }

      if (orderId || fallbackContext) {
        await handlePaymentSuccess(orderId, pay.id, '', pay.method || 'webhook', fallbackContext);
      }
    }

    // Webhook event written strictly AFTER successful processing
    if (eventId) {
      await pool.query(
        'INSERT INTO webhook_events (event_id, event_type, processed_at) VALUES ($1, $2, NOW()) ON CONFLICT (event_id) DO NOTHING',
        [eventId, event.event || 'unknown']
      );
    }

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Founder panel: create a hosted Razorpay Payment Link for a tenant and get a
// ready WhatsApp share text. The customer pays on Razorpay's own page (UPI /
// cards / netbanking) — no personal UPI ID is ever shown.
app.post('/api/founder/tenants/:id/payment-link', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const rp = getRazorpay();
    if (!rp) return bad(res, 503, 'Payment gateway is not configured yet. Add RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET env vars.');

    const id = asId(req.params.id);
    const tenant = (await pool.query('SELECT * FROM tenants WHERE id = $1', [id])).rows[0];
    if (!tenant) return bad(res, 404, 'Tenant not found');

    const planId = resolvePlanId(req.body?.plan);
    const plan = planId ? BILLING_PLANS[planId] : null;
    if (!plan) return bad(res, 400, 'Invalid plan');

    // Pre-create payment row in tenant_payments (status='created')
    const tpRes = await pool.query(
      `INSERT INTO tenant_payments (tenant_id, plan, months, amount, razorpay_order_id, status)
       VALUES ($1, $2, $3, $4, $5, 'created')
       RETURNING id`,
      [tenant.id, planId, plan.months, plan.amount, '']
    );
    const paymentId = tpRes.rows[0].id;

    const link = await rp.paymentLink.create({
      amount: plan.amount,
      currency: 'INR',
      accept_partial: false,
      reference_id: 'TP-' + paymentId + '-' + tenant.id + '-' + Date.now(),
      description: 'MediStock ' + plan.label + ' — ' + tenant.store_name,
      customer: {
        name: tenant.owner_name,
        contact: String(tenant.phone).replace(/[^\d]/g, '').slice(-10),
        email: tenant.email || undefined,
      },
      notify: { sms: false, email: false },
      notes: { tenant_id: String(tenant.id), plan: planId, payment_id: String(paymentId) },
    });

    // Update with Razorpay payment link ID or order ID if returned
    await pool.query(
      'UPDATE tenant_payments SET razorpay_order_id = $1 WHERE id = $2',
      [link.order_id || link.id, paymentId]
    );

    const shortUrl = link.short_url;
    const cleanPhone = String(tenant.phone).replace(/[^\d]/g, '').slice(-10);
    const waText = encodeURIComponent(
      `🏥 *Namaste ${tenant.owner_name} Ji (${tenant.store_name})*\n\n` +
      `Aapka MediStock subscription renew karein — 100% secure payment page:\n` +
      `💳 *${plan.label}* — ₹${(plan.amount / 100).toLocaleString('en-IN')}\n\n` +
      `👇 Yahan se pay karein (UPI / Card / NetBanking):\n${shortUrl}\n\n` +
      `Payment hote hi aapka software turant ${plan.months} mahine ke liye activate ho jayega. Dhanyavaad!`
    );

    res.json({
      payment_link: shortUrl,
      whatsapp_link: `https://wa.me/91${cleanPhone}?text=${waText}`,
      plan: planId,
      amount: plan.amount,
      razorpay_link_id: link.id,
    });
  } catch (e) { next(e); }
});

// Founder panel: recent payments ledger
app.get('/api/founder/payments', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT p.*, t.store_name, t.owner_name, t.phone
       FROM tenant_payments p JOIN tenants t ON t.id = p.tenant_id
       ORDER BY p.id DESC LIMIT 100`
    );
    res.json(rows);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Refer & Earn Ecosystem Endpoints
// ---------------------------------------------------------------------------

// Public check for referral code during signup
app.get('/api/public/referral-check', async (req, res, next) => {
  try {
    await ensureSchema();
    const code = String(req.query.code || '').trim().toUpperCase();
    if (!code) return res.json({ valid: false });
    const row = (await pool.query('SELECT store_name FROM tenants WHERE UPPER(referral_code) = $1', [code])).rows[0];
    if (row) {
      res.json({ valid: true, store_name: row.store_name, bonus_trial_days: 21 });
    } else {
      res.json({ valid: false });
    }
  } catch (e) { next(e); }
});

// Referrer dashboard summary: wallet balance, referred stores list, transactions
app.get('/api/referrals/summary', requireAuth, async (req, res, next) => {
  try {
    const tenant = (await pool.query(
      'SELECT id, store_name, referral_code, referral_wallet_balance::float8 AS wallet_balance, referral_total_earned::float8 AS total_earned FROM tenants WHERE id = $1',
      [req.storeId]
    )).rows[0];
    if (!tenant) return bad(res, 404, 'Tenant not found');

    const referredStores = (await pool.query(
      `SELECT t.id, t.store_name, t.owner_name, t.city, t.status, t.tier, t.plan, t.created_at,
              COALESCE(SUM(rt.amount), 0)::float8 AS total_commission_earned
       FROM tenants t
       LEFT JOIN referral_transactions rt ON rt.referred_tenant_id = t.id AND rt.type = 'reward_earned'
       WHERE t.referred_by_tenant_id = $1
       GROUP BY t.id
       ORDER BY t.id DESC`,
      [tenant.id]
    )).rows;

    const transactions = (await pool.query(
      `SELECT rt.id, rt.type, rt.amount::float8, rt.plan_id, rt.plan_amount::float8, rt.upi_id, rt.status, rt.note, rt.created_at,
              t.store_name AS referred_store_name
       FROM referral_transactions rt
       LEFT JOIN tenants t ON t.id = rt.referred_tenant_id
       WHERE rt.tenant_id = $1
       ORDER BY rt.id DESC LIMIT 50`,
      [tenant.id]
    )).rows;

    const activePaidCount = referredStores.filter(s => s.status === 'active').length;

    res.json({
      referral_code: tenant.referral_code,
      referral_link: `https://medistock-pharma.vercel.app/signup?ref=${tenant.referral_code}`,
      wallet_balance: tenant.wallet_balance || 0,
      total_earned: tenant.total_earned || 0,
      referred_count: referredStores.length,
      paid_count: activePaidCount,
      referred_stores: referredStores,
      transactions,
    });
  } catch (e) { next(e); }
});

// Redeem wallet balance for Free Subscription Days (1 month = ₹250 conversion value, or pro-rated)
app.post('/api/referrals/redeem-extension', requireAuth, async (req, res, next) => {
  try {
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount < 50) {
      return bad(res, 400, 'Minimum redemption is ₹50');
    }

    const tenant = (await pool.query('SELECT id, referral_wallet_balance::float8 AS balance, subscription_ends_at FROM tenants WHERE id = $1', [req.storeId])).rows[0];
    if (!tenant) return bad(res, 404, 'Tenant not found');

    if (tenant.balance < amount) {
      return bad(res, 400, `Insufficient wallet balance (Available: ₹${tenant.balance.toFixed(2)})`);
    }

    // ₹250 = 30 days extension (or ~8.33 rupees per day)
    const daysToAdd = Math.max(1, Math.round((amount / 250) * 30));

    // Deduct wallet balance
    await pool.query('UPDATE tenants SET referral_wallet_balance = referral_wallet_balance - $1 WHERE id = $2', [amount, tenant.id]);

    // Extend subscription and activate
    await pool.query(
      `UPDATE tenants
       SET status = 'active',
           subscription_ends_at = GREATEST(COALESCE(subscription_ends_at, now()), now()) + make_interval(days => $1::int)
       WHERE id = $2`,
      [daysToAdd, tenant.id]
    );

    // Record transaction
    await pool.query(
      `INSERT INTO referral_transactions (tenant_id, type, amount, status, note)
       VALUES ($1, 'redeem_extension', $2, 'completed', $3)`,
      [tenant.id, amount, `Redeemed ₹${amount} for ${daysToAdd} days free subscription extension`]
    );

    res.json({ ok: true, days_added: daysToAdd, redeemed_amount: amount });
  } catch (e) { next(e); }
});

// Request UPI Cash Payout
app.post('/api/referrals/request-payout', requireAuth, async (req, res, next) => {
  try {
    const amount = Number(req.body?.amount);
    const upiId = String(req.body?.upi_id || '').trim();

    if (!upiId || !upiId.includes('@')) {
      return bad(res, 400, 'Please enter a valid UPI ID (e.g. mobile@upi or name@okaxis)');
    }
    if (!Number.isFinite(amount) || amount < 100) {
      return bad(res, 400, 'Minimum UPI payout amount is ₹100');
    }

    const tenant = (await pool.query('SELECT id, store_name, referral_wallet_balance::float8 AS balance FROM tenants WHERE id = $1', [req.storeId])).rows[0];
    if (!tenant) return bad(res, 404, 'Tenant not found');

    if (tenant.balance < amount) {
      return bad(res, 400, `Insufficient wallet balance (Available: ₹${tenant.balance.toFixed(2)})`);
    }

    // Deduct balance
    await pool.query('UPDATE tenants SET referral_wallet_balance = referral_wallet_balance - $1 WHERE id = $2', [amount, tenant.id]);

    // Create pending payout transaction
    const { rows } = await pool.query(
      `INSERT INTO referral_transactions (tenant_id, type, amount, upi_id, status, note)
       VALUES ($1, 'payout_upi', $2, $3, 'pending', $4)
       RETURNING id`,
      [tenant.id, amount, upiId, `Payout request of ₹${amount} to ${upiId} (${tenant.store_name})`]
    );

    res.json({
      ok: true,
      transaction_id: rows[0].id,
      message: `Payout request of ₹${amount} submitted! It will be transferred to ${upiId} within 24 hours.`,
    });
  } catch (e) { next(e); }
});

// Founder panel: list all referral activities & pending payout requests
app.get('/api/founder/referrals', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const transactions = (await pool.query(
      `SELECT rt.*, t.store_name, t.owner_name, t.phone, ref_t.store_name AS referred_store_name
       FROM referral_transactions rt
       JOIN tenants t ON t.id = rt.tenant_id
       LEFT JOIN tenants ref_t ON ref_t.id = rt.referred_tenant_id
       ORDER BY rt.id DESC LIMIT 100`
    )).rows;

    const pendingPayouts = (await pool.query(
      `SELECT rt.*, t.store_name, t.owner_name, t.phone
       FROM referral_transactions rt
       JOIN tenants t ON t.id = rt.tenant_id
       WHERE rt.type = 'payout_upi' AND rt.status = 'pending'
       ORDER BY rt.id ASC`
    )).rows;

    const topReferrers = (await pool.query(
      `SELECT t.id, t.store_name, t.owner_name, t.phone, t.referral_code, t.referral_wallet_balance::float8 AS wallet_balance,
              t.referral_total_earned::float8 AS total_earned,
              COUNT(ref_t.id)::int AS total_invited,
              COUNT(ref_t.id) FILTER (WHERE ref_t.status = 'active')::int AS paid_stores
       FROM tenants t
       LEFT JOIN tenants ref_t ON ref_t.referred_by_tenant_id = t.id
       GROUP BY t.id
       HAVING COUNT(ref_t.id) > 0 OR t.referral_total_earned > 0
       ORDER BY total_earned DESC, total_invited DESC LIMIT 20`
    )).rows;

    res.json({ transactions, pendingPayouts, topReferrers });
  } catch (e) { next(e); }
});

// Founder panel: approve or reject a UPI payout request
app.post('/api/founder/referrals/payouts/:id/action', requireAuth, requirePlatformAdmin, async (req, res, next) => {
  try {
    const id = asId(req.params.id);
    const { action, utr_number, reason } = req.body || {};
    const tx = (await pool.query('SELECT * FROM referral_transactions WHERE id = $1 AND type = \'payout_upi\'', [id])).rows[0];
    if (!tx) return bad(res, 404, 'Payout transaction not found');
    if (tx.status !== 'pending') return bad(res, 400, 'This payout is already ' + tx.status);

    if (action === 'approve') {
      const note = utr_number ? `Paid via UPI. UTR: ${String(utr_number).trim()}` : 'Paid via UPI by Admin';
      await pool.query('UPDATE referral_transactions SET status = \'completed\', note = $1 WHERE id = $2', [note, id]);
      res.json({ ok: true, status: 'completed' });
    } else if (action === 'reject') {
      // Refund balance back to tenant
      await pool.query('UPDATE tenants SET referral_wallet_balance = referral_wallet_balance + $1 WHERE id = $2', [tx.amount, tx.tenant_id]);
      const note = reason ? `Rejected: ${String(reason).trim()}` : 'Rejected by admin (refunded to wallet)';
      await pool.query('UPDATE referral_transactions SET status = \'rejected\', note = $1 WHERE id = $2', [note, id]);
      res.json({ ok: true, status: 'rejected' });
    } else {
      bad(res, 400, 'Invalid action (must be approve or reject)');
    }
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------------------
// Error handling — with synchronous Sentry.flush() for serverless execution
// ---------------------------------------------------------------------------
app.use(async (err, req, res, next) => {
  console.error('[Unhandled Server Error]', err);
  if (Sentry && process.env.SENTRY_DSN) {
    try {
      Sentry.withScope((scope) => {
        scope.setTag('store_id', req.storeId ? String(req.storeId) : 'unauthenticated');
        scope.setTag('path', req.path || 'unknown');
        scope.setTag('method', req.method || 'unknown');
        if (req.tier) scope.setTag('tier', req.tier);
        if (req.user?.role) scope.setTag('role', req.user.role);
        if (req.user) scope.setUser({ id: String(req.user.id), username: req.user.username });
        Sentry.captureException(err);
      });
      // CRITICAL FOR SERVERLESS: Flush event buffer before res.json() terminates lambda container
      await Sentry.flush(2500);
    } catch (sentryErr) {
      console.error('[Sentry Flush Error]', sentryErr.message);
    }
  }
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Server error: ' + err.message });
});

module.exports = app;

