# MediStock Production Operations & Incident Runbook

This runbook provides actionable, click-level troubleshooting and recovery procedures for production operational issues in MediStock.

---

## 1. Incident Diagnosis Matrix

| Symptom | Primary Root Cause | Diagnostic Tool | Immediate Fix |
|---------|-------------------|-----------------|---------------|
| **POS Billing Slow / Timeouts** | Database connection saturation or high query latency | Check `/api/health` response and Supabase dashboard connections | Verify Supavisor pooler (port 6543) is active; check `db.latency_ms`. |
| **Subscription Didn't Activate After Payment** | Webhook delivery failure or signature mismatch | Check `tenant_payments` and `webhook_events` tables | Inspect Razorpay Dashboard $\rightarrow$ Webhooks $\rightarrow$ Replay event; verify `RAZORPAY_WEBHOOK_SECRET`. |
| **Account Locked (Brute-Force Defense)** | 8+ failed password attempts triggered PostgreSQL account lock | Query `SELECT * FROM login_attempts WHERE username = '...'` | Wait for 15-min lockout window or reset password via Founder Superadmin console. |
| **API Rate Limited (Upstash Distributed 429)** | Exceeded endpoint rate limit (e.g. 120 req/min billing or 10 req/5min login per IP) | Check `Retry-After` header and Vercel serverless logs | Inspect `store_id` / client IP request volume; wait for `Retry-After` seconds. |
| **Database Outage / Data Corruption** | Cloud host failover or data incident | Sentry alerts / Supabase status | Follow `docs/restore.md` to restore the latest nightly backup dump. |

## 3. Standing Deploy Checklist (Billing & Gateway Changes)

Whenever any code change touches billing, subscriptions, payment signatures, or webhooks:
1. **Pre-Deploy Webhook Check**: Verify the Razorpay webhook endpoint `https://medistock-api.vercel.app/api/billing/webhook` is active with event `payment.captured` and matching `RAZORPAY_WEBHOOK_SECRET`.
2. **Execute ₹1 End-to-End Smoke Test**:
   - Create a test order and complete a real UPI checkout (₹1).
   - Verify the Razorpay `pay_XXXX` ID appears in the Razorpay Dashboard.
   - Verify `SELECT * FROM tenant_payments WHERE razorpay_payment_id = 'pay_XXXX'` has `status = 'paid'`.
   - Verify `SELECT * FROM webhook_events` contains 1 matching `event_id` from the gateway.
   - Verify `tenants.subscription_ends_at` is extended exactly once.
3. **Re-Gate Test Plans**: Ensure public `/api/billing/plans` exposes only valid commercial SKUs.

### Incident A: Account Locked via Brute-Force Defense (PostgreSQL `login_attempts`)
1. **Diagnosis**:
   ```sql
   SELECT id, username, ip, success, created_at
   FROM login_attempts
   WHERE username = 'target_username'
   ORDER BY id DESC LIMIT 10;
   ```
2. **Behavior**:
   - 8 failed login attempts within 15 minutes trigger a 15-minute lock on that specific username.
3. **Remediation**:
   - Resets automatically after 15 minutes.
   - For immediate unlock: `DELETE FROM login_attempts WHERE username = 'target_username';` or reset password via Founder Superadmin console.

---

### Incident B: Request Rejected via Upstash Rate Limiter (HTTP 429)
1. **Diagnosis**:
   - Response status is `HTTP 429 Too Many Requests` with header `Retry-After: <seconds>` and JSON body `{"code": "rate_limited"}`.
2. **Limits**:
   - `POST /api/auth/login`: 10 requests / 5 min per client IP.
   - `POST /api/sales`: 120 requests / 1 min per store.
   - `POST /api/import/commit`: 3 requests / 10 min per store.
   - `GET /api/public/invoice/:id/pdf`: 30 requests / 1 min per IP.
3. **Remediation**:
   - Inspect client application to ensure it is not in an automated retry loop. Client waits for `Retry-After` window.

---

### Incident C: Connection Queuing & Latency Trade-off Note
- **Trade-off Design**: `connectionTimeoutMillis` is set to **15,000ms (15s)** in `server/db.js`.
- Under extreme concurrent burst conditions (50+ simultaneous serverless containers spin-up), requests queue rather than instantly failing with 500 errors.
- **Worst-Case Behavior**: A POS counter request may experience up to a 10–15s response latency during massive cold-start bursts instead of failing.
- **Planned Frontend Mitigation**: Implement client-side exponential backoff retry for network fetch timeouts.

