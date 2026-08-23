# 💊 MediStock — Pharmacy Billing & Inventory Management

A complete pharmacy management system with **automatic stock tracking**, **FEFO billing** (sell soonest-expiry first), **batch & expiry management**, **low-stock alerts**, and **professional billing**. Built with React + Material UI and Node.js + PostgreSQL. Runs locally with one command, and deploys to **Vercel + Supabase** for free cloud hosting.

![MediStock Dashboard](gui-test-screenshots/t2_dashboard.png)

---

## 🚀 Quick Start (local)

### Prerequisites
- **Node.js 22+**
- A **PostgreSQL** database — either one running locally, or a free cloud
  database from [Supabase](https://supabase.com) (see Deployment below)

### First-Time Setup
```bash
git clone https://github.com/MD-NAVED/medistock.git
cd medistock

# Install dependencies (also builds the client)
npm run setup

# Point the server at your database and start it
DATABASE_URL=postgres://user:password@localhost:5432/medistock npm start
```

If your local Postgres doesn't have the schema yet, create the `medistock`
database and run `scripts/init-supabase.sql` in it (psql, pgAdmin, or any SQL
client). The script creates all 13 tables, the demo accounts and a demo
catalog with opening stock.

Then open **http://localhost:3001** in your browser.

> No `DATABASE_URL`? The server defaults to
> `postgres://postgres:postgres@localhost:5432/medistock`.

### Demo Logins
| Role    | Username | Password  |
|---------|----------|-----------|
| 👑 Owner  | `owner`  | `owner123` |
| 🧑‍💼 Staff  | `staff`  | `staff123` |

**Owner** can do everything: manage medicines, users, settings, billing, purchases, reverse purchases, remove medicines.
**Staff** can do billing, purchases, returns and write-offs but cannot change settings, prices or users.

> Change both demo passwords before using this in a real shop — Settings → Security → Change my password.

### Running the tests

One command spins up a throwaway embedded PostgreSQL, loads the schema, starts
the server and runs every suite (it cleans up after itself):

```bash
npm test
```

**102 checks in total — all currently passing** (56 core API, 23 purchase
editing, 19+4 audit including the session-survives-restart proof). To run the
suites by hand against an already-running server:

```bash
node server/test-api.js
node server/test-edit-purchase.js
AUDIT_MODE=phase1 node server/test-audit.js
# restart the server, then:
AUDIT_MODE=phase2 RESTART_TOKEN=<token> node server/test-audit.js
```

---

## ☁️ Deployment — Vercel + Supabase (free tier)

The app is serverless-ready: the Express API becomes a Vercel function
(`api/index.js`), the React client becomes static files, and the database is
Supabase PostgreSQL. No idle spin-down, HTTPS everywhere.

### 1. Create the database (Supabase)
1. Sign up at [supabase.com](https://supabase.com) → **New project** (free tier
   is fine). Pick a region near you and set a database password.
2. Open **SQL Editor** → paste the whole of `scripts/init-supabase.sql` → **Run**.
   This creates every table plus the demo accounts and catalog.
3. Go to **Project Settings → Database → Connection string → URI** and copy the
   **Connection pooling / Transaction mode** URI (port `6543`). It looks like:
   `postgres://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`
   > Use the **pooler** URI, not the direct one — serverless functions open
   > many short-lived connections and the pooler is built for exactly that.

### 2. Deploy the app (Vercel)
1. Push this repo to GitHub.
2. In Vercel: **Add New → Project** → import the repo. The `vercel.json` at the
   root already configures the API function and the client build — no other
   settings needed.
3. In the project's **Settings → Environment Variables** add:
   - `DATABASE_URL` = the pooler URI from step 1
   - `DATABASE_POOL_MAX` = `3` (keeps each function instance light on the free
     connection limit)
4. **Deploy.** Log in with the demo accounts, then **immediately change both
   passwords**.

### 3. Optional — strict TLS verification
Traffic to Supabase is always TLS-encrypted. By default the app does not verify
Supabase's certificate chain (same as `sslmode=require`, Supabase's own
serverless default). To enable full verification:
download `prod-ca-2021.crt` from **Supabase → Settings → Database → SSL
configuration**, and set `DATABASE_SSL_CA` to the certificate's PEM content
(one env var, paste the whole file including `BEGIN CERTIFICATE` lines).

