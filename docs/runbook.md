# MediStock Production Operations & Incident Runbook

This runbook provides actionable, click-level troubleshooting and recovery procedures for production operational issues in MediStock.

---

## 1. Incident Diagnosis Matrix

| Symptom | Primary Root Cause | Diagnostic Tool | Immediate Fix |
|---------|-------------------|-----------------|---------------|
| **POS Billing Slow / Timeouts** | Database connection saturation or high query latency | Check `/api/health` response and Supabase dashboard connections | Verify Supavisor pooler (port 6543) is active; check `db.latency_ms`. |
| **Subscription Didn't Activate After Payment** | Webhook delivery failure or signature mismatch | Check `tenant_payments` and `webhook_events` tables | Inspect Razorpay Dashboard $\rightarrow$ Webhooks $\rightarrow$ Replay event; verify `RAZORPAY_WEBHOOK_SECRET`. |
| **Chemist Account Locked (429)** | 8+ failed password attempts triggered brute-force lock | Query `SELECT * FROM login_attempts WHERE username = '...'` | Wait for 15-min lockout window or reset password via Founder Superadmin console. |
| **Chemist Reports Rate Limit (429)** | Upstash Redis threshold hit | Check `Retry-After` header and Vercel serverless logs | Inspect `store_id` request volume; check if client is in an automated loop. |
| **Database Outage / Data Corruption** | Cloud host failover or data incident | Sentry alerts / Supabase status | Follow `docs/restore.md` to restore the latest nightly backup dump. |

---

## 2. Load Testing & Connection Budget Notes

- **Supavisor Multiplexing Validation:** The 50-VU sustained load test validated that active backend PostgreSQL connections remain strictly controlled ($\le 4$ active connections) even during traffic spikes.
- **Edge Concurrency Limitations:** Running 50 parallel virtual users from a single client machine against Vercel's Hobby tier causes client-side edge throttling (drops/timeouts). Full capacity benchmarking is performed after upgrading to Vercel Pro with distributed multi-region load runners.
- **External Monitoring Calibration:** Synthetic monitoring services (e.g. UptimeRobot, BetterUptime) must be configured with a **5.0-second timeout** to avoid false alarms during cross-continent serverless cold starts.
