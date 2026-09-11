# PostgreSQL Query Execution Plans & Performance Baseline

Generated at: 2026-09-11T09:06:21.741Z

### 1. Session Token Auth Lookup (Every Request)
```sql
SELECT s.token, u.id, u.username, u.name, u.role, u.active, u.store_id, u.platform_admin, t.status AS tenant_status, t.tier AS tenant_tier, t.trial_ends_at, t.subscription_ends_at FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN tenants t ON t.id = u.store_id WHERE s.token = 'dummy_token' AND s.expires_at > now()
```

**Plan:**
```text
Nested Loop Left Join  (cost=0.28..4.34 rows=1 width=774) (actual time=0.020..0.021 rows=0 loops=1)
  ->  Nested Loop  (cost=0.14..4.14 rows=1 width=747) (actual time=0.019..0.020 rows=0 loops=1)
        ->  Seq Scan on sessions s  (cost=0.00..1.74 rows=1 width=69) (actual time=0.019..0.019 rows=0 loops=1)
              Filter: ((token = 'dummy_token'::text) AND (expires_at > now()))
              Rows Removed by Filter: 42
        ->  Index Scan using users_pkey on users u  (cost=0.14..2.36 rows=1 width=682) (never executed)
              Index Cond: (id = s.user_id)
  ->  Index Scan using tenants_pkey on tenants t  (cost=0.14..0.19 rows=1 width=31) (never executed)
        Index Cond: (id = u.store_id)
Planning Time: 9.378 ms
Execution Time: 0.066 ms
```

---

### 2. Dashboard Sales & Revenue Aggregation (Today IST)
```sql
SELECT COUNT(DISTINCT s.id)::int AS bills, COALESCE(SUM((si.quantity - si.returned_qty) * si.unit_price * (1 + COALESCE(si.gst_rate,0)/100.0)), 0)::float8 AS revenue FROM sales s LEFT JOIN sale_items si ON si.sale_id = s.id WHERE s.store_id = 16 AND (s.created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date AND s.status != 'cancelled'
```

**Plan:**
```text
Aggregate  (cost=6.26..6.27 rows=1 width=12) (actual time=0.026..0.028 rows=1 loops=1)
  ->  Sort  (cost=5.02..5.16 rows=55 width=40) (actual time=0.020..0.021 rows=0 loops=1)
        Sort Key: s.id
        Sort Method: quicksort  Memory: 25kB
        ->  Nested Loop Left Join  (cost=0.14..3.43 rows=55 width=40) (actual time=0.016..0.016 rows=0 loops=1)
              ->  Seq Scan on sales s  (cost=0.00..1.06 rows=1 width=4) (actual time=0.015..0.016 rows=0 loops=1)
                    Filter: (((status)::text <> 'cancelled'::text) AND (store_id = 16) AND (((created_at AT TIME ZONE 'Asia/Kolkata'::text))::date = ((now() AT TIME ZONE 'Asia/Kolkata'::text))::date))
                    Rows Removed by Filter: 2
              ->  Index Scan using idx_sale_items_sale on sale_items si  (cost=0.14..2.36 rows=1 width=40) (never executed)
                    Index Cond: (sale_id = s.id)
Planning Time: 12.651 ms
Execution Time: 0.082 ms
```

---

### 3. Expiry Alerts Report (Batches expiring in 90 days)
```sql
SELECT b.id, b.batch_number, b.expiry_date, b.quantity, m.name, m.company, m.shelf FROM batches b JOIN medicines m ON m.id = b.medicine_id WHERE m.store_id = 16 AND b.quantity > 0 AND b.expiry_date <= (now() AT TIME ZONE 'Asia/Kolkata')::date + 90 ORDER BY b.expiry_date ASC
```

