const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.trim().match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  }
}

const client = new Client({
  connectionString: process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

(async () => {
  await client.connect();

  // Test 1: User 1 ('owner', platform_admin = 1)
  const tokenOwner = 'test_owner_check_' + Date.now();
  await client.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, 1, now() + interval '1 hour')", [tokenOwner]);
  const resOwner = await fetch('https://medistock-api.vercel.app/api/auth/me', {
    headers: { 'Authorization': 'Bearer ' + tokenOwner }
  });
  const dataOwner = await resOwner.json();
  console.log('User 1 (owner, platform_admin=1) /api/auth/me:');
  console.log(JSON.stringify(dataOwner, null, 2));
  await client.query('DELETE FROM sessions WHERE token = $1', [tokenOwner]);

  // Test 2: User 2 ('staff', platform_admin = 0)
  const tokenStaff = 'test_staff_check_' + Date.now();
  await client.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, 2, now() + interval '1 hour')", [tokenStaff]);
  const resStaff = await fetch('https://medistock-api.vercel.app/api/auth/me', {
    headers: { 'Authorization': 'Bearer ' + tokenStaff }
  });
  const dataStaff = await resStaff.json();
  console.log('\nUser 2 (staff, platform_admin=0) /api/auth/me:');
  console.log(JSON.stringify(dataStaff, null, 2));
  await client.query('DELETE FROM sessions WHERE token = $1', [tokenStaff]);

  await client.end();
})();
