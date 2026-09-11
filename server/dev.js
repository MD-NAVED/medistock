// Local development entry — starts the Express server on a plain port.
// (The app itself is exported from index.js so Vercel can import it too.)
const fs = require('fs');
const path = require('path');

// Load a .env file from the project root (KEY=VALUE lines) so local runs
// don't need shell-specific env-var syntax. Must happen before ./index is
// required because the database pool reads DATABASE_URL at load time.
// Only the known keys below are honoured — a stray .env can never inject
// arbitrary environment entries.
const ENV_KEYS = [
  'DATABASE_URL',
  'DATABASE_DIRECT_URL',
  'DATABASE_POOL_MAX',
  'INVOICE_SHARE_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'SENTRY_DSN',
  'CRON_SECRET',
];
function readDotEnv() {
  const values = {};
  ENV_KEYS.forEach((k) => { values[k] = null; });
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return values;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    for (const k of ENV_KEYS) {
      if (t.startsWith(k + '=')) values[k] = t.slice(k.length + 1);
    }
  }
  return values;
}
const localEnv = readDotEnv();
for (const k of ENV_KEYS) {
  if (localEnv[k] && process.env[k] === undefined) process.env[k] = localEnv[k];
}

const express = require('express');
const app = require('./index');

// In local dev, serve the built client from the same port (mirrors what the
// Vercel static build does in production). Requires `npm run setup:client`
// to have produced client/dist.
const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(dist, 'index.html'));
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('');
  console.log('  💊 MediStock is running!');
  console.log(`  ➜  Open http://localhost:${PORT} in your browser`);
  console.log('  ➜  Demo logins ->  owner / owner123   |   staff / staff123');
  console.log('');
});
