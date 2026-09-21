/**
 * One-off deterministic password reset utility for MediStock.
 * Uses native crypto.scrypt (16384 rounds, raw parameters: N:16384, r:8, p:1, keylen:64).
 */
const { Client } = require('pg');
const crypto = require('crypto');

const username = process.argv[2] || 'owner';
const newPassword = process.argv[3];

if (!newPassword) {
  console.error('Usage: node scripts/reset-owner-password.js <username> <new_password>');
  process.exit(1);
}

const connectionString = process.env.DATABASE_DIRECT_URL || process.env.DATABASE_URL;
if (!connectionString) {
  console.error('Error: DATABASE_URL or DATABASE_DIRECT_URL environment variable is required.');
  process.exit(1);
}

const isLocalHost = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const client = new Client({
  connectionString,
  ssl: isLocalHost ? false : { rejectUnauthorized: false },
});

(async () => {
  try {
    await client.connect();
    console.log('[reset-pwd] Connected to database.');

    const { rows } = await client.query('SELECT id, username, role FROM users WHERE username = $1', [username]);
    if (!rows.length) {
      console.error(`[reset-pwd] Error: User "${username}" not found.`);
      await client.end();
      process.exit(1);
    }
    const user = rows[0];

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(newPassword, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex');

    await client.query(
      'UPDATE users SET password_hash = $1, salt = $2, algo = $3, active = 1 WHERE id = $4',
      [hash, salt, 'scrypt', user.id]
    );

    await client.query('DELETE FROM login_attempts WHERE username = $1', [username]);

    console.log(`[reset-pwd] SUCCESS: Password for user "${user.username}" (role: ${user.role}) has been reset successfully using scrypt.`);
    await client.end();
  } catch (err) {
    console.error('[reset-pwd] Database error:', err.message);
    process.exit(1);
  }\n})();