---

### Incident D: Payment Completed in Razorpay but Store Is Still Locked
1. **Check Payment Record**:
   ```sql
   SELECT id, tenant_id, plan, amount, razorpay_order_id, razorpay_payment_id, status, paid_at
   FROM tenant_payments
   WHERE razorpay_order_id = 'order_XYZ' OR tenant_id = <TENANT_ID>
   ORDER BY id DESC;
   ```
2. **If status is `created` (unprocessed)**:
   - Check `webhook_events` table:
     ```sql
     SELECT * FROM webhook_events ORDER BY processed_at DESC LIMIT 20;
     ```
   - **Razorpay Limitation Note**: Razorpay doesn't retain webhook bodies (the UI displays `null` for request body/response) and marks `200 OK` deliveries as complete with no manual "Resend" button (auto-retry only triggers on non-200 responses). Capture payloads in your own logging if you need replay capability.
   - If a webhook failed with 5xx/4xx, Razorpay's exponential auto-retry will retry automatically over 24 hours.
   - To immediately activate a store without waiting: use the Founder Superadmin console at `https://medistock-admin.vercel.app/tenants` or run an administrative SQL update.

---

### Incident E: Database Recovery & Disaster Recovery
- If the primary database is lost or compromised, follow the recovery procedure in [`docs/restore.md`](restore.md).

---

## 4. Scheduled Maintenance & Operational Procedures

### A. Schema Initialization & Memoization Guarantee
- `ensureSchema()` is memoized via `schemaReadyPromise`.
- On container boot, the bootstrap runs once; all subsequent requests reuse the resolved promise in 0ms without re-querying schema DDL.
- If a database connection error occurs during boot, `catch` resets `schemaReadyPromise = null` so the subsequent request safely retries.

### B. Quarterly Credential & Secret Rotation Procedure
1. **Razorpay Webhook Secret**:
   - In Razorpay Dashboard $\rightarrow$ Developers $\rightarrow$ Webhooks $\rightarrow$ Edit $\rightarrow$ Regenerate Secret.
   - Immediately update `RAZORPAY_WEBHOOK_SECRET` in Vercel `medistock-api` (Production + Preview).
2. **PostgreSQL Database Password**:
   - In Supabase Dashboard $\rightarrow$ Settings $\rightarrow$ Database $\rightarrow$ Reset database password.
   - Update `DATABASE_URL` (port 6543) and `DATABASE_DIRECT_URL` (port 5432) in Vercel `medistock-api`.
   - Update `SUPABASE_DB_URL` in GitHub Repository Secrets.
3. **Post-Rotation Verification Checklist**:
   - `curl -i https://medistock-api.vercel.app/api/health` $\rightarrow$ `connected: true`.
   - Verify existing WhatsApp invoice link loads `200 OK` (unaffected because `INVOICE_SHARE_SECRET` is pinned).
   - Execute ₹1 live UPI smoke test to verify new webhook secret end-to-end.
   - Trigger manual GitHub Actions backup run to verify database dump succeeds.

