/**
 * scripts/generate-founder-payment-link.js
 *
 * One-off utility to generate a real ¢n1 Razorpay smoke-test payment link
 * and pre-register the tenant_payments order for webhook verification.
 *
 * Usage:
 *   DATABASE_URL="postgres://..." RAZORPAY_KEY_ID="rzp_live_..." RAZORPAY_KEY_SECRET="..." node scripts/generate-founder-payment-link.js
 */
const { Client } = require('pg');
const Razorpay = require('razorpay');

const connectionString = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Error: DATABASE_URL or DATABASE_DIRECT_URL environment variable is required.');
  process.exit(1);
}

const key_id = process.env.RAZORPAY_KEY_ID;
const key_secret = process.env.RAZORPAY_KEY_SECRET;
if (!key_id || !key_secret) {
  console.error('Error: RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables are required.');
  process.exit(1);
}

const rp = new Razorpay({ key_id, key_secret });

const isLocalHost = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const client = new Client({
  connectionString,
  ssl: isLocalHost ? false : { rejectUnauthorized: false },
});

(async () => {
  try {
    await client.connect();
    console.log('[smoke-test] Connected to database.');

    // 1. Find the store (MediStock Pharmacy / Elite or first tenant)
    const { rows: tenants } = await client.query(
      `SELECT id, store_name, owner_name, phone, email, plan, status, tier
       FROM tenants
       WHERE store_name ILIKE '%MediStock%' OR id = 1
       ORDER BY id ASC
       LIMIT 1`
    );

    if (!tenants.length) {
      console.error('[smoke-test] Error: No tenant found in database.');
      await client.end();
      process.exit(1);
    }

    const tenant = tenants[0];
    console.log(`[smoke-test] Target Store Found: ID ${tenant.id} | "${tenant.store_name}" (Owner: ${tenant.owner_name}, Tier: ${tenant.tier}, Status: ${tenant.status})`);

    const amountInPaise = 100; // ⚹1.00

    // 2. Create the Razorpay Order
    console.log('[smoke-test] Creating Razorpay Order...');
    const receiptId = `T${tenant.id}-test1-${Date.now()}`.slice(0, 40);
    const order = await rp.orders.create({
      amount: amountInPaise,
      currency: 'INR',
      receipt: receiptId,
      notes: {
        tenant_id: String(tenant.id),
        plan: 'test-1',
        store: tenant.store_name,
      },
    });

    console.log(`[smoke-test] Razorpay Order Created: ${order.id} (Amount: ⚹${order.amount / 100})`);

    // 3. Create pre-registered tenant_payments row (status: 'created')
    const { rows: payRows } = await client.query(
      `INSERT INTO tenant_payments (tenant_id, plan, months, amount, razorpay_order_id, status)
       VALUES ($1, 'test-1', 1, $2, $3, 'created')
       RETURNING id, created_at`,
      [tenant.id, amountInPaise, order.id]
    );
    const paymentRecordId = payRows[0].id;
    console.log(`[smoke-test] Inserted tenant_payments row: ID ${paymentRecordId} with status 'created'.`);

    // 4. Create hosted Razorpay Payment Link for immediate payment
    const cleanPhone = String(tenant.phone || '').replace(/[^\d]/g, '').slice(-10) || '9876543210';
    const linkRef = `PL-T${tenant.id}-${Date.now()}`.slice(0, 40);

    console.log('[smoke-test] Creating Razorpay Payment Link...');
    const paymentLink = await rp.paymentLink.create({
      amount: amountInPaise,
      currency: 'INR',
      accept_partial: false,
      reference_id: linkRef,
      description: `MediStock Smoke Test (⚹1) — ${tenant.store_name}`,
      customer: {
        name: tenant.owner_name || 'Store Owner',
        contact: cleanPhone,
        email: tenant.email || undefined,
      },
      notify: { sms: false, email: false },
      notes: {
        tenant_id: String(tenant.id),
        plan: 'test-1',
        razorpay_order_id: order.id,
        tenant_payment_id: String(paymentRecordId),
      },
    });

    console.log('\n======================================================');
    console.log('🎉 ⚚1 SMOKE TEST PAYMENT LINK GENERATED');
    console.log('=====================================================');
    console.log(`Store:             ${tenant.store_name} (ID: ${tenant.id})`);
    console.log(`Order ID:          ${order.id}`);
    console.log(`Payment Record ID: ${paymentRecordId}`);
    console.log(`Payment Link URL:  ${paymentLink.short_url}`);
    console.log('======================================================');
    console.log('\nInstructions:');
    console.log('1. Open the Payment Link URL in your browser or phone.');
    console.log('2. Complete the ⚹1 payment using UPI (GPay, PhonePe, Paytm) or Card.');
    console.log('3. The webhook (payment.captured) will hit medistock-api:');
    console.log('   - Updates tenant_payments row status to "paid".');
    console.log('   - Deduplicates via webhook_events.');
    console.log('   - Extends the tenant subscription by 1 month.');
    console.log('=====================================================\n');

    await client.end();
  } catch (err) {
    console.error('[smoke-test] Execution failed:', err.message || err);
  }
})();