### Backups
Backups are managed by the database provider — from the Supabase dashboard you
can export any table as CSV, or restore to a daily snapshot on paid plans. The
old in-app backup buttons are gone because serverless has no local disk.

---

## 📋 Features

### 🏠 Dashboard
- Today's sales, profit, bills count at a glance
- Sales chart — last 7 days
- Top sellers ranking
- Alert summaries (low stock + expiring medicines)
- **WhatsApp Summary button** — one tap builds today's hisaab (sale, profit, purchases,
  low stock, expiry, khata baiki, month-to-date) and opens WhatsApp with the message
  ready to send. No WhatsApp API account needed, zero per-message cost

### 🧾 Billing (New Sale)
- Search medicines by name or company — fast autocomplete
- Add multiple items to cart, adjust quantities
- **Automatic FEFO**: sells the soonest-expiring batch first (no manual batch selection)
- **Automatic stock deduction**: stock updates the instant a bill is saved
- **Print bill**: professional printed invoice with store details, GST, line items
- GST toggleable per store (in Settings)
- **Udhaar (credit) from the bill itself**: tick "Udhaar — baaki rakha", enter how much is
  pending (defaults to the full total, part-payment works too) and the amount lands in the
  customer's khata automatically, linked to the bill number

### 📒 Khata — Udhaar Book
The shop's credit notebook, moved into the app:
- Customer-wise pending balance (**baiki**), total credit ever given, entry count, last activity
- Three entry kinds: **Udhaar Diya** (credit given), **Payment Aaya** (money received),
  **Maaf Kiya** (discount/waiver)
- Full per-customer ledger with dates, notes, linked bill numbers and which staff member made
  the entry — so udhaar can't quietly disappear
- One-tap "Payment Aaya" pre-fills the exact pending amount
- The **WhatsApp Summary** includes total khata baiki, so pending credit reaches the owner's
  pocket every evening along with sales and stock alerts

### ↩️ Corrections — cancel a bill or take items back
Every bill in **Reports** opens a detail view with the two corrections a counter actually needs.

- **Cancel bill** — the whole bill is voided. Every unit not already returned goes back into
  *the exact batch it was sold from*, so expiry tracking stays correct. A reason is required, and
  the bill stops counting in revenue and profit.
- **Return items** — the customer brings back part of the order. Enter the quantity per line
  (capped at what is still unreturned) and the refund is calculated with GST.
- **Restock checkbox** — untick it when the returned strip cannot be resold: the customer is
  refunded but the stock is *not* added back.
- **Reprint** — reprints any past bill. A duplicate is marked `— DUPLICATE COPY —`, and a
  cancelled bill prints with a red **CANCELLED** stamp so it can never pass as a valid receipt.
- Every correction is written to a **correction history** on the bill: who did it, when, why,
  and which batches were touched.

### 💊 Medicines Catalog
- Every medicine tracked as **Name + Company** combination
- **Batch view** per medicine: every batch, its expiry, days left, quantity and stock value,
  colour-coded from green (safe) to red (expired)
- **Write off expired or damaged stock** — removes units from a batch with a reason
  (expired / damaged / lost / other) and an optional note, records the rupee loss, and keeps a
  permanent write-off history. This is how expired stock finally leaves inventory.
- **Remove a medicine** from the catalog (owner only). Past bills keep it; adding the same
  name + company later restores the entry. Removing something that still has stock requires a
  second confirmation.
- Low-stock threshold per medicine, search & filter, add / edit (owner only)

### 📥 Purchases (Stock In)
- Manual entry with batch number, expiry date, buy price per item
- **Automatic stock increase** — existing batches get quantity added, new batches are created
- **Purchase detail view** showing every line of a supplier invoice
- **Edit a purchase** (owner only) — fix a wrong quantity, buy price, supplier name or swap
  the batch entirely. Stock reconciles itself to match the edit: reducing a line pulls units
  out, adding puts them in. If a reduction would take a batch below what has already been
  sold, the whole edit is refused with the exact remaining count — nothing is half-applied.
