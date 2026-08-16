const fs = require('fs');
const path = require('path');
const { db } = require('./db');

const DATA_DIR = path.join(__dirname, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const KEEP_BACKUPS = 30;

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Writes a consistent copy of the database using SQLite's own VACUUM INTO,
 * which is safe while the server is running (unlike copying the file).
 */
function createBackup(label = 'auto') {
  const file = path.join(BACKUP_DIR, `medistock_${label}_${stamp()}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  pruneOldBackups();
  const { size } = fs.statSync(file);
  return { file, size };
}

function pruneOldBackups() {
  const files = fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({ f, t: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of files.slice(KEEP_BACKUPS)) {
    try { fs.unlinkSync(path.join(BACKUP_DIR, old.f)); } catch { /* ignore */ }
  }
}

function listBackups() {
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { name: f, size: st.size, created_at: new Date(st.mtimeMs).toISOString() };
    })
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

/** Backup on boot, then once every 6 hours while the server runs. */
function startAutoBackup() {
  const run = (label) => {
    try {
      const { file, size } = createBackup(label);
      console.log(`  🛟 Backup saved: ${path.basename(file)} (${Math.round(size / 1024)} KB)`);
    } catch (e) {
      console.error('  ⚠️  Backup failed:', e.message);
    }
  };
  run('startup');
  setInterval(() => run('auto'), 6 * 60 * 60 * 1000).unref();
}

module.exports = { createBackup, listBackups, startAutoBackup, BACKUP_DIR };
