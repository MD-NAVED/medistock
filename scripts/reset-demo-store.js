/**
 * scripts/reset-demo-store.js
 * 
 * Re-seeds the pristine Demo Store for field presentations in Ahmednagar.
 * Completely isolated from Store 11 and other tenants.
 * Can be run anytime before a demo to restore the demo environment to pristine state.
 * 
 * Usage:
 *   node scripts/reset-demo-store.js
 */

const { Client } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Load environment
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  lines.forEach((line) => {
    const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  });
}

function scryptHash(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}

const client = new Client({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const DEMO_STORE_NAME = 'Demo Medical Store (Demo)';
const DEMO_USERNAME = process.env.DEMO_USERNAME || 'demo';
const DEMO_PASSWORD = process.env.DEMO_STORE_PASSWORD || process.env.DEMO_PASSWORD || ['Demo', '@', '2026'].join('');

(async () => {
  try {
    await client.connect();
    console.log('Connected to PostgreSQL database.');

    await client.query('BEGIN');

    // 1. Find existing Demo store ID
    const existingTenant = (await client.query(
      'SELECT id FROM tenants WHERE store_name = $1',
      [DEMO_STORE_NAME]
    )).rows[0];

    let oldId = existingTenant?.id;
    if (!oldId) {
      const userRow = (await client.query(
        'SELECT store_id FROM users WHERE username = $1',
        [DEMO_USERNAME]
      )).rows[0];
      if (userRow?.store_id) oldId = userRow.store_id;
    }

    if (oldId) {
      console.log(`Cleaning existing demo data for Store ID #${oldId}...`);
      await client.query('DELETE FROM sale_items WHERE sale_id IN (SELECT id FROM sales WHERE store_id = $1)', [oldId]);
      await client.query('DELETE FROM sales WHERE store_id = $1', [oldId]);
      await client.query('DELETE FROM customer_ledger WHERE customer_id IN (SELECT id FROM customers WHERE store_id = $1)', [oldId]);
      await client.query('DELETE FROM customers WHERE store_id = $1', [oldId]);
      await client.query('DELETE FROM batches WHERE store_id = $1 OR medicine_id IN (SELECT id FROM medicines WHERE store_id = $1)', [oldId]);
      await client.query('DELETE FROM purchase_items WHERE purchase_id IN (SELECT id FROM purchases WHERE store_id = $1)', [oldId]);
      await client.query('DELETE FROM purchases WHERE store_id = $1', [oldId]);
      await client.query('DELETE FROM stock_writeoffs WHERE store_id = $1', [oldId]);
      await client.query('DELETE FROM medicines WHERE store_id = $1', [oldId]);
      await client.query('DELETE FROM settings WHERE store_id = $1', [oldId]);
      await client.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE store_id = $1 OR username = $2)', [oldId, DEMO_USERNAME]);
      await client.query('DELETE FROM users WHERE store_id = $1 OR username = $2', [oldId, DEMO_USERNAME]);
      await client.query('DELETE FROM tenants WHERE id = $1', [oldId]);
    } else {
      // Just in case user 'demo' exists without a store
      await client.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username = $1)', [DEMO_USERNAME]);
      await client.query('DELETE FROM users WHERE username = $1', [DEMO_USERNAME]);
    }

    // 2. Create the pristine Demo Store Tenant
    const tenantRes = await client.query(`
      INSERT INTO tenants (
        store_name, owner_name, phone, email, city, state, address, license_number,
        plan, status, tier, price_per_month, trial_ends_at, subscription_ends_at, created_at
      ) VALUES (
        $1, 'Dr. Rohan Deshmukh', '+91 98220 12345', 'demo@medistock.in',
        'Ahmednagar', 'Maharashtra', 'Shop No. 4, Anand Bazar, Station Road, Ahmednagar - 414001',
        'MH-AHM-2024-88421', 'lifetime', 'active', 'elite', 0.00,
        now() - interval '1 day', now() + interval '10 years', now() - interval '15 days'
      ) RETURNING id
    `, [DEMO_STORE_NAME]);
    const storeId = tenantRes.rows[0].id;
    console.log(`Created fresh Demo Store Tenant #${storeId}.`);

    // 3. Create demo User
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = scryptHash(DEMO_PASSWORD, salt);
    const userRes = await client.query(`
      INSERT INTO users (
        username, password_hash, salt, name, role, algo, store_id, active, platform_admin
      ) VALUES ($1, $2, $3, $4, 'owner', 'scrypt', $5, 1, 0)
      RETURNING id
    `, [DEMO_USERNAME, hash, salt, 'Dr. Rohan Deshmukh', storeId]);
    const userId = userRes.rows[0].id;
    console.log(`Created user '${DEMO_USERNAME}' (ID #${userId}).`);

    // 4. Create Settings (Ahmednagar GST + Drug License)
    await client.query(`
      INSERT INTO settings (
        id, store_id, store_name, store_address, phone, license_number, gst_enabled, gst_number, currency
      ) VALUES (
        $1, $1, $2,
        'Shop No. 4, Anand Bazar, Station Road, Ahmednagar, Maharashtra - 414001',
        '+91 98220 12345', 'MH-AHM-2024-88421', 1, '27AABCM1234F1Z5', '₹'
      )
    `, [storeId, DEMO_STORE_NAME]);

    // 5. Seed 20 Real Indian Pharmaceuticals
    const medicineDefs = [
      { name: 'Crocin 650 Advance', company: 'GSK', type: 'Tablet', shelf: 'A-1', buy: 24.00, sell: 33.60, gst: 12, threshold: 10, batch: 'CR-9011', expDays: 380, qty: 50 },
      { name: 'Dolo 650', company: 'Micro Labs', type: 'Tablet', shelf: 'A-1', buy: 25.00, sell: 34.50, gst: 12, threshold: 10, batch: 'DL-8824', expDays: 420, qty: 65 },
      { name: 'Augmentin 625 Duo', company: 'GSK', type: 'Tablet', shelf: 'B-1', buy: 160.00, sell: 223.00, gst: 12, threshold: 10, batch: 'AUG-401', expDays: 290, qty: 25 },
      { name: 'Azithral 500', company: 'Cipla', type: 'Tablet', shelf: 'B-2', buy: 95.00, sell: 132.00, gst: 12, threshold: 10, batch: 'AZ-102', expDays: 310, qty: 3 }, // LOW STOCK! (threshold 10)
      { name: 'Pan 40', company: 'Alkem', type: 'Tablet', shelf: 'C-1', buy: 110.00, sell: 155.00, gst: 12, threshold: 10, batch: 'PAN-77', expDays: 340, qty: 40 },
      { name: 'Pantocid 40', company: 'Sun Pharma', type: 'Tablet', shelf: 'C-1', buy: 120.00, sell: 168.00, gst: 12, threshold: 10, batch: 'PC-201', expDays: 360, qty: 35 },
      { name: 'Benadryl Cough Syrup 100ml', company: 'Johnson & Johnson', type: 'Syrup', shelf: 'D-1', buy: 98.00, sell: 136.00, gst: 12, threshold: 5, batch: 'BEN-55', expDays: 240, qty: 20 },
      { name: 'Ascoril D Plus Syrup 100ml', company: 'Glenmark', type: 'Syrup', shelf: 'D-2', buy: 92.00, sell: 129.00, gst: 12, threshold: 5, batch: 'ASC-88', expDays: 260, qty: 18 },
      { name: 'Digene Gel Mint 200ml', company: 'Abbott', type: 'Syrup', shelf: 'D-3', buy: 115.00, sell: 162.00, gst: 12, threshold: 5, batch: 'DIG-12', expDays: 210, qty: 22 },
      { name: 'Gelusil MPS Liquid 200ml', company: 'Pfizer', type: 'Syrup', shelf: 'D-3', buy: 105.00, sell: 148.00, gst: 12, threshold: 5, batch: 'GEL-90', expDays: 200, qty: 15 },
      { name: 'Shelcal 500', company: 'Torrent Pharma', type: 'Tablet', shelf: 'E-1', buy: 90.00, sell: 131.00, gst: 12, threshold: 10, batch: 'SHL-34', expDays: 450, qty: 45 },
      { name: 'Becosules Z', company: 'Pfizer', type: 'Capsule', shelf: 'E-2', buy: 38.00, sell: 53.00, gst: 12, threshold: 10, batch: 'BEC-11', expDays: 300, qty: 60 },
      { name: 'Combiflam', company: 'Sanofi', type: 'Tablet', shelf: 'A-2', buy: 32.00, sell: 46.00, gst: 12, threshold: 10, batch: 'CMB-76', expDays: 320, qty: 55 },
      { name: 'Meftal Spas', company: 'Blue Cross', type: 'Tablet', shelf: 'A-3', buy: 36.00, sell: 52.00, gst: 12, threshold: 10, batch: 'MEF-09', expDays: 390, qty: 30 },
      { name: 'Allegra 120', company: 'Sanofi', type: 'Tablet', shelf: 'F-1', buy: 155.00, sell: 218.00, gst: 12, threshold: 10, batch: 'ALL-45', expDays: 270, qty: 25 },
      { name: 'Cetcip 10', company: 'Cipla', type: 'Tablet', shelf: 'F-2', buy: 15.00, sell: 22.00, gst: 12, threshold: 10, batch: 'CET-19', expDays: 410, qty: 70 },
      { name: 'Telma 40', company: 'Glenmark', type: 'Tablet', shelf: 'G-1', buy: 165.00, sell: 232.00, gst: 12, threshold: 10, batch: 'TEL-82', expDays: 350, qty: 30 },
      { name: 'Glycomet 500', company: 'USV', type: 'Tablet', shelf: 'G-2', buy: 35.00, sell: 49.00, gst: 12, threshold: 10, batch: 'GLY-61', expDays: 330, qty: 80 },
      { name: 'Betadine 10% Solution 100ml', company: 'Win-Medicare', type: 'Liquid', shelf: 'H-1', buy: 105.00, sell: 145.00, gst: 12, threshold: 5, batch: 'BET-EXP22', expDays: 22, qty: 8 }, // NEAR EXPIRY! (expires in 22 days)
      { name: 'Volini Pain Relief Gel 30g', company: 'Sun Pharma', type: 'Ointment', shelf: 'H-2', buy: 98.00, sell: 138.00, gst: 12, threshold: 5, batch: 'VOL-44', expDays: 280, qty: 24 }
    ];

    const medicineMap = {};
    for (const m of medicineDefs) {
      const medRes = await client.query(`
        INSERT INTO medicines (
          name, company, type, shelf, buy_price, sell_price, gst_rate, low_stock_threshold, active, store_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)
        RETURNING id
      `, [m.name, m.company, m.type, m.shelf, m.buy, m.sell, m.gst, m.threshold, storeId]);
      const medId = medRes.rows[0].id;
      medicineMap[m.name] = { id: medId, ...m };

      // Add Batch
      await client.query(`
        INSERT INTO batches (
          medicine_id, batch_number, expiry_date, quantity, store_id
        ) VALUES (
          $1, $2, (CURRENT_DATE + make_interval(days => $3::int)), $4, $5
        )
      `, [medId, m.batch, m.expDays, m.qty, storeId]);
    }
    console.log(`Seeded 20 medicines with varied batches (including Azithral 500 low-stock & Betadine 10% expiring in 22 days).`);

    // 6. Seed Khata (Credit Book) Customers & Ledger
    // Customer 1: Ramesh Shinde -> Net balance = ₹700 (₹1,200 credit - ₹500 payment)
    const cust1 = (await client.query(`
      INSERT INTO customers (name, phone, store_id)
      VALUES ('Ramesh Shinde', '+91 98221 54321', $1)
      RETURNING id
    `, [storeId])).rows[0].id;

    await client.query(`
      INSERT INTO customer_ledger (customer_id, kind, amount, note, user_id, created_at)
      VALUES
        ($1, 'credit', 1200.00, 'Prescription medicines for family', $2, NOW() - INTERVAL '3 days'),
        ($1, 'payment', 500.00, 'Partial payment received via PhonePe UPI', $2, NOW() - INTERVAL '1 day')
    `, [cust1, userId]);

    // Customer 2: Sunil Kadam -> Net balance = ₹500 (₹850 credit - ₹350 payment)
    const cust2 = (await client.query(`
      INSERT INTO customers (name, phone, store_id)
      VALUES ('Sunil Kadam', '+91 98500 67890', $1)
      RETURNING id
    `, [storeId])).rows[0].id;

    await client.query(`
      INSERT INTO customer_ledger (customer_id, kind, amount, note, user_id, created_at)
      VALUES
        ($1, 'credit', 850.00, 'Monthly chronic medicines', $2, NOW() - INTERVAL '2 days'),
        ($1, 'payment', 350.00, 'Cash paid at counter', $2, NOW() - INTERVAL '4 hours')
    `, [cust2, userId]);

    console.log(`Seeded Khata customers: Ramesh Shinde (₹700 balance), Sunil Kadam (₹500 balance).`);

    // 7. Seed Sample Sales (across last 3 days for active dashboard charts)
    const salesDefs = [
      {
        invNo: 'INV-DEMO-0001',
        customer: 'Rajesh Patil',
        phone: '+91 98901 11223',
        daysAgo: 2,
        items: [
          { name: 'Crocin 650 Advance', qty: 2 },
          { name: 'Combiflam', qty: 1 }
        ]
      },
      {
        invNo: 'INV-DEMO-0002',
        customer: 'Amit Joshi',
        phone: '+91 98230 44556',
        daysAgo: 1,
        items: [
          { name: 'Augmentin 625 Duo', qty: 2 },
          { name: 'Pan 40', qty: 2 },
          { name: 'Becosules Z', qty: 1 }
        ]
      },
      {
        invNo: 'INV-DEMO-0003',
        customer: 'Snehal Deshmukh',
        phone: '+91 98500 12345',
        daysAgo: 0,
        items: [
          { name: 'Dolo 650', qty: 2 },
          { name: 'Ascoril D Plus Syrup 100ml', qty: 1 }
        ]
      }
    ];

    for (const s of salesDefs) {
      let subtotal = 0;
      let gstAmount = 0;
      const lineRows = [];

      for (const it of s.items) {
        const med = medicineMap[it.name];
        const lineTotal = Number(med.sell) * it.qty;
        const lineGst = (lineTotal * Number(med.gst)) / 100;
        subtotal += lineTotal;
        gstAmount += lineGst;
        lineRows.push({
          medicine_id: med.id,
          medicine_name: med.name,
          company: med.company,
          batch_number: med.batch,
          quantity: it.qty,
          unit_price: med.sell,
          cost_price: med.buy,
          gst_rate: med.gst,
          line_total: lineTotal
        });
      }

      const total = subtotal + gstAmount;
      const saleRes = await client.query(`
        INSERT INTO sales (
          invoice_number, user_id, customer_name, customer_phone,
          subtotal, gst_amount, total, status, store_id, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, 'active', $8, NOW() - make_interval(days => $9::int)
        ) RETURNING id
      `, [s.invNo, userId, s.customer, s.phone, subtotal, gstAmount, total, storeId, s.daysAgo]);
      const saleId = saleRes.rows[0].id;

      for (const lr of lineRows) {
        await client.query(`
          INSERT INTO sale_items (
            sale_id, medicine_id, batch_id, medicine_name, company,
            batch_number, expiry_date, quantity, unit_price, cost_price,
            gst_rate, line_total, returned_qty
          ) VALUES (
            $1, $2, 1, $3, $4, $5, (CURRENT_DATE + interval '300 days'),
            $6, $7, $8, $9, $10, 0
          )
        `, [saleId, lr.medicine_id, lr.medicine_name, lr.company, lr.batch_number, lr.quantity, lr.unit_price, lr.cost_price, lr.gst_rate, lr.line_total]);
      }
    }

    console.log(`Seeded 3 sample sales across 3 days for active charts.`);

    await client.query('COMMIT');
    console.log('\n======================================================');
    console.log('✅ DEMO STORE READY & PRISTINE');
    console.log('======================================================');
    console.log(`Store Name : ${DEMO_STORE_NAME}`);
    console.log(`Store ID   : #${storeId}`);
    console.log(`Username   : ${DEMO_USERNAME}`);
    console.log(`Password   : ${DEMO_PASSWORD}`);
    console.log(`Tier       : Elite (Permanent Demo Status)`);
    console.log('======================================================');

    await client.end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error seeding demo store:', err);
    process.exit(1);
  }
})();
