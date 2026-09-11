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
   - If webhook was not delivered, go to **Razorpay Dashboard $\rightarrow$ Webhooks $\rightarrow$ View Deliveries** and click **Resend / Replay**.
   - Or manually activate the store via Founder Superadmin console at `https://medistock-admin.vercel.app/tenants`.

---

### Incident E: Database Recovery & Disaster Recovery
- If the primary database is lost or compromised, follow the recovery procedure in [`docs/restore.md`](restore.md).
