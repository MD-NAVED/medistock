/**
 * Task 1 Load Test: 50 concurrent requests for 60s against /api/health
 * and active connection sampling via PostgreSQL pg_stat_activity.
 */
const { Pool } = require('pg');
const http = require('http');

const PORT = process.env.PORT || 3001;
const DIRECT_URL = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;

async function run() {
  console.log(`[Task 1 Load Test] Starting 50 concurrent workers against http://localhost:${PORT}/api/health for 60s`);
  const directPool = new Pool({ connectionString: DIRECT_URL, max: 2 });

  let totalRequests = 0;
  let successfulRequests = 0;
  let errorRequests = 0;
  let maxActiveDbConnections = 0;
  let running = true;

  // Poll pg_stat_activity every 500ms
  const poller = setInterval(async () => {
    try {
      const res = await directPool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE state = 'active' OR state = 'idle'");
      const count = res.rows[0].count;
      if (count > maxActiveDbConnections) {
        maxActiveDbConnections = count;
      }
    } catch (e) {
      // ignore transient sampling errors
    }
  }, 500);

  const durationMs = 60_000;
  const startTime = Date.now();

  function makeRequest() {
    return new Promise((resolve) => {
      if (!running) return resolve();
      totalRequests++;
      const req = http.get(`http://localhost:${PORT}/api/health`, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            successfulRequests++;
          } else {
            errorRequests++;
          }
          resolve();
        });
      });
      req.on('error', (err) => {
        errorRequests++;
        resolve();
      });
      req.setTimeout(5000, () => {
        req.destroy();
        errorRequests++;
        resolve();
      });
    });
  }

  // 50 concurrent worker loops
  const workers = Array.from({ length: 50 }, async () => {
    while (running && (Date.now() - startTime < durationMs)) {
      await makeRequest();
    }
  });

  await Promise.all(workers);
  running = false;
  clearInterval(poller);
  await directPool.end();

  console.log('\n--- Task 1 Load Test Results ---');
  console.log(`Duration:                 ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
  console.log(`Total Requests:           ${totalRequests}`);
  console.log(`Successful (HTTP 200):    ${successfulRequests}`);
  console.log(`Errors / Timeouts:        ${errorRequests}`);
  console.log(`Error Rate:               ${((errorRequests / totalRequests) * 100).toFixed(2)}%`);
  console.log(`Peak pg_stat_activity:    ${maxActiveDbConnections} connections (Target: <= 8)`);
  console.log('--------------------------------\n');

  if (errorRequests === 0 && maxActiveDbConnections <= 8) {
    console.log('✅ PASS: Zero connection errors and pg_stat_activity stayed <= 8');
    process.exit(0);
  } else {
    console.error('❌ FAIL: Requirements not met');
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
