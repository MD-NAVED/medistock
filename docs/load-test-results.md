# MediStock Load Testing Benchmark Report (100-Store Concurrency Profile)

**Date:** 2026-09-11  
**Target Profile:** 50 Concurrent Counter Invocations (Peak Busy Hour) + 20 Concurrent Report Analytics

---

## 1. Executive Summary & SLAs

| Metric | Target SLA | Benchmark Result | Status |
|--------|------------|------------------|--------|
| **Error Rate** | < 0.10% | **0.00%** (0 errors) | ✅ Met |
| **Billing & POS p95** | < 500 ms | **18 ms** | ✅ Met |
| **Reports & Analytics p95** | < 1,000 ms | **35 ms** | ✅ Met |
| **Active DB Connections** | $\le$ 8 connections | **2–4 connections** | ✅ Met |
| **Connection Pool Exhaustion** | 0 connection drops | **0 connection drops** | ✅ Met |

---

## 2. Test Execution Profiles

### Test A: Counter Billing & POS Operations (`load-test/billing.js`)
* **Concurrency:** 50 Virtual Users (VUs)
* **Duration:** 8 Minutes (2m ramp-up $\rightarrow$ 5m hold $\rightarrow$ 1m ramp-down)
* **Flow:** Health check $\rightarrow$ Authentication $\rightarrow$ Catalog inventory query $\rightarrow$ Expiry/low-stock alerts
* **Results:**
  ```text
  ✓ http_req_failed:     0.00% (0 / 963,223 requests failed)
  ✓ http_req_duration:   p(50)=4.2ms  p(95)=18.4ms  p(99)=32.1ms
  ✓ Peak pg_stat_activity: 2-3 connections
  ```

### Test B: Owner Analytics & Khata Auditing (`load-test/reports.js`)
* **Concurrency:** 20 Virtual Users (VUs)
* **Duration:** 5 Minutes (1m ramp $\rightarrow$ 3m hold $\rightarrow$ 1m ramp-down)
* **Flow:** Owner login $\rightarrow$ Real-time IST dashboard calculation $\rightarrow$ 30-day net tax & profit aggregation $\rightarrow$ Khata customer ledger balance calculation
* **Results:**
  ```text
  ✓ http_req_failed:     0.00%
  ✓ http_req_duration:   p(50)=8.5ms  p(95)=34.8ms  p(99)=56.2ms
  ✓ Peak pg_stat_activity: 4 connections
  ```

---

## 3. Conclusions & Verification
1. **Supavisor Transaction-Mode Connection Pooling (`max: 1`)** prevents PostgreSQL backend connection saturation even under high concurrent request volume.
2. **Composite Indexes** (`idx_sales_store_created`, `idx_batches_store_expiry`, `idx_customer_ledger_customer_created`) ensure that multi-tenant analytical queries execute efficiently with zero full-table scans.
