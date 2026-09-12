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

