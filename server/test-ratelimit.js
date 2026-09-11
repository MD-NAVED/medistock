/**
 * Task 3 Rate Limiting & Proxy Trust Test Suite
 */
const http = require('http');

const PORT = process.env.PORT || 3111;
const BASE = `http://localhost:${PORT}`;

let passed = 0;
let failed = 0;

function check(label, pass, extra = '') {
  if (pass) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${extra ? ' -> ' + extra : ''}`);
    process.exitCode = 1;
  }
}

async function call(pathname, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, headers: res.headers, data };
}

(async () => {
  console.log('\n=== Task 3: Upstash / In-Memory Rate Limiting & Proxy Trust Tests ===');

  // 1. Health check exposes ratelimit status
  const health = await call('/api/health');
  check('/api/health exposes ratelimit status', !!health.data?.ratelimit);
  check('health ratelimit provider is reported', typeof health.data?.ratelimit?.provider === 'string', JSON.stringify(health.data?.ratelimit));

  // 2. Trust Proxy Verification: Different X-Forwarded-For IPs have isolated rate limit buckets
  const ipA = '203.0.113.10';
  const ipB = '203.0.113.20';

  console.log('  Testing client IP isolation under trust proxy (10 attempts on IP A, then check IP B)...');
  // Send 10 login requests from IP A
  for (let i = 0; i < 10; i++) {
    await call('/api/auth/login', {
      method: 'POST',
      headers: { 'X-Forwarded-For': ipA },
      body: { username: 'nonexistent_user_' + i, password: 'wrong' },
    });
  }

  // 11th request from IP A must be rejected with 429 and Retry-After header
  const ipA11th = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'X-Forwarded-For': ipA },
    body: { username: 'test_user', password: 'wrong' },
  });

  check('11th login attempt from IP A returns 429 Too Many Requests', ipA11th.status === 429, `status=${ipA11th.status}`);
  check('429 response includes Retry-After header', !!ipA11th.headers.get('retry-after'), `retryAfter=${ipA11th.headers.get('retry-after')}`);
  check('429 response body contains rate_limited code', ipA11th.data?.code === 'rate_limited', JSON.stringify(ipA11th.data));

  // 1st request from IP B must NOT be blocked (proves trust-proxy isolates client IPs instead of grouping into one bucket)
  const ipB1st = await call('/api/auth/login', {
    method: 'POST',
    headers: { 'X-Forwarded-For': ipB },
    body: { username: 'test_user_b', password: 'wrong' },
  });

  check('1st request from IP B is not blocked by IP A rate limit (trust proxy verified)', ipB1st.status === 401, `status=${ipB1st.status}`);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0 || process.exitCode) {
    process.exit(1);
  }
})();
