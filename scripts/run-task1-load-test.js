/**
 * Runner for Task 1 Load Test against embedded Postgres.
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const EmbeddedPostgres = require('embedded-postgres').default;
const { Client } = require('pg');
const { migrate } = require('postgres-migrations');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.local-pg-loadtest');
const MIGRATION_STAGE = path.join(ROOT, '.local-pg-migrations-loadtest');
const PORT = 5434;
const APP_PORT = 3112;
const DB_URL = `postgres://postgres:postgres@localhost:${PORT}/medistock`;

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  console.log(`[LoadTest] Starting embedded postgres on port ${PORT}...`);
  const pg = new EmbeddedPostgres({
    databaseDir: DATA_DIR,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: true,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => {},
    onError: (e) => console.error('[pg]', e.message || e),
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('medistock');

  fs.rmSync(MIGRATION_STAGE, { recursive: true, force: true });
  fs.mkdirSync(MIGRATION_STAGE, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'init-supabase.sql'), path.join(MIGRATION_STAGE, '1_init.sql'));

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await migrate({ client }, MIGRATION_STAGE);
  await client.end();
  console.log('[LoadTest] Database initialized.');

  const serverProc = spawn(process.execPath, ['dev.js'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      DATABASE_URL: DB_URL,
      DATABASE_DIRECT_URL: DB_URL,
      DATABASE_POOL_MAX: '1',
      PORT: String(APP_PORT),
      INVOICE_SHARE_SECRET: 'test-invoice-share-secret-980c28e674c3aae73a6fcbe39ab1e3b',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // wait for server
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://localhost:${APP_PORT}/api/health`);
      if (r.status === 200) { up = true; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }

  if (!up) {
    serverProc.kill();
    await pg.stop();
    console.error('Server failed to start');
    process.exit(1);
  }
  console.log(`[LoadTest] Server is live on http://localhost:${APP_PORT}. Starting load test...`);

  const testProc = spawn(process.execPath, [path.join(ROOT, 'scripts', 'load-test-task1.js')], {
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      DATABASE_DIRECT_URL: DB_URL,
    },
    stdio: 'inherit',
  });

  testProc.on('close', async (code) => {
    serverProc.kill();
    await pg.stop();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    fs.rmSync(MIGRATION_STAGE, { recursive: true, force: true });
    process.exit(code);
  });
})();
