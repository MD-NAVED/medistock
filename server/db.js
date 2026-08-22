const { Pool } = require('pg');
const crypto = require('crypto');

const connectionString = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/medistock';

// TLS to the database only when the host is remote (e.g. Supabase on Vercel).
// Local dev servers don't speak SSL, so connecting to localhost stays plain.
const isLocalHost = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const useSsl = !!process.env.DATABASE_URL && !isLocalHost;

// Certificate-chain verification for the remote database.
// Supabase signs its database certificates with its own CA, so strict
// verification needs that CA: set DATABASE_SSL_CA to the PEM content of
// prod-ca-2021.crt from Supabase → Settings → Database.
// Without a CA we keep traffic encrypted but accept Supabase's chain
// (the same behaviour as sslmode=require, Supabase's serverless default).
let sslOptions = false;
if (useSsl) {
  const ca = process.env.DATABASE_SSL_CA && process.env.DATABASE_SSL_CA.includes('BEGIN CERTIFICATE')
    ? process.env.DATABASE_SSL_CA
    : null;
  const verify = !!ca || process.env.DATABASE_SSL_MODE === 'verify';
  sslOptions = { rejectUnauthorized: verify, ...(ca ? { ca } : {}) };
}

const pool = new Pool({
  connectionString,
  ssl: sslOptions,
  // Each serverless instance opens its own pool; cap it via env so many
  // concurrent functions cannot exhaust the database connection limit.
  max: Number(process.env.DATABASE_POOL_MAX) || 10,
});

async function transaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Passwords — scrypt (built into Node, no native build step)
// ---------------------------------------------------------------------------
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT_OPTS.keylen, {
    N: SCRYPT_OPTS.N, r: SCRYPT_OPTS.r, p: SCRYPT_OPTS.p,
  }).toString('hex');
}

function legacySha256(password, salt) {
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}

function timingSafeEqualHex(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function setUserPassword(userId, password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = scryptHash(password, salt);
  await pool.query(
    'UPDATE users SET password_hash = $1, salt = $2, algo = $3 WHERE id = $4',
    [hash, salt, 'scrypt', userId]
  );
}

async function verifyPassword(user, password) {
  if (user.algo === 'scrypt') {
    return timingSafeEqualHex(scryptHash(password, user.salt), user.password_hash);
  }
  const ok = timingSafeEqualHex(legacySha256(password, user.salt), user.password_hash);
  if (ok) await setUserPassword(user.id, password);
  return ok;
}

async function addUser(username, password, name, role) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = scryptHash(password, salt);
  const res = await pool.query(
    'INSERT INTO users (username, password_hash, salt, name, role, algo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [username, hash, salt, name, role, 'scrypt']
  );
  return res.rows[0].id;
}

module.exports = {
  pool,
  transaction,
  addUser,
  verifyPassword,
  setUserPassword,
  scryptHash,
};
