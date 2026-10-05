# 🏥 MediStock — Open-Source Cloud Pharmacy & Clinical Inventory System

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Standards: HL7 FHIR R4 Aligned](https://img.shields.io/badge/Standards-HL7%20FHIR%20R4%20Aligned-emerald.svg)](https://hl7.org/fhir/)
[![Database: PostgreSQL RLS](https://img.shields.io/badge/Database-PostgreSQL%20(Supabase%20RLS)-336791.svg)](https://supabase.com)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> A modern, cloud-native pharmacy point-of-sale and clinical inventory management platform designed for retail chemists, outpatient clinics, and community healthcare facilities. Built with strict FEFO batch tracking, multi-tenant clinical data isolation via PostgreSQL Row Level Security (RLS), and HL7 FHIR-aligned medication workflows.

🌐 **Live Demo Web App:** [https://medistock-pos.vercel.app](https://medistock-pos.vercel.app)  
🎥 **Architecture & Workflow Video Walkthrough:** [Watch 5-Min Loom Demo](https://www.loom.com/share/963cae256dac49c88f2f950e4625c8b9)

---

## 💡 The Problem & Motivation

In retail pharmacy and outpatient clinical settings, two critical inefficiencies cause significant operational waste and patient safety hazards:
1. **Medication Expiry Write-Offs:** Fragmented legacy desktop applications lack deterministic batch-level visibility, causing near-expiry medicines to stay unnoticed on shelves.
2. **Clinical Data Silos:** Most local pharmacies rely on unencrypted single-PC desktop tools without real-time auditability or adherence to modern healthcare data standards.

**MediStock** addresses this by providing an open, cloud-first platform ensuring strict expiration rotation, real-time counter dispensation, and multi-tenant patient ledger privacy.

---

## ⚡ Core Healthcare Workflows

### 1. Automated FEFO (First-Expiry-First-Out) Allocation
Unlike simple FIFO (First-In-First-Out) warehouse models, medical inventories require expiration-prioritized dispensation:
* Every medicine batch ingested records `batch_number`, `expiry_date`, and supplier invoice metadata.
* During counter checkout, MediStock automatically allocates and deducts from the earliest expiring valid batch.

### 2. Preventative 30/60/90-Day Expiry Alerts
* Visual color-coded warning states flag medicines 90, 60, and 30 days prior to expiry.
* Enables pharmacy staff to execute timely distributor returns for credit or prioritize clinical dispensation before medicine obsolescence.

### 3. Rapid Counter POS & WhatsApp Digital Invoicing
* High-speed medication checkout interface optimized for mobile and desktop counters.
* Atomic stock depletion across multi-batch lines with instant digital bill delivery via WhatsApp.
* Built-in Customer Khata (Credit Ledger) for chronic patient treatment regimens.

---

## 🛡️ Architecture & Healthcare Standards Alignment

### 🔒 Multi-Tenant Clinical Isolation (PostgreSQL Row Level Security)
Healthcare privacy requires deterministic boundaries. MediStock enforces strict **Row Level Security (RLS)** in PostgreSQL:
* All database tables (`inventory`, `batches`, `invoices`, `customers`) are partitioned and scoped by a validated `store_id`.
* Clinic A can never read, modify, or query Clinic B's medication stock or patient transactions.

### 🩺 Mapping to HL7 FHIR & Headless EHR Standards
MediStock's domain model is architected to easily bridge with modern open-source healthcare platforms (such as **Medplum** and standard FHIR servers):

| MediStock Concept | HL7 FHIR R4 Resource | Purpose / Description |
| :--- | :--- | :--- |
| **Medicine / Batch Item** | `Medication` / `InventoryItem` | Drug identity, lot/batch number, expiry date, manufacturer. |
| **Point of Sale Dispense** | `MedicationDispense` | Tracks the dispensing event, quantity deducted, and pharmacy actor. |
| **Prescription / Order** | `MedicationRequest` | Clinical fulfillment reference for patient orders. |
| **Pharmacy / Clinic Store** | `Organization` / `Location` | Enforces multi-facility boundary and geographic context. |

---

## 🛠️ Tech Stack

* **Frontend:** React 18, Next.js / Vite, Tailwind CSS, Material UI, Lucide Icons
* **Backend & Database:** Node.js, Express, PostgreSQL via Supabase (Row Level Security & Realtime Subscriptions)
* **Mobile Runtime:** Capacitor (Android native packaging for counter hardware)
* **Integrations:** WhatsApp Webhooks, Razorpay Payment Gateway, Sentry APM

---

## 🚀 Quickstart for Developers

### Prerequisites
* **Node.js 18+** and npm / pnpm
* A **PostgreSQL** database (Local instance or free cloud database on [Supabase](https://supabase.com))

### 1. Clone the repository
```bash
git clone https://github.com/MD-NAVED/medistock.git
cd medistock
```

### 2. Install dependencies & build client
```bash
npm run setup
```

### 3. Configure Environment Variables
Copy the example environment configuration:
```bash
cp .env.example .env
```
Update `.env` with your database and service credentials (see `.env.example` for reference).

### 4. Database Initialization
If running locally, apply the schema and demo seeds from `scripts/init-supabase.sql` into your Postgres database.
```bash
# Start local server
DATABASE_URL=postgres://user:password@localhost:5432/medistock npm start
```
The application will be live at `http://localhost:3001`.

### 5. Running the Test Suite
MediStock includes a comprehensive 102-check automated test harness spanning API endpoints, purchase reconciliation, and audit log persistence:
```bash
npm test
```

---

## 📱 Mobile App (Android Native)

MediStock includes a full Capacitor Android integration for touch-screen counter tablets and handheld POS devices:
```bash
# Sync web build to Android platform
npm run build:client
npx cap sync android

# Build release APK
cd client/android && ./gradlew assembleRelease
```

---

## 🤝 Contributing

Contributions are warmly welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct, branching conventions, and pull request submission process.

---

## 📄 License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.  
Copyright (c) 2026 **Mohammad Naved**.
