/**
 * Production WAN Load Test: 50 Concurrent VUs for 60 seconds against https://medistock-api.vercel.app
 * STRICTLY READ-ONLY: /api/health, /api/medicines, /api/alerts, /api/reports/dashboard
 * Gathers p50/p95/p99 latencies, separates connection drops vs HTTP errors,
 * and samples pg_stat_activity every 500ms via direct connection.
 */
const { Client } = require('pg');
const https = require('https');

const TARGET_URL = 'https://medistock-api.vercel.app';
const DIRECT_URL = process.env.DATABASE_DIRECT_URL;
if (!DIRECT_URL) {
  console.error('DATABASE_DIRECT_URL env var required');
  process.exit(1);
}

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 60,
  timeout: 10000,
});

async function httpRequest(urlStr, options = {}) {
  const url = new URL(urlStr);
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
        agent: httpsAgent,
        timeout: 10000,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          const duration = Date.now() - start;
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            duration,
            body,
            errorType: res.statusCode >= 400 ? 'HTTP_' + res.statusCode : null,
          });
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('ETIMEDOUT'));
    });

    req.on('error', (err) => {
      const duration = Date.now() - start;
      resolve({
        ok: false,
        status: 0,
        duration,
        errorType: err.code || 'NETWORK_ERROR',
        error: err.message,
      });
    });

    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

(async () => {
  console.log('=== Step 1: Setting up dedicated test account (One-time setup) ===');
  const testId = Date.now();
  const signupRes = await httpRequest(TARGET_URL + '/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      store_name: 'WAN LoadTest Store ' + testId,
      name: 'LoadTest Operator',
      username: 'loadtest_' + testId,
      password: 'StrongPassword123!',
      phone: '9999900000',
    }),
  });

  let token = null;
  try {
    const signupData = JSON.parse(signupRes.body);
    token = signupData.token;
  } catch (e) {
    console.error('Failed to parse signup response:', signupRes.body);
    process.exit(1);
  }

  if (!token) {
    console.error('Failed to obtain auth token:', signupRes);
    process.exit(1);
  }
  console.log(`Dedicated account ready. Username: loadtest_${testId}`);

  // 2. Direct PostgreSQL connection for sampling pg_stat_activity
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
  let httpErrorCount = 0;
  let networkErrorCount = 0;
  const latencies = [];
  const errorsByType = {};
  const pgStatSamples = [];

  // Poll pg_stat_activity safely every 500ms
  let isPolling = false;
  const poller = setInterval(async () => {
    if (isPolling) return;
    isPolling = true;
    try {
      const res = await directClient.query(
        'SELECT count(*)::int AS count, state FROM pg_stat_activity GROUP BY state ORDER BY count DESC'
      );
      pgStatSamples.push({ timestamp: Date.now(), states: res.rows });
    } catch (e) {
    } finally {
      isPolling = false;
    }
  }, 500);

  const durationMs = 60_000;
  const startTime = Date.now();
  console.log(`\n=== Step 2: Running 50 Virtual Users for 60 seconds against ${TARGET_URL} ===`);

  async function worker(vuId) {
    while (running && Date.now() - startTime < durationMs) {
      const ep = endpoints[Math.floor(Math.random() * endpoints.length)];
      totalRequests++;
      const res = await httpRequest(ep.url, { headers: ep.headers });
      latencies.push(res.duration);

      if (res.ok) {
        successfulRequests++;
      } else {
        if (res.status > 0) {
          httpErrorCount++;
        } else {
          networkErrorCount++;
        }
        const errKey = res.errorType || 'UNKNOWN_ERROR';
        errorsByType[errKey] = (errorsByType[errKey] || 0) + 1;
      }

      // 100ms pacing between iterations per VU
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const vus = Array.from({ length: 50 }, (_, i) => worker(i + 1));
  await Promise.all(vus);

  running = false;
  clearInterval(poller);

  // Compute Latency Percentiles
  latencies.sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.50)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;

  // Analyze pg_stat_activity metrics
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

  const totalErrors = httpErrorCount + networkErrorCount;
  const errorRate = totalRequests > 0 ? ((totalErrors / totalRequests) * 100).toFixed(2) : '0.00';

  console.log('\n=== REAL WAN 50-VU LOAD TEST RESULTS (POOLED 6543) ===');
  console.log(`Target Host:                ${TARGET_URL}`);
  console.log(`Duration:                   ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log(`Total Requests (http_reqs): ${totalRequests}`);
  console.log(`HTTP 200 OK (Success):      ${successfulRequests}`);
  console.log(`HTTP Errors (4xx/5xx):      ${httpErrorCount}`);
  console.log(`Network/Connection Drops:   ${networkErrorCount}`);
  console.log(`Error Rate:                 ${errorRate}%`);
  console.log(`Latency p50:                ${p50} ms`);
  console.log(`Latency p95:                ${p95} ms`);
  console.log(`Latency p99:                ${p99} ms`);
  console.log(`Peak pg_stat_activity:      ${peakTotal} total connections (Active: ${peakActive}, Idle: ${peakIdle})`);
  if (Object.keys(errorsByType).length > 0) {
    console.log('Errors Breakdown:', JSON.stringify(errorsByType, null, 2));
  }
  console.log('====================================================\n');

  // Step 3: Phase E Cleanup
  console.log('=== Step 3: Phase E Cleanup ===');
  await directClient.query('DELETE FROM sessions WHERE token = $1', [token]);
  console.log('Deleted test session token.');
  await directClient.end();
  console.log('Closed direct PostgreSQL monitoring connection.');
})();
