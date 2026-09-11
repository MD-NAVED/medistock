import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '2m', target: 50 }, // Ramp up to 50 virtual users over 2 minutes
    { duration: '5m', target: 50 }, // Hold steady at 50 virtual users for 5 minutes
    { duration: '1m', target: 0 },  // Ramp down to 0 over 1 minute
  ],
  thresholds: {
    http_req_failed: ['rate<0.001'],    // Error rate must be less than 0.1%
    http_req_duration: ['p(95)<500'],   // 95% of requests must complete in < 500ms
  },
};

const BASE_URL = __ENV.TARGET_URL || 'http://localhost:3001';

export default function () {
  // 1. Health check
  const healthRes = http.get(`${BASE_URL}/api/health`);
  check(healthRes, {
    'health status is 200': (r) => r.status === 200,
  });

  // 2. Login as store staff
  const loginPayload = JSON.stringify({
    username: 'staff',
    password: 'staff123',
  });
  const loginRes = http.post(`${BASE_URL}/api/auth/login`, loginPayload, {
    headers: { 'Content-Type': 'application/json' },
  });

  const loginSuccess = check(loginRes, {
    'login status is 200': (r) => r.status === 200,
    'token received': (r) => !!r.json('token'),
  });

  if (!loginSuccess) {
    sleep(1);
    return;
  }

  const token = loginRes.json('token');
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  // 3. Catalog lookup
  const medsRes = http.get(`${BASE_URL}/api/medicines`, { headers: authHeaders });
  check(medsRes, {
    'medicines status is 200': (r) => r.status === 200,
  });

  // 4. Alerts check
  const alertsRes = http.get(`${BASE_URL}/api/alerts`, { headers: authHeaders });
  check(alertsRes, {
    'alerts status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
