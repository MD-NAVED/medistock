// One-off migration: add the medicine logo column to the live database.
// Safe to re-run — uses IF NOT EXISTS.
const { pool } = require('../server/db');

(async () => {
  await pool.query('ALTER TABLE medicines ADD COLUMN IF NOT EXISTS logo_url TEXT');
  console.log('logo_url column is present');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});