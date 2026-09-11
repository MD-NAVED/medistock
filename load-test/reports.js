import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '1m', target: 20 }, // Ramp to 20 VUs
    { duration: '3m', target: 20 }, // Hold 20 VUs
    { duration: '1m', target: 0 },  // Ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.001'],    // Error rate < 0.1%
    http_req_duration: ['p(95)<1000'],  // 95% of report queries < 1s
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:3001';

export default function () {
  // Login as store owner (access to reports & khata)
  const loginPayload = JSON.stringify({
    username: 'owner',
    password: 'owner123',
  });
  const loginRes = http.post(`${BASE_URL}/api/auth/login`, loginPayload, {
    headers: { 'Content-Type': 'application/json' },
  });

  if (!check(loginRes, { 'login ok': (r) => r.status === 200 })) {
    sleep(1);
    return;
  }

  const token = loginRes.json('token');
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // 1. Dashboard metrics query
  const dashRes = http.get(`${BASE_URL}/api/reports/dashboard`, { headers: authHeaders });
  check(dashRes, { 'dashboard ok': (r) => r.status === 200 });

  // 2. Sales reports query (IST date bounded)
  const today = new Date().toISOString().slice(0, 10);
  const salesRes = http.get(`${BASE_URL}/api/reports/sales?from=${today}&to=${today}`, { headers: authHeaders });
  check(salesRes, { 'sales report ok': (r) => r.status === 200 });

  // 3. Khata ledger query
  const khataRes = http.get(`${BASE_URL}/api/khata`, { headers: authHeaders });
  check(khataRes, { 'khata ok': (r) => r.status === 200 });

  sleep(1);
}