### C. Automated Nightly Backups & Disaster Recovery Verification
- **First Successful Backup**: 2026-09-12 (Workflow Run #2 verified, 22s execution, 1 artifact produced).
- **Schedule**: Every day at 02:00 AM IST (`30 20 * * *` UTC).
- **Retention**: 30 days stored in GitHub Actions encrypted artifact repository.
- **Recovery Targets**: Recovery Time Objective (RTO) < 30 minutes, Recovery Point Objective (RPO) $\le$ 24 hours. Refer to [`docs/restore.md`](restore.md) for full disaster recovery instructions.

### D. Manual Reconciliation Procedure (Payment-Link Desync)
When a customer pays via an ad-hoc Razorpay Payment Link or if a webhook arrived before the dual-match handler was deployed:
1. **Verify Payment on Gateway**:
   - Confirm in Razorpay Dashboard $\rightarrow$ Payments that the payment is `Captured` with valid `pay_XXXX`, `order_XXXX`, and amount matching the intended plan.
2. **Execute Atomic Reconciliation Query**:
   ```sql
   BEGIN;
   INSERT INTO tenant_payments (
     tenant_id, plan, months, amount, currency,
     razorpay_order_id, razorpay_payment_id, razorpay_signature,
     status, method, paid_at, created_at
   ) VALUES (
     <TENANT_ID>, '<PLAN_ID>', <MONTHS>, <AMOUNT_PAISE>, 'INR',
     '<ORDER_ID>', '<PAYMENT_ID>',
     'manual-reconciliation: payment-link flow paid before webhook dual-match fix was deployed',
     'paid', '<METHOD>', '<CAPTURED_AT>', NOW()
   );

   UPDATE tenants
   SET
     plan = '<PLAN_BASE>',
     tier = '<TIER>',
     status = 'active',
     price_per_month = <PRICE>,
     subscription_ends_at = GREATEST(subscription_ends_at, NOW()) + INTERVAL '<MONTHS> month'
   WHERE id = <TENANT_ID>;
   COMMIT;
   ```
3. **Audit Trail Guarantee**:
   - The row is distinctly marked with `razorpay_signature` carrying the `manual-reconciliation` prefix.
   - The event ID is recorded in `webhook_events` to protect against subsequent duplicate processing.
4. **Post-Reconciliation Verification**:
   - Verify founder payments ledger: `GET /api/founder/payments` shows the payment as `paid`.
   - Verify POS app `/subscription` shows the updated plan and extended expiry.
   - *Gateway Limitation Note*: Razorpay dashboard does NOT retain webhook bodies (displays `null` for body/response) and marks `200 OK` deliveries as permanent with no manual resend button. Always capture raw webhook payloads in your own application logging if offline replay capability is required.

### E. Mobile Android APK Rebuild & Distribution Procedure
Whenever a client-side fix (UI, service worker, caching, Sentry) requires a new APK release:
1. **Prepare Client Assets & Environment**:
   - Ensure `client/.env.production` has `VITE_API_URL` and `VITE_SENTRY_DSN` configured.
   - Run relative-base Capacitor build:
     ```bash
     cd client
     node -e "process.env.CAPACITOR_BUILD='true'; require('child_process').execSync('npx vite build', { stdio: 'inherit' });"
     ```
2. **Verify Critical PWA Assets in `dist/`**:
   - Confirm `client/dist/sw.js` excludes API routes: `url.pathname.startsWith('/api/')` and increments cache version (`medistock-shell-v3`).
   - Confirm `client/dist/assets/*.js` contains Sentry ingest configuration.
3. **Bump Version in `client/android/app/build.gradle`**:
   - Increment `versionCode` (e.g., `13` $\rightarrow$ `14`).
   - Increment `versionName` (e.g., `"1.3.8"` $\rightarrow$ `"1.3.9"`).
4. **Sync Web Assets to Capacitor Native Android**:
   ```bash
   cd client
   npx cap sync android
   ```
5. **Compile Release APK**:
   ```bash
   cd client/android
   ./gradlew assembleRelease
   ```
   *(On Windows PowerShell: `.\gradlew.bat assembleRelease`)*
6. **Package Distribution Artifact**:
   - Output binary is generated at:
     `client/android/app/build/outputs/apk/release/app-release.apk` (~3.6MB).
   - Copy to distribution location (root `./MediStock.apk`):
     ```bash
     cp client/android/app/build/outputs/apk/release/app-release.apk ./MediStock.apk
     ```
   - **CRITICAL**: Never place the output APK inside `client/public/`. Vite copies `client/public/` into `client/dist/`, which Capacitor then bundles into Android assets, causing recursive APK bloat.
7. **Sideload & Verify**:
   - Install over existing build on Android device.
   - Verify Subscription page reflects current store plan (`Starter`).
   - Verify no service worker TypeErrors in DevTools console (`chrome://inspect`).

### F. AI Camera & PDF Invoice Scanner (Beta) Architecture & Operational Guardrails

#### 1. Architecture & Multi-Source Ingestion
- **Input Channels**:
  1. **Direct Camera Capture**: `<input accept="image/*" capture="environment">` invokes device camera directly.
  2. **Gallery & PDF Files Picker**: `<input accept="image/*,.pdf,application/pdf">` (without `capture`) opens native media gallery and file system document picker for WhatsApp-received distributor invoices.
- **Engines**:
  - **OCR Engine**: Client-side optical character recognition via `tesseract.js` v5 WebAssembly (WASM).
  - **PDF Engine**: Client-side PDF rendering via Mozilla `pdfjs-dist` (pinned version `4.10.38`).
- **Supported Formats**: Standard machine-printed wholesale distributor invoices with tabular layouts (Item name, Batch, Expiry, Qty, Rate).
- **Unsupported Formats**: Handwritten bills, doctor prescriptions, and scribbled slips are NOT supported by the regex-based line parser.

#### 2. Mozilla PDF.js Worker Version Pinning
- **Worker CDN Pinning**: In `pdfProcessor.js`, the worker URL is pinned to the exact version string matching `client/package.json`:
  `https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs`
- **Rationale**: Floating versions (e.g., `^4.10.38`) could resolve incompatible worker code if jsDelivr serves an updated minor/patch with breaking API shifts, causing widespread scanner failures across chemist devices simultaneously.

#### 3. Budget Phone Memory Management & Multi-Page Guardrails
- **Sequential Processing & Disposal**: Multi-page PDFs are processed strictly one page at a time. The system renders Page $i$ to an off-screen `<canvas>` at 1.5x–2.0x scale (capped at 1600px width), runs OCR, and immediately invokes `page.cleanup()` while zeroing canvas dimensions (`canvas.width = 0; canvas.height = 0`). This ensures zero memory accumulation across pages on 2GB–4GB RAM phones.
- **10-Page Ingestion Limit**: Invoices exceeding 10 pages are rejected upfront (`Invoice too long (maximum 10 pages) — please split or contact support`) to prevent mobile browser memory exhaustion.
- **Gallery/Camera Compression**: High-resolution camera and gallery photos pass through canvas-based `compressImage()` downsampling (1280px max width at 0.8 JPEG quality, ~250KB–350KB payload) with EXIF orientation normalization.

#### 4. CDN Dependencies & Offline Failure Modes
- `tesseract.js` loads `tesseract-core.wasm` and `eng.traineddata.gz` from jsDelivr CDN.
- `pdfjs-dist` loads `pdf.worker.min.mjs` and CMaps from jsDelivr CDN.
- **Failure Mode**: On high-latency 2G/3G mobile networks or blocked CDNs, worker initialization will timeout or fail.
- **Behavior**: The exception is caught cleanly in `handleScanInvoice()`, file inputs are reset, and an actionable snackbar advises the user to proceed with manual entry without breaking POS stability.

#### 5. Password-Protected & Encrypted PDF Handling
- When encrypted distributor PDFs are uploaded, `pdfjs-dist` triggers `onPassword` or throws `PasswordException`.
- The exception is mapped to a chemist-friendly error message: *"Ye PDF password-protected hai — unlock karke try karo"* instead of a cryptic JavaScript stack trace.

#### 6. Strict Data Integrity (No Silent Defaults)
- **Elimination of Fallbacks**: The parser never injects default placeholder data. Unrecognized fields (`medicine_id`, `batch_number`, `expiry_date`, `quantity`, `buy_price`) remain blank (`''`).
- **Visual Verification**: All blank or malformed lines are highlighted with red validation borders (`error` state) and require user confirmation before `Save & Update Stock` is enabled.
- **Candidate Fuzzy Matching**: Medicine name matches with confidence between 25% and 59% display top-3 clickable candidate chips for chemist selection instead of silently picking an arbitrary catalog item.

##### 7. Duplicate Invoice & Stock-Doubling Defense
- **Store-Scoped Unique Index**: `idx_purchases_store_invoice ON purchases (store_id, invoice_number)`.
- **Conflict Handling**: Repeatedly scanning or saving the same invoice number triggers a PostgreSQL `23505` unique violation.
- **API Contract**: The backend traps this violation and responds with `HTTP 409 Conflict`, code `INVOICE_EXISTS`, and the `existing_purchase_id`.
- **Reconciliation Flow**: The UI displays a warning dialog ("Invoice Already Exists") with an option to **Update Existing Purchase** (`PUT /api/purchases/:id`). Updating recalculates net stock deltas rather than blindly doubling quantities.

#### 8. Invoice Scanner AI (Gemini Vision)
- **Architecture**: Client uploads base64 image -> `POST /api/purchases/scan-invoice` -> Google Gemini 1.5 Flash Vision REST API -> JSON payload -> Client-side mapping -> Review UI.
- **Cost & Rate Limits**: Uses Gemini Free Tier (15 RPM / 1500 RPD). Monitored via Google AI Studio. Endpoint guarded by `aiScannerLimiter` (3 scans / min per store).
- **Fallback Logic**: If Gemini returns 502/503 (timeout, quota, malformed JSON, network), the client automatically falls back to local Tesseract OCR on-device.

---

### G. Excel / CSV Medicine Catalog Import Operations (Scale-Hardened)

The Excel/CSV Import Wizard (`Settings` $\rightarrow$ `Import Data`) allows chemists to bulk-migrate their medicine inventory from legacy software (Marg ERP, TradeEasy, Busy, or custom Excel sheets) up to 5,000 items in a single file.

#### 1. Architecture & Execution Strategy
- **Batch Processing**: Medicines and batches are upserted using PostgreSQL `UNNEST` in multi-row batches of 500 rows per query inside a single atomic transaction.
- **Transaction Safety**: All-or-nothing transaction semantics (`Sab hua ya kuch nahi`). Any unexpected database failure rolls back the entire batch to prevent partial state corruption.
- **Scale Benchmarks**: Tested and verified on live Supabase WAN across 3,300 rows in **1.834s** (well under the 8.0s / 10.0s Vercel serverless ceiling).
- **Error Handling & Reporting**: Invalid or unparseable rows do not crash the batch. They are collected and made available as a downloadable CSV error report directly from the preview UI (`Download error report (CSV)`).

#### 2. Batch Quantity Upsert Semantics & Trade-Off Warning
> ⚠️ **CRITICAL BATCH QUANTITY SEMANTICS WARNING**:
> Import uses **REPLACE** semantics for batch quantities (`quantity = EXCLUDED.quantity`). If the same batch number was supplied across multiple invoices, add quantities before importing, or review carefully. A future version will offer ADD mode.
>
> **Trade-Off Context**:
> - **REPLACE Semantics (Current)**: Guarantees idempotency when re-importing the same catalog file after fixing errors or re-syncing from Marg. Re-importing does not inflate or double stock counts.
> - **Multi-Invoice Risk**: If a pharmacy received the same manufacturing batch across two separate distributor invoices and both appear in the imported file without being pre-summed, the later row's quantity will overwrite the earlier row. Chemists should pre-aggregate quantities for duplicate batch numbers before upload.

---

### H. Product & Architecture Backlog (Prioritized)

#### P1 High Priority
- **AI Scanner Telemetry**: Sentry latency/failure baseline logging confirmation for Gemini endpoint.
- **Offline Sync Queue**: Background IndexedDB sync for sales billing during spotty connectivity.

#### P2 Medium Priority
- **Import Quantity Mode Selector (Replace vs Add)**:
  - Add UI toggle in Import Wizard Step 2/3: *"Batch Quantity Mode: [Replace Existing (Default) | Add to Existing]"*.
  - When in ADD mode: `quantity = batches.quantity + EXCLUDED.quantity`.
  - Trigger when real pharmacy users in the field report multiple invoices with shared batch numbers.
- **Read-Only Database User for Agent Operations**:
  - Configure a dedicated PostgreSQL role with `SELECT`-only privileges for agent telemetry, log inspection, and troubleshooting queries.
  - Production writes/mutations must require explicit elevated credentials and peer-reviewed code.

---

### I. Database Script Safety Rules & Operational Guardrails

To prevent unintended cross-tenant modifications or data corruption during operational maintenance, all scripts and agents MUST adhere to these strict rules:

1. **Mandatory Explicit `WHERE` Clauses**:
   - Every `UPDATE` and `DELETE` SQL statement executed in any operational or migration script MUST include an explicit, parameterized `WHERE` clause targeting exact tenant or entity IDs (e.g. `WHERE id = $1`).
   - Unbounded queries without a `WHERE` clause are strictly prohibited.

2. **Production Data Access Protocol**:
   - Production database mutations are allowed ONLY through:
     - **Option (i)**: Formally reviewed, CI-tested, and merged GitHub Pull Requests containing idempotent migrations.
     - **Option (ii)**: Manual execution by the owner directly in the Supabase SQL Editor.
   - Ad-hoc CLI scripts or unreviewed automation scripts must NEVER write directly to production.

3. **Pre-Commit Row Count Assertion**:
   - Any script performing administrative updates must execute inside an explicit PostgreSQL transaction (`BEGIN ... COMMIT`).
   - The script must check and print the affected `rowCount` **BEFORE** committing. If `rowCount !== expectedCount`, the script must execute `ROLLBACK` and immediately terminate with an error.