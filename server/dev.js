// Local development entry — starts the Express server on a plain port.
// (The app itself is exported from index.js so Vercel can import it too.)
const fs = require('fs');
const path = require('path');

// Load a .env file from the project root (KEY=VALUE lines) so local runs
// don't need shell-specific env-var syntax. Must happen before ./index is
// required because the database pool reads DATABASE_URL at load time.
// Only the two known keys below are honoured — a stray .env can never inject
// arbitrary environment entries.
function readDotEnv() {
  const values = { DATABASE_URL: null, DATABASE_POOL_MAX: null };
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return values;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('DATABASE_URL=')) values.DATABASE_URL = t.slice('DATABASE_URL='.length);
    if (t.startsWith('DATABASE_POOL_MAX=')) values.DATABASE_POOL_MAX = t.slice('DATABASE_POOL_MAX='.length);
  }
  return values;
}
const localEnv = readDotEnv();
if (localEnv.DATABASE_URL && process.env.DATABASE_URL === undefined) {
  process.env.DATABASE_URL = localEnv.DATABASE_URL;
}
if (localEnv.DATABASE_POOL_MAX && process.env.DATABASE_POOL_MAX === undefined) {
  process.env.DATABASE_POOL_MAX = localEnv.DATABASE_POOL_MAX;
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
