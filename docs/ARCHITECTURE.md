# MediStock Production Architecture & Hardening Guide

## 1. Executive Summary & Stack Overview

MediStock is a high-availability, multi-tenant pharmacy Point-of-Sale (POS) and inventory management SaaS platform designed for retail pharmacies.

* **API Runtime**: Node.js + Express hosted on Vercel Serverless (`medistock-api.vercel.app`).
* **Database Driver**: `pg` (`node-postgres` v8.12.0) utilizing parameterized SQL (`$1, $2, ...`) and explicit transaction lifecycle blocks (`BEGIN / COMMIT / ROLLBACK`).
* **Database Layer**: PostgreSQL on Supabase.
* **Frontend**: React (Vite, Material-UI) deployed on Vercel (`medistock-pharma.vercel.app`) and packaged natively for Android via Capacitor.
* **Payment Gateway**: Razorpay Live Checkout and Server-to-Server Webhook (`payment.captured`).

---

## 2. Database Connection Architecture: Supavisor Pooling vs Direct Connection

### The Serverless Scaling Challenge
In a serverless environment (such as Vercel), each incoming concurrent request can spawn an isolated warm execution instance. If each serverless instance opens a traditional connection pool with default settings (`max: 10`), a traffic spike across 20+ instances rapidly exhausts PostgreSQL's native connection pool limit (`max_connections = 60–100`), resulting in severe `500 connection refused` errors during peak counter hours.

### The Two-Tier Connection Strategy

```text
┌────────────────────────────────────────────────────────┐
│               Vercel Serverless Instances              │
│       Instance 1         Instance 2        Instance N  │
│      (Pool max: 1)      (Pool max: 1)    (Pool max: 1) │
└─────────────┬──────────────────┬─────────────────┬─────┘
              │                  │                 │
              ▼                  ▼                 ▼
  ┌──────────────────────────────────────────────────────┐
  │     Supavisor Pooler (Port 6543, Transaction Mode)   │
  │     - Pins connections only for active query/tx      │
  │     - Scales to 10,000+ client connections           │
  └──────────────────────────┬───────────────────────────┘
                             │ (Maintains ≤ 8-15 active connections)
                             ▼
  ┌──────────────────────────────────────────────────────┐
  │           Supabase PostgreSQL Core Engine            │
  │   - Primary Storage                                  │
  │   - IST Normalized Day Bounds                        │
  └──────────────────────────▲───────────────────────────┘
                             │
                             │ (Direct Port 5432 - Single admin connection)
  ┌──────────────────────────┴───────────────────────────┐
  │     Migrations, DDL, Schema Seed & EXPLAIN ANALYZE   │
  └──────────────────────────────────────────────────────┘
```

#### 1. Runtime Pooler (`DATABASE_URL` via Port 6543)
* **Mode**: Transaction-mode Supavisor connection pooling.
* **Configuration**:
  ```javascript
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL, // port 6543
    max: 1,                                      // 1 connection per serverless instance
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
  });
  ```
* **Why `max: 1`?** In serverless execution, an instance handles one request at a time. A pool size of 1 completely eliminates connection bloat while Supavisor efficiently multiplexes thousands of incoming queries into a minimal pool of active database connections.
* **Compatibility**: PostgreSQL transactions (`BEGIN ... COMMIT`) are pinned to a single backend connection for the duration of the transaction block by Supavisor, ensuring atomic rollbacks and serializable consistency.

#### 2. Direct Connection (`DATABASE_DIRECT_URL` via Port 5432)
* **Purpose**: Used strictly for DDL migrations, schema seeding (`init-supabase.sql`), diagnostic audits, and `EXPLAIN ANALYZE` profiling.
* **Why direct?** Certain maintenance operations (like `LISTEN/NOTIFY`, session-level locks, or specific migration runners) require direct session control and should bypass intermediate transaction poolers.

---

## 3. Invoice Share Security Architecture

* Shareable WhatsApp invoice links (`/api/public/invoice/:id/pdf?t=...`) use a cryptographically pinned HMAC-SHA256 token.
* Token generation is pinned to `process.env.INVOICE_SHARE_SECRET` rather than derived from `DATABASE_URL`. This guarantees that rotating database credentials or migrating connection pooler ports never invalidates existing customer invoice links.
* Missing `INVOICE_SHARE_SECRET` triggers a fail-closed startup crash.

---

## 4. Health Check Specification (`GET /api/health`)

The health endpoint provides real-time latency and database connectivity metrics:

### Request
```http
GET /api/health HTTP/1.1
Host: medistock-api.vercel.app
```

### Successful Response (`200 OK`)
```json
{
  "status": "ok",
  "db": {
    "connected": true,
    "latency_ms": 14
  },
  "uptime_seconds": 3420,
  "version": "1.0.0"
}
```

### Degraded Response (`503 Service Unavailable`)
```json
{
  "status": "error",
  "db": {
    "connected": false,
    "latency_ms": 1002,
    "error": "Database ping timeout (1s exceeded)"
  },
  "uptime_seconds": 3420,
  "version": "1.0.0"
}
```

---

## 5. Security & Isolation Invariants

1. **IST Day Normalization**: Every date-based query uses PostgreSQL `(created_at AT TIME ZONE 'Asia/Kolkata')::date` to ensure 00:00–05:30 IST transactions align with local counter dates.
2. **Tenant Isolation**: Every business entity query enforces `store_id = $N` scoping.
3. **FEFO Inventory Allocation**: POS checkouts allocate stock from the nearest-expiry active batch first.
