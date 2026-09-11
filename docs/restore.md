# MediStock Disaster Recovery & Database Restoration Guide

**Target Recovery Time Objective (RTO):** < 30 Minutes  
**Target Recovery Point Objective (RPO):** < 24 Hours (Nightly Automated Dump)

---

## 1. Prerequisites
- A target Supabase PostgreSQL project URI (e.g. `postgresql://postgres:<password>@db.<new-ref>.supabase.co:5432/postgres`).
- PostgreSQL client utilities installed (`pg_restore`, `psql`, `gzip`).
- The latest encrypted backup artifact downloaded from GitHub Actions (`medistock_backup_YYYYMMDD_HHMMSSZ.sql.gz`).

---

## 2. Restoration Procedure

### Step 1: Decompress the Backup Archive
```bash
gunzip -k medistock_backup_20260911_203000Z.sql.gz
# Yields: medistock_backup_20260911_203000Z.sql
```

### Step 2: Restore Database Schema & Data
Execute the SQL dump against the direct port 5432 target connection:

```bash
export TARGET_DB_URL="postgresql://postgres:<password>@db.<new-ref>.supabase.co:5432/postgres"

# Execute restoration with clean table recreation
psql "$TARGET_DB_URL" -f medistock_backup_20260911_203000Z.sql
```

### Step 3: Verify Core Table Row Counts
Run this sanity check query in the target database:

```sql
SELECT
  (SELECT count(*) FROM users) AS users_count,
  (SELECT count(*) FROM tenants) AS tenants_count,
  (SELECT count(*) FROM medicines) AS medicines_count,
  (SELECT count(*) FROM batches) AS batches_count,
  (SELECT count(*) FROM sales) AS sales_count,
  (SELECT count(*) FROM tenant_payments) AS payments_count;
```

---

## 3. Post-Restore Smoke Test Checklist

| # | Sanity Test | Procedure | Expected Outcome |
|---|-------------|-----------|------------------|
| 1 | **Health Check** | `curl -i https://medistock-api.vercel.app/api/health` | Returns `200 OK` with `db.connected: true` and latency < 100ms. |
| 2 | **Owner Login** | Log in via POS app at `https://medistock-pharma.vercel.app/login` | Session token issued (`200 OK`), redirects to Dashboard. |
| 3 | **Catalog & Stock** | Open Medicines catalog and verify active batch quantities | Matches pre-backup inventory counts. |
| 4 | **Create Test Bill** | Complete a 1-item test bill on the POS counter screen | Invoice generated, stock decremented by FEFO engine. |
| 5 | **Report Sanity** | Open Reports page for today | Net sales, profit, and invoice count update immediately. |

---

## 4. Environment Cutover
Update Vercel environment variables to point to the restored database:
1. `DATABASE_URL`: `postgresql://postgres.<new-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres`
2. `DATABASE_DIRECT_URL`: `postgresql://postgres:<password>@db.<new-ref>.supabase.co:5432/postgres`
3. Redeploy the API project (`vercel --prod` or trigger deployment via GitHub push).
