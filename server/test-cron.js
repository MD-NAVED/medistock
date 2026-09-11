/**
 * Task 7 Database Hygiene Cron Test Suite
 */
const { pool } = require('./db');

const PORT = process.env.PORT || 3111;
const BASE = `http://localhost:${PORT}`;
const CRON_SECRET = process.env.CRON_SECRET || 'test_cron_secret_32_characters_key';

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

async function call(pathname, { method = 'POST', headers = {} } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

(async () => {
  console.log('\n=== Task 7: Database Hygiene Cron Tests ===');

  // 1. Unauthorized Calls
  const noAuth = await call('/api/cron/cleanup');
  check('unauthorized call without secret rejected (401)', noAuth.status === 401, `status=${noAuth.status}`);

  const badAuth = await call('/api/cron/cleanup', {
    headers: { Authorization: 'Bearer wrong_secret_key_1234567890' },
  });
  check('unauthorized call with invalid secret rejected (401)', badAuth.status === 401, `status=${badAuth.status}`);

  // 2. Insert test data: expired sessions, old login attempts, old webhook events
  const user = (await pool.query('SELECT id FROM users LIMIT 1')).rows[0];

  await pool.query(`
    INSERT INTO sessions (token, user_id, expires_at)
    VALUES
      ('expired_token_1', $1, NOW() - INTERVAL '2 days'),
      ('expired_token_2', $1, NOW() - INTERVAL '10 days'),
      ('valid_token_3', $1, NOW() + INTERVAL '10 days')
    ON CONFLICT (token) DO NOTHING;
  `, [user.id]);

  await pool.query(`
    INSERT INTO login_attempts (username, ip, success, created_at)
    VALUES
      ('old_user_attempt', '127.0.0.1', 0, NOW() - INTERVAL '40 days'),
      ('recent_user_attempt', '127.0.0.1', 0, NOW() - INTERVAL '5 days');
  `);

  await pool.query(`
    INSERT INTO webhook_events (event_id, event_type, processed_at)
    VALUES
      ('old_evt_1', 'payment.captured', NOW() - INTERVAL '35 days'),
      ('recent_evt_2', 'payment.captured', NOW() - INTERVAL '2 days')
    ON CONFLICT (event_id) DO NOTHING;
  `);

  // 3. Authorized Cleanup Call
  console.log('  Executing authorized cron cleanup...');
  const success = await call('/api/cron/cleanup', {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });

  check('authorized call with valid secret succeeds (200)', success.status === 200, JSON.stringify(success.data));
  check('cron reports deleted sessions count >= 2', success.data?.deleted?.sessions >= 2, JSON.stringify(success.data?.deleted));
  check('cron reports deleted login_attempts count >= 1', success.data?.deleted?.login_attempts >= 1, JSON.stringify(success.data?.deleted));
  check('cron reports deleted webhook_events count >= 1', success.data?.deleted?.webhook_events >= 1, JSON.stringify(success.data?.deleted));

  // Verify valid session still exists in DB
  const validSession = (await pool.query("SELECT token FROM sessions WHERE token = 'valid_token_3'")).rows[0];
  check('valid unexpired session remains in DB', !!validSession);

  // Verify expired session was removed
  const expiredSession = (await pool.query("SELECT token FROM sessions WHERE token = 'expired_token_1'")).rows[0];
  check('expired session was successfully deleted from DB', !expiredSession);

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  await pool.end();
  if (failed > 0 || process.exitCode) {
    process.exit(1);
  }
})();