- **Reverse a purchase** (owner only) for an invoice entered twice or by mistake — it pulls the
  same units back out of stock. If any of that stock has already been sold, the reversal is
  refused with an exact count rather than pushing a batch negative.
- Full purchase history with supplier tracking
- *(📷 Camera invoice scanning planned for future update)*

### ⚠️ Alerts
- **Low stock**: medicines below their alert threshold
- **Expiry watch**: batches expiring within 90 days
- Color-coded urgency (red = expired/critical, orange = warning, green = safe)

### 📊 Reports
- Date-range filtering (last 30 days default)
- **Net** revenue, profit, bills and units — cancelled bills contribute nothing and partially
  returned lines only count the units the customer kept
- A **corrections & losses** panel: cancelled bills, refunds paid, and expired/damaged stock
  written off with the rupee loss
- Best sellers ranking with profit per item
- Bill list with status badges (Active / Part returned / Cancelled) — tap any bill to open it

### ⚙️ Settings (Owner Only)
- **Store** — name, address, phone, drug license number, GST enable/disable + GSTIN
- **Users** — add staff/owner accounts, activate/deactivate, reset a forgotten password
- **Security** — change your own password and see how the install is protected; database
  backups are handled by the database provider (Supabase), not from this page


---

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| 🎨 UI | React 18 + Material UI 6 + MUI X (DataGrid, Charts) |
| ⚙️ Server | Node.js + Express (exported as a Vercel serverless function) |
| 🗄️ Database | PostgreSQL via `node-postgres` (pg), transactions for every stock change |
| 🔐 Auth | scrypt password hashing + database-backed sessions |
| 📦 Build | Vite |
| ☁️ Hosting | Vercel (functions + static) with Supabase PostgreSQL |

---

## 🔐 Security & Data Safety

**What is already in place**

- **Passwords** are hashed with **scrypt** (salted, 16384 rounds) — never stored readably.
  Accounts created under the earlier SHA-256 scheme are re-hashed automatically on their next
  successful login, so no account stays on the weak algorithm.
- **Sessions live in the database**, not server memory. Restarting the server (or a cold
  serverless function) does not sign anyone out. Sessions expire after 30 days.
- **Login rate limiting** — 8 wrong passwords for one username locks that username for 15
  minutes. The lock is per-username, so one person guessing cannot block everyone else.
- **Session revocation** — deactivating a user, changing a password, or an owner resetting a
  password immediately invalidates that user's other sessions.
- **TLS to the database** on remote hosts (encrypted always; full chain verification available
  via `DATABASE_SSL_CA` — see Deployment). Localhost connections stay plain.
- **Hardening headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and
  HSTS when served over HTTPS.
- **Every stock change is transactional** — a cancel, return, write-off or reversal either
  completes fully or rolls back. Batch quantities can never go negative.

**Running securely — do this before charging other stores**

1. **Change the demo passwords** (`owner123` / `staff123`) immediately.
2. **Keep your Supabase account safe** — anyone with the dashboard login can reach the
   database directly. Turn on 2FA in Supabase.
3. Deployed on Vercel, HTTPS is automatic. For self-hosting, put nginx, Caddy, or a cloud
   load balancer in front of the app — passwords and session tokens should never travel in
   plain HTTP.
4. Take an occasional export (CSV from the Supabase dashboard) as an off-site copy.

---

## 📁 Project Structure

