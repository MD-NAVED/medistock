// One-off migration: create the `companies` brand-logo directory and seed it.
// Safe to re-run — table uses IF NOT EXISTS and inserts use ON CONFLICT DO NOTHING.
const { pool } = require('../server/db');

const slugify = (s) => String(s || '')
  .toLowerCase()
  .replace(/&/g, ' ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/\s+/g, '-');

const favicon = (domain) => 'https://www.google.com/s2/favicons?domain_url=https://' + domain + '&sz=128';

// [name, aliases(comma-separated), domain]
const COMPANIES = [
  ['Micro Labs', 'microlab', 'www.microlabsltd.com'],
  ['GSK', 'glaxosmithkline,glaxo smithkline', 'www.gsk.com'],
  ['Cipla', '', 'www.cipla.com'],
  ['Alembic', 'alembic pharmaceuticals', 'www.alembicpharmaceuticals.com'],
  ['Aristo', 'aristo pharmaceuticals', 'www.aristopharma.com'],
  ['Torrent', 'torrent pharmaceuticals', 'www.torrentpharma.com'],
  ['Glenmark', 'glenmark pharmaceuticals', 'www.glenmarkpharma.com'],
  ['USV', 'usv pvt,usv private', 'www.usvindia.com'],
  ['Abbott', '', 'www.abbott.com'],
  ['FDC', 'fdc limited', 'www.fdcindia.com'],
  ['Reckitt', 'reckitt benckiser', 'www.reckitt.com'],
  ['Sun Pharma', 'sun pharmaceutical,sun', 'www.sunpharma.com'],
  ['Biocon', '', 'www.biocon.com'],
  ['Baxter', 'baxalta', 'www.baxter.com'],
  ["Dr. Reddy's Laboratories", 'dr reddy,dr reddys', 'www.drreddys.com'],
  ['Lupin', 'lupin limited', 'www.lupin.com'],
  ['Aurobindo Pharma', '', 'www.aurobindo.com'],
  ['Zydus Lifesciences', 'zydus,cadila healthcare', 'www.zyduslife.com'],
  ['Alkem Laboratories', 'alkem', 'www.alkemlabs.com'],
  ['Mankind Pharma', 'mankind', 'www.mankindpharma.com'],
  ['Intas Pharmaceuticals', 'intas', 'www.intaspharma.com'],
  ['Cadila Pharmaceuticals', 'cadila', 'www.cadilapharma.com'],
  ['Wockhardt', '', 'www.wockhardt.com'],
  ['Emcure Pharmaceuticals', 'emcure', 'www.emcure.com'],
  ['Ipca Laboratories', 'ipca', 'www.ipca.com'],
  ['Ajanta Pharma', 'ajanta', 'www.ajantapharma.com'],
  ['Eris Lifesciences', 'eris', 'www.eris.co.in'],
  ['Macleods Pharmaceuticals', 'macleods', 'www.macleodspharma.com'],
  ['Indoco Remedies', 'indoco', 'www.indoco.com'],
  ['Unichem Laboratories', 'unichem', 'www.unichemlabs.com'],
  ['Natco Pharma', 'natco', 'www.natcopharma.co.in'],
  ['Laurus Labs', 'laurus', 'www.lauruslabs.com'],
  ['Divis Laboratories', 'divis', 'www.divislabs.com'],
  ['Granules India', 'granules', 'www.granulesindia.com'],
  ['Morepen Laboratories', 'morepen', 'www.morepen.com'],
  ['Himalaya Wellness', 'himalaya,himalaya herbal', 'www.himalayawellness.in'],
  ['Dabur', '', 'www.dabur.com'],
  ['Serum Institute of India', 'serum', 'www.seruminstitute.com'],
  ['Panacea Biotec', 'panacea', 'www.panaceabiotec.com'],
  ['Johnson & Johnson', 'j&j,jnj', 'www.jnj.com'],
  ['Pfizer', '', 'www.pfizer.com'],
  ['Novartis', '', 'www.novartis.com'],
  ['Sanofi', '', 'www.sanofi.com'],
  ['Merck', '', 'www.merckgroup.com'],
  ['AstraZeneca', '', 'www.astrazeneca.com'],
  ['Eli Lilly', 'lilly', 'www.lilly.com'],
  ['Boehringer Ingelheim', '', 'www.boehringer-ingelheim.com'],
  ['Bayer', '', 'www.bayer.com'],
];

(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      slug       TEXT NOT NULL UNIQUE,
      aliases    TEXT NOT NULL DEFAULT '',
      logo_url   TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);

  for (const [name, aliases, domain] of COMPANIES) {
    await pool.query(
      'INSERT INTO companies (name, slug, aliases, logo_url) VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING',
      [name, slugify(name), aliases, favicon(domain)]
    );
  }

  const count = (await pool.query('SELECT COUNT(*)::int AS n FROM companies')).rows[0].n;
  console.log('companies directory ready (' + count + ' rows)');

  // Back-fill existing medicines (added before this feature) with their company logo.
  const { rows: meds } = await pool.query('SELECT id, company FROM medicines WHERE logo_url IS NULL');
  const { rows: comps } = await pool.query('SELECT name, aliases, logo_url FROM companies');
  const resolve = (company) => {
    const key = slugify(company);
    if (!key) return null;
    for (const c of comps) {
      const keys = [c.name, ...String(c.aliases || '').split(',')].map(slugify).filter(Boolean);
      if (keys.includes(key)) return c.logo_url || null;
    }
    return null;
  };
  let backfilled = 0;
  for (const m of meds) {
    const logo = resolve(m.company);
    if (logo) {
      await pool.query('UPDATE medicines SET logo_url = $1 WHERE id = $2', [logo, m.id]);
      backfilled++;
    }
  }
  console.log('back-filled ' + backfilled + ' medicines with company logos');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});