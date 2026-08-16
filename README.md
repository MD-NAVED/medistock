# 💊 MediStock — Pharmacy Billing & Inventory Management

A complete pharmacy management system with **automatic stock tracking**, **FEFO billing** (sell soonest-expiry first), **batch & expiry management**, **low-stock alerts**, and **professional billing**. Built with React + Material UI and Node.js + SQLite.

![MediStock Dashboard](gui-test-screenshots/t2_dashboard.png)

---

## 🚀 Quick Start

### Prerequisites
- **Node.js 22+** (v24 recommended — includes built-in SQLite)

### First-Time Setup
```bash
git clone https://github.com/MD-NAVED/medistock.git
cd medistock

# Install dependencies (also builds the client)
npm run setup

# Start the app
npm start
```

Then open **http://localhost:3001** in your browser.

### Demo Logins
| Role    | Username | Password  |
|---------|----------|-----------|
| 👑 Owner  | `owner`  | `owner123` |
| 🧑‍💼 Staff  | `staff`  | `staff123` |

**Owner** can do everything: manage medicines, users, settings, billing, purchases, reverse purchases, remove medicines.
**Staff** can do billing, purchases, returns and write-offs but cannot change settings, prices or users.

> Change both demo passwords before using this in a real shop — Settings → Security → Change my password.

### Running the tests
```bash
npm start                                            # in one terminal
node server/test-api.js                              # 59 checks — core suite
node server/test-edit-purchase.js                    # 23 checks — purchase editing
AUDIT_MODE=phase1 node server/test-audit.js          # 19 checks + prints a session token
```

The audit's second phase proves DB-backed sessions survive a server restart — stop the
server (Ctrl+C), start it again, then run with the token phase 1 printed:

```bash
AUDIT_MODE=phase2 RESTART_TOKEN=<token> node server/test-audit.js    # 4 checks
```

**105 checks in total — all currently passing.**

---

## 📋 Features

### 🏠 Dashboard
- Today's sales, profit, bills count at a glance
- Sales chart — last 7 days
- Top sellers ranking
- Alert summaries (low stock + expiring medicines)

### 🧾 Billing (New Sale)
- Search medicines by name or company — fast autocomplete
- Add multiple items to cart, adjust quantities
- **Automatic FEFO**: sells the soonest-expiring batch first (no manual batch selection)
- **Automatic stock deduction**: stock updates the instant a bill is saved
- **Print bill**: professional printed invoice with store details, GST, line items
- GST toggleable per store (in Settings)

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
- **Security** — change your own password, run a manual database backup, review recent backups,
  and see exactly how the install is protected


---

## 🏗️ Tech Stack

| Layer | Technology |
|-------|-----------|
| 🎨 UI | React 18 + Material UI 6 + MUI X (DataGrid, Charts) |
| ⚙️ Server | Node.js + Express |
| 🗄️ Database | SQLite (Node.js built-in — zero installation) |
| 🔐 Auth | scrypt password hashing + database-backed sessions |
| 📦 Build | Vite |

---

## 🔐 Security & Data Safety

**What is already in place**

- **Passwords** are hashed with **scrypt** (salted, 16384 rounds) — never stored readably.
  Accounts created under the earlier SHA-256 scheme are re-hashed automatically on their next
  successful login, so no account stays on the weak algorithm.
- **Sessions live in the database**, not server memory. Restarting the server no longer signs
  everyone out. Sessions expire after 30 days and are cleaned up hourly.
- **Login rate limiting** — 8 wrong passwords for one username locks that username for 15
  minutes. The lock is per-username, so one person guessing cannot block everyone else.
- **Session revocation** — deactivating a user, changing a password, or an owner resetting a
  password immediately invalidates that user's other sessions.
- **Automatic backups** — a consistent copy of the database (via SQLite `VACUUM INTO`, safe while
  the server is running) is written on startup and every 6 hours into `server/data/backups`.
  The 30 most recent copies are kept. Owners can also back up on demand from Settings → Security.
- **Hardening headers** — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and
  HSTS when served over HTTPS.
- **Every stock change is transactional** — a cancel, return, write-off or reversal either
  completes fully or rolls back. Batch quantities can never go negative.

**Running securely — do this before charging other stores**

1. **Serve over HTTPS.** The app does not terminate TLS itself. Put nginx, Caddy, or a cloud
   load balancer in front of it and forward to port 3001. Passwords and session tokens travel in
   plain HTTP otherwise.
2. **Keep backups off the machine.** A backup sitting on the same disk does not survive a disk
   failure or theft. Copy `server/data/backups` to a pen drive, another computer, or cloud
   storage on a schedule.
3. **Change the demo passwords** (`owner123` / `staff123`) immediately.
4. **Restrict who can reach the port.** On a shop LAN, bind the server to the local network and
   do not expose port 3001 to the internet directly.

---

## 📁 Project Structure

```
medistock/
├── server/
│   ├── index.js          # Express server + all API routes
│   ├── db.js             # SQLite schema, migrations, seed data, password hashing
│   ├── backup.js         # Automatic + manual database backups
│   ├── test-api.js            # End-to-end API test suite (59 checks)
│   ├── test-edit-purchase.js  # Purchase-editing suite (23 checks)
│   ├── test-audit.js          # Coverage-gap + session-restart audit (19+4 checks)
│   └── data/
│       ├── medistock.db  # Auto-created SQLite database
│       └── backups/      # Rolling database backups (30 kept)
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
├── package.json
└── README.md
```

---

## 📱 Mobile

Medicines, Purchases and the billing cart switch from tables to stacked cards below 900px, so a
phone never needs sideways scrolling. Purchase entry and bill correction dialogs open full-screen
on mobile.

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
- ☁️ **Cloud hosting** — multi-store, access from anywhere
- 💳 **Subscription management** — plans by store size
- 📱 **Mobile app** — for storekeepers on the go
- 🧾 **GST e-invoice** — auto-generated tax invoices
- 📲 **WhatsApp alerts** — expiry & low-stock reminders

---

## 📄 License

Private project — not for redistribution without permission.