**Plan:**
```text
Sort  (cost=3.75..3.75 rows=1 width=43) (actual time=0.687..0.688 rows=0 loops=1)
  Sort Key: b.expiry_date
  Sort Method: quicksort  Memory: 25kB
  ->  Nested Loop  (cost=0.00..3.74 rows=1 width=43) (actual time=0.683..0.683 rows=0 loops=1)
        Join Filter: (b.medicine_id = m.id)
        ->  Seq Scan on medicines m  (cost=0.00..2.23 rows=1 width=29) (actual time=0.682..0.682 rows=0 loops=1)
              Filter: (store_id = 16)
              Rows Removed by Filter: 19
        ->  Seq Scan on batches b  (cost=0.00..1.48 rows=3 width=22) (never executed)
              Filter: ((quantity > 0) AND (expiry_date <= (((now() AT TIME ZONE 'Asia/Kolkata'::text))::date + 90)))
Planning Time: 10.226 ms
Execution Time: 0.729 ms
```

---

### 4. Khata Customer Balances
```sql
SELECT c.id, c.name, c.phone, COALESCE(SUM(CASE l.kind WHEN 'credit' THEN l.amount ELSE -l.amount END), 0)::float8 AS balance FROM customers c LEFT JOIN customer_ledger l ON l.customer_id = c.id WHERE c.store_id = 16 GROUP BY c.id ORDER BY c.name ASC
```

**Plan:**
```text
Sort  (cost=27.12..27.13 rows=3 width=102) (actual time=1.232..1.235 rows=0 loops=1)
  Sort Key: c.name
  Sort Method: quicksort  Memory: 25kB
  ->  GroupAggregate  (cost=27.01..27.10 rows=3 width=102) (actual time=1.227..1.230 rows=0 loops=1)
        Group Key: c.id
        ->  Sort  (cost=27.01..27.02 rows=3 width=168) (actual time=1.226..1.228 rows=0 loops=1)
              Sort Key: c.id
              Sort Method: quicksort  Memory: 25kB
              ->  Nested Loop Left Join  (cost=0.15..26.99 rows=3 width=168) (actual time=1.222..1.224 rows=0 loops=1)
                    ->  Seq Scan on customers c  (cost=0.00..17.50 rows=3 width=94) (actual time=1.221..1.222 rows=0 loops=1)
                          Filter: (store_id = 16)
                    ->  Index Scan using idx_customer_ledger_customer_created on customer_ledger l  (cost=0.15..3.13 rows=3 width=78) (never executed)
                          Index Cond: (customer_id = c.id)
Planning Time: 3.919 ms
Execution Time: 1.289 ms
```

---

### 5. Sales History with Date Filter (Last 30 Days)
```sql
SELECT s.id, s.invoice_number, s.customer_name, s.subtotal, s.gst_amount, s.total, s.created_at, s.status, u.name AS served_by FROM sales s JOIN users u ON u.id = s.user_id WHERE s.store_id = 16 AND (s.created_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN '2026-08-01' AND '2026-09-11' ORDER BY s.id DESC LIMIT 100
```

**Plan:**
```text
Limit  (cost=3.47..3.48 rows=1 width=758) (actual time=0.017..0.018 rows=0 loops=1)
  ->  Sort  (cost=3.47..3.48 rows=1 width=758) (actual time=0.016..0.016 rows=0 loops=1)
        Sort Key: s.id DESC
        Sort Method: quicksort  Memory: 25kB
        ->  Nested Loop  (cost=0.14..3.46 rows=1 width=758) (actual time=0.012..0.012 rows=0 loops=1)
              ->  Seq Scan on sales s  (cost=0.00..1.05 rows=1 width=730) (actual time=0.012..0.012 rows=0 loops=1)
                    Filter: ((store_id = 16) AND (((created_at AT TIME ZONE 'Asia/Kolkata'::text))::date >= '2026-08-01'::date) AND (((created_at AT TIME ZONE 'Asia/Kolkata'::text))::date <= '2026-09-11'::date))
                    Rows Removed by Filter: 2
              ->  Index Scan using users_pkey on users u  (cost=0.14..2.36 rows=1 width=36) (never executed)
                    Index Cond: (id = s.user_id)
Planning Time: 0.189 ms
Execution Time: 0.051 ms
```

---

