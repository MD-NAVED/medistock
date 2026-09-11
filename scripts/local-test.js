/**
 * Local end-to-end verification against an embedded PostgreSQL.
 *
 * Spins up a throwaway Postgres cluster (via embedded-postgres), loads
 * scripts/init-supabase.sql, starts server/dev.js, and runs the three
 * HTTP test suites in server/. The audit suite is run in phase1 ->
 * restart server -> phase2 so the DB-backed-session test can pass.
 *
 * Usage: node scripts/local-test.js
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const EmbeddedPostgres = require('embedded-postgres').default;
const { Client } = require('pg');
const { migrate } = require('postgres-migrations');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, '.local-pg');
const MIGRATION_STAGE = path.join(ROOT, '.local-pg-migrations');
const PORT = process.env.TEST_PG_PORT || 5433;
const APP_PORT = 3111;
const BASE = `http://localhost:${APP_PORT}`;
const DB_URL = `postgres://postgres:postgres@localhost:${PORT}/medistock`;

function log(msg) { console.log(`[local-test] ${msg}`); }

function run(label, args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, {
      cwd: path.join(ROOT, 'server'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('close', (code) => resolve({ code, out }));
    log(label);
  });
}

async function waitForServer(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${BASE}/api/medicines`);
      if (r.status === 401 || r.status === 200) return true; // up & auth-gating
    } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  log(`starting embedded postgres on port ${PORT}`);
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
  log('postgres up, loading init-supabase.sql');

  // Stage the schema file as a numbered migration (postgres-migrations loads
  // only .sql/.js files with sequential names from a directory).
  fs.rmSync(MIGRATION_STAGE, { recursive: true, force: true });
  fs.mkdirSync(MIGRATION_STAGE, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'scripts', 'init-supabase.sql'), path.join(MIGRATION_STAGE, '1_init.sql'));

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await migrate({ client }, MIGRATION_STAGE);
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM medicines');
  log(`schema loaded, medicines seeded: ${rows[0].n}`);
  await client.end();

  const serverEnv = {
    DATABASE_URL: DB_URL,
    PORT: String(APP_PORT),
    INVOICE_SHARE_SECRET: 'test-invoice-share-secret-980c28e674c3aae73a6fcbe39ab1e3b',
  };
  let serverProc = null;

  const startServer = async () => {
    serverProc = spawn(process.execPath, ['dev.js'], {
      cwd: path.join(ROOT, 'server'),
      env: { ...process.env, ...serverEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
    const ok = await waitForServer(20000);
    if (!ok) throw new Error('server did not come up');
    log(`server up on ${BASE}`);
  };
  const stopServer = () => new Promise((resolve) => {
    if (!serverProc) return resolve();
    serverProc.on('close', resolve);
    serverProc.kill();
  });

  await startServer();

  const results = {};
  results['test-api'] = await run('running test-api.js', ['test-api.js'], { BASE });
  results['test-edit-purchase'] = await run('running test-edit-purchase.js', ['test-edit-purchase.js'], { BASE });
  results['test-audit phase1'] = await run('running test-audit.js phase1', ['test-audit.js'], { BASE, AUDIT_MODE: 'phase1' });

  // restart in between so the DB-session-survives-restart check can run
  await stopServer();
  await startServer();

  const m = results['test-audit phase1'].out.match(/RESTART_TOKEN=(\S+)/);
  if (!m) {
    results['test-audit phase2'] = { code: 1, out: 'could not find RESTART_TOKEN in phase1 output' };
  } else {
    results['test-audit phase2'] = await run('running test-audit.js phase2', ['test-audit.js'], {
      BASE, AUDIT_MODE: 'phase2', RESTART_TOKEN: m[1],
    });
  }

  await stopServer();
  await pg.stop();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.rmSync(MIGRATION_STAGE, { recursive: true, force: true });

  let failed = false;
  for (const [name, r] of Object.entries(results)) {
    console.log(`\n===== ${name}: exit ${r.code} =====`);
    console.log(r.out.trim());
    // Judge by the suites' own "N passed, M failed" summaries — on Windows a
    // Node libuv assertion at process exit can turn a fully-passing run into a
    // nonzero exit code.
    const m2 = [...r.out.matchAll(/(\d+) passed, (\d+) failed/g)].pop();
    const failedCount = m2 ? Number(m2[2]) : (r.code !== 0 ? 1 : 0);
    if (failedCount > 0) failed = true;
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('[local-test] crashed:', e);
  process.exit(1);
});
