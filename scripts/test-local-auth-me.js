const fs = require('fs');
const path = require('path');
const http = require('http');

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

const app = require('../server/index');
const { pool } = require('../server/db');

(async () => {
  const server = http.createServer(app);
  server.listen(0, async () => {
    const port = server.address().port;
    const token = 'test_owner_local_' + Date.now();
    await pool.query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, 1, now() + interval '1 hour')", [token]);
    const res = await fetch(`http://localhost:${port}/api/auth/me`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await res.json();
    console.log('Local /api/auth/me for user 1 (owner):');
    console.log(JSON.stringify(data, null, 2));

    await pool.query('DELETE FROM sessions WHERE token = $1', [token]);
    await pool.end();
    server.close();
    process.exit(0);
  });
})();