```
medistock/
├── api/
│   └── index.js          # Vercel serverless entry — re-exports the Express app
├── server/
│   ├── index.js          # Express app + all API routes (module, no listener)
│   ├── dev.js            # Local dev listener (npm start)
│   ├── db.js             # pg Pool, transactions, scrypt password hashing
│   ├── test-api.js            # End-to-end API test suite (56 checks)
│   ├── test-edit-purchase.js  # Purchase-editing suite (23 checks)
│   └── test-audit.js          # Coverage-gap + session-restart audit (19+4 checks)
├── client/
│   ├── src/
│   │   ├── App.jsx       # Main app with routes
│   │   ├── api.js        # API helper (fetch wrapper + session handling)
│   │   ├── auth.jsx      # Auth context & route protection
│   │   ├── theme.js      # Material UI theme (teal pharmacy theme)
│   │   ├── utils.js      # Formatting helpers
│   │   ├── printInvoice.js    # Bill printing (originals, duplicates, cancelled stamp)
│   │   ├── components/
│   │   │   ├── BillDetailDialog.jsx  # Bill view + cancel + return + reprint
│   │   │   └── BatchDialog.jsx       # Batch list + expiry write-off
│   │   ├── layout/
│   │   │   └── AppLayout.jsx  # Sidebar navigation + top bar
│   │   └── pages/
│   │       ├── Login.jsx      # Login page
│   │       ├── Dashboard.jsx # Dashboard with charts
│   │       ├── Billing.jsx    # POS / billing screen
│   │       ├── Medicines.jsx  # Medicine catalog (table on desktop, cards on mobile)
│   │       ├── Purchases.jsx  # Purchase entry + detail + reverse
│   │       ├── Alerts.jsx     # Low stock + expiry alerts
│   │       ├── Reports.jsx    # Sales reports + bill corrections
│   │       └── Settings.jsx   # Store, users, security
│   ├── index.html
│   └── vite.config.js
├── scripts/
│   ├── init-supabase.sql # Full schema + demo seed — run in Supabase SQL Editor
│   └── local-test.js     # npm test — embedded Postgres + all suites
├── vercel.json           # Vercel build & routing config
├── package.json
└── README.md
```

---

## 📱 Mobile / Install as an App

Medicines, Purchases and the billing cart switch from tables to stacked cards below 900px, so a
phone never needs sideways scrolling. Purchase entry and bill correction dialogs open full-screen
on mobile.

The app is also a **PWA** — on Android, open it in Chrome and tap **⋮ → Install app** (or the
"Install" banner) to get it on your home screen with its own icon, launching full-screen like a
native app. On iPhone, use Safari → Share → **Add to Home Screen**. Updates arrive automatically
on the next launch. `scripts/gen-icons.js` regenerates the app icons if you ever want to change
the look.

---

## 🧠 How It Works

### The Stock Flow
```
Purchase (Stock IN)  → Batch created/updated → Stock increases
Billing (Stock OUT)  → FEFO picks batch      → Stock decreases → Profit → Bill printed

Corrections, all batch-accurate:
Cancel bill    → every unreturned unit goes back to its original batch
Return items   → the returned units go back to their original batch
Write off      → expired/damaged units leave the batch, loss recorded
Reverse buy    → purchased units come back out of the batch (blocked if already sold)
Edit purchase  → stock reconciles to match the edit (refused if it would undercut sold stock)
```

### FEFO (First Expiry, First Out)
When a customer buys medicine X:
1. The system finds ALL batches of medicine X with available stock
2. It sorts them by expiry date (soonest first)
3. It deducts from the soonest-expiring batch
4. If that batch runs out, it moves to the next batch
5. **No manual batch selection needed** — it's fully automatic

### Batch Management
- Each purchase entry requires: medicine, batch number, expiry date, quantity, buy price
- If you enter the same batch number again, quantity is added to the existing batch
- New batch numbers create separate stock entries with their own expiry tracking
- Every sale line remembers which batch it came from, which is what makes returns and
  cancellations put stock back in the right place instead of guessing

### Why reports show "net" figures
A cancelled bill and a returned strip are not sales. Reports therefore count
`quantity − returned_qty` for every line and skip cancelled bills entirely, so revenue and profit
reflect what the shop actually kept. Cancellations, refunds and written-off stock are reported
separately so nothing is hidden — you can see both the clean number and what went wrong.

---

## 🔜 Future Updates (Roadmap)

- 📷 **Camera invoice scanning** — point camera at supplier bill, auto-fill purchase
- 🏷️ **Barcode scanning** — scan medicine barcode at billing
- 💳 **Subscription management** — plans by store size
- 📱 **Mobile app** — for storekeepers on the go
- 🧾 **GST e-invoice** — auto-generated tax invoices
- 📲 **WhatsApp alerts** — expiry & low-stock reminders

---

## 📄 License

Private project — not for redistribution without permission.
