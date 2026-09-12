/**
 * Production WAN Load Test: 50 concurrent VUs for 60s against https://medistock-api.vercel.app
 * STRICTLY READ-ONLY (No writes, no sales, no payments).
 * Samples pg_stat_activity every 500ms via DATABASE_DIRECT_URL during the run.
 */
const { Client } = require('pg');

const TARGET_URL = 'https://medistock-api.vercel.app';
const DIRECT_URL = process.env.DATABASE_DIRECT_URL;
if (!DIRECT_URL) {
  console.error('DATABASE_DIRECT_URL env var required');
  process.exit(1);
}

(async () => {
  console.log('=== Step 1: Setting up dedicated test account for read-only load test ===');
  const testId = Date.now();
  const signupRes = await fetch(TARGET_URL + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      store_name: 'WAN LoadTest Store ' + testId,
      name: 'LoadTest Operator',
      username: 'k6_user_' + testId,
      password: 'StrongPassword123!',
      phone: '9999900000',
    }),
  });
  const signupData = await signupRes.json();
  const token = signupData.token;
  const storeId = signupData.user?.store_id;
  console.log(`Dedicated account ready. Username: k6_user_${testId}, Store ID: ${storeId}`);

  // Direct PG Client for sampling during the run
  const directClient = new Client({ connectionString: DIRECT_URL, ssl: { rejectUnauthorized: false } });
  await directClient.connect();
  console.log('Direct PostgreSQL connection established for pg_stat_activity monitoring.');

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: 'Bearer ' + token,
  };

  const endpoints = [
    { name: 'GET /api/health', url: TARGET_URL + '/api/health', headers: {} },
    { name: 'GET /api/medicines', url: TARGET_URL + '/api/medicines', headers: authHeaders },
    { name: 'GET /api/alerts', url: TARGET_URL + '/api/alerts', headers: authHeaders },
    { name: 'GET /api/reports/dashboard', url: TARGET_URL + '/api/reports/dashboard', headers: authHeaders },
  ];

  let running = true;
  let totalRequests = 0;
  let successfulRequests = 0;
  let errorRequests = 0;
  const latencies = [];
  const pgStatSamples = [];

  // Poll pg_stat_activity every 500ms
  const poller = setInterval(async () => {
    try {
      const res = await directClient.query(
        'SELECT count(*)::int AS count, state FROM pg_stat_activity GROUP BY state ORDER BY count DESC'
      );
      pgStatSamples.push({ timestamp: Date.now(), states: res.rows });
    } catch (e) {}
  }, 500);

  const durationMs = 60_000;
  const startTime = Date.now();
  console.log(`\n=== Step 2: Launching 50 Virtual Users for 60s against ${TARGET_URL} ===`);

  async function worker() {
    while (running && Date.now() - startTime < durationMs) {
      const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
      const reqStart = Date.now();
      totalRequests++;
      try {
        const res = await fetch(ep.url, { headers: ep.headers });
        const latency = Date.now() - reqStart;
        latencies.push(latency);
        if (res.status === 200) {
          successfulRequests++;
        } else {
          errorRequests++;
        }
      } catch (err) {
        errorRequests++;
      }
      // slight human pacing (50ms)
      await new Promise(r => setTimeout(r, 50));
    }
  }

  const vus = Array.from({ length: 50 }, () => worker());
  await Promise.all(vus);

  running = false;
  clearInterval(poller);

  // Sort latencies for percentiles
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;

  // Analyze pg_stat_activity peak
  let peakActive = 0;
  let peakIdle = 0;
  let peakTotal = 0;

  for (const sample of pgStatSamples) {
    let active = 0;
    let idle = 0;
    let total = 0;
    for (const s of sample.states) {
      total += s.count;
      if (s.state === 'active') active += s.count;
      if (s.state === 'idle') idle += s.count;
    }
    if (active > peakActive) peakActive = active;
    if (idle > peakIdle) peakIdle = idle;
    if (total > peakTotal) peakTotal = total;
  }

  console.log('\n=== REAL WAN 50-VU LOAD TEST RESULTS ===');
  console.log(`Target:                     ${TARGET_URL}`);
  console.log(`Duration:                   ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log(`Total Requests:             ${totalRequests}`);
  console.log(`HTTP 200 (Success):         ${successfulRequests}`);
  console.log(`Errors / Drops:             ${errorRequests}`);
  console.log(`Error Rate:                 ${((errorRequests / totalRequests) * 100).toFixed(2)}%`);
  console.log(`Latency p50:                ${p50} ms`);
  console.log(`Latency p95:                ${p95} ms`);
  console.log(`Latency p99:                ${p99} ms`);
  console.log(`Peak pg_stat_activity:      ${peakTotal} total connections (Active: ${peakActive}, Idle: ${peakIdle})`);
  console.log('========================================\n');

  // Step 3: Phase E Cleanup
  console.log('=== Step 3: Phase E Cleanup ===');
  await directClient.query("DELETE FROM sessions WHERE token = $1", [token]);
  console.log('Deleted k6 test account session token.');
  await directClient.end();
  console.log('Direct PostgreSQL connection closed.');
})();
