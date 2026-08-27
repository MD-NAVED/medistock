// Bulk seed: add ~400 more global pharma companies to the brand-logo directory.
// Idempotent — uses ON CONFLICT (slug) DO NOTHING so re-running is safe.
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
  // ---- Global majors (not yet in directory) ----
  ['AbbVie', '', 'abbvie.com'],
  ['Amgen', '', 'amgen.com'],
  ['Bristol Myers Squibb', 'bms,bristol-myers', 'bms.com'],
  ['Gilead Sciences', 'gilead', 'gilead.com'],
  ['Roche', '', 'roche.com'],
  ['Novo Nordisk', ',novo', 'novonordisk.com'],
  ['Takeda', 'takeda pharmaceuticals', 'takeda.com'],
  ['Astellas', 'astellas pharma', 'astellas.com'],
  ['Daiichi Sankyo', 'daiichi-sankyo', 'daiichisankyo.com'],
  ['Otsuka', 'otsuka pharmaceutical', 'otsuka.com'],
  ['Eisai', '', 'eisai.com'],
  ['Vertex Pharmaceuticals', 'vertex', 'vrtx.com'],
  ['Regeneron', 'regeneron pharmaceuticals', 'regeneron.com'],
  ['Biogen', 'biogen idec', 'biogen.com'],
  ['Moderna', '', 'modernatx.com'],
  ['Teva', 'teva pharmaceuticals', 'tevapharm.com'],
  ['Sandoz', '', 'sandoz.com'],
  ['Viatris', 'mylan', 'viatris.com'],
  ['Fresenius Kabi', 'fresenius', 'fresenius-kabi.com'],
  ['Grifols', '', 'grifols.com'],
  ['CSL Behring', 'csl', 'cslbehring.com'],
  ['UCB', 'ucb pharma', 'ucb.com'],
  ['Menarini', 'a. menarini', 'menarini.com'],
  ['Chiesi', 'chiesi farmaceutici', 'chiesi.com'],
  ['Servier', 'les laboratoires servier', 'servier.com'],
  ['Ipsen', '', 'ipsen.com'],
  ['Lundbeck', 'h. lundbeck', 'lundbeck.com'],
  ['LEO Pharma', 'leo', 'leo-pharma.com'],
  ['Orion Pharma', 'orion', 'orionpharma.com'],
  ['Hikma', 'hikma pharmaceuticals', 'hikma.com'],
  ['STADA', 'stada arzneimittel', 'stada.com'],
  ['Grünenthal', 'grunenthal', 'gruenenthal.com'],
  ['Pierre Fabre', 'pierre fabre medicament', 'pierre-fabre.com'],
  ['Recordati', '', 'recordati.com'],
  ['Zambon', '', 'zambon.com'],
  ['Almirall', '', 'almirall.com'],
  ['Esteve', 'laboratorios esteve', 'esteve.com'],
  ['Ferrer', 'grupo ferrer', 'ferrer.com'],
  ['B. Braun', 'braun,b.braun', 'bbraun.com'],
  ['Gedeon Richter', 'gedeon richter plc', 'gedeonrichter.com'],
  ['Krka', '', 'krka.biz'],
  ['Polpharma', '', 'polpharma.com'],
  ['Sino Biopharmaceutical', 'sinopharm', 'sinobiopharm.com'],

  // ---- India (additional) ----
  ['Strides Pharma', 'strides', 'strides.com'],
  ['Shilpa Medicare', 'shilpa', 'shilpamedicare.com'],
  ['Hetero', 'hetero drugs,hetero healthcare', 'heterohealthcare.com'],
  ['JB Chemicals', 'jb chemicals & pharmaceuticals,jbcpl', 'jbcpl.com'],
  ['Akums Drugs', 'akums', 'akums.in'],
  ['Aarti Drugs', 'aarti', 'aartidrugs.com'],
  ['Bharat Serums and Vaccines', 'bharat serums,bsv', 'bharatserums.com'],
  ['Biological E', 'biological evans,biological e limited', 'biologicale.com'],
  ['Centaur Pharmaceuticals', 'centaur', 'centaurpharma.com'],
  ['Corona Remedies', 'corona', 'coronaremedies.com'],
  ['Elder Pharmaceuticals', 'elder', 'elderindia.com'],
  ['Encore Healthcare', 'encore', 'encorehealthcare.com'],
  ['Entod Pharmaceuticals', 'entod', 'entodpharma.com'],
  ['Fourrts India', 'fourrts', 'fourrts.com'],
  ['Geno Pharmaceuticals', 'geno', 'genopharma.com'],
  ['Ind-Swift', 'ind swift', 'indswift.com'],
  ['Indchemie', 'indchemie health specialities', 'indchemie.com'],
  ['Jagdale Industries', 'jagdale', 'jagdaleindustries.com'],
  ['Jenburkt Pharmaceuticals', 'jenburkt', 'jenburkt.com'],
  ['Kopran', '', 'kopran.com'],
  ['Lincoln Pharmaceuticals', 'lincoln', 'lincolnpharma.com'],
  ['Maneesh Pharmaceuticals', 'maneesh', 'maneeshpharma.com'],
  ['Medley Pharmaceuticals', 'medley', 'medleylabs.com'],
  ['Meghmani', 'meghmani organics', 'meghmaniglobal.com'],
  ['Nectar Lifesciences', 'nectar', 'nectarlifesciences.com'],
  ['RPG Life Sciences', 'rpg', 'rpglifesciences.com'],
  ['Themis Medicare', 'themis', 'themismedicare.com'],
  ['Troikaa Pharmaceuticals', 'troikaa', 'troikaa.com'],
  ['Unimark Remedies', 'unimark', 'unimarkremedies.com'],
  ['Zota Health Care', 'zota', 'zotahealthcare.com'],
  ['Blue Cross Laboratories', 'blue cross', 'bluecrosslabs.com'],
  ['Anthem Biosciences', 'anthem', 'anthembio.com'],
  ['Apex Laboratories', 'apex labs', 'apexlabs.in'],
  ['Biopharm', 'biopharm industries', 'biopharmindia.com'],
  ['Cadila Pharma', 'cadila', 'cadilapharma.com'],
  ['Galpha Laboratories', 'galpha', 'galphalabs.com'],
  ['Indchemie', 'indchemie', 'indchemie.com'],
  ['Jenburkt', 'jenburkt pharmaceuticals', 'jenburkt.com'],
  ['Ordain Health Care', 'ordain', 'ordainhealthcare.com'],
  ['Paras Biopharma', 'paras', 'parasbiopharma.com'],
  ['Pulse Pharmaceuticals', 'pulse', 'pulsepharma.com'],
  ['Sanify Healthcare', 'sanify', 'sanifyhealthcare.com'],
  ['Schutz Bio', 'schutz', 'schutzbio.com'],
  ['Somatico', '', 'somatico.in'],
  ['Spinco Biotech', 'spinco', 'spincobiotech.com'],
  ['Syngene', 'syngene international', 'syngeneintl.com'],
  ['Tasmed', '', 'tasmedlab.com'],
  ['Win-Medicare', 'winmedicare', 'winmedicare.com'],
  ['Zandu', 'zandu pharmaceuticals', 'zanduayurveda.com'],
  ['Charak Pharma', 'charak', 'charak.com'],
  ['SBL', 'sbl homeopathy', 'sblglobal.in'],
  ['Dr. Willmar Schwabe India', 'schwabe', 'schwabeindia.com'],

  // ---- Japan ----
  ['Chugai Pharmaceutical', 'chugai', 'chugai-pharm.co.jp'],
  ['Kyowa Kirin', 'kyowa', 'kyowakirin.com'],
  ['Sumitomo Pharma', 'sumitomo dainippon', 'sumitomo-pharma.com'],
  ['Mitsubishi Tanabe Pharma', 'mitsubishi tanabe', 'mt-pharma.co.jp'],
  ['Shionogi', '', 'shionogi.com'],
  ['Ono Pharmaceutical', 'ono', 'ono-pharma.com'],
  ['Nippon Shinyaku', '', 'nippon-shinyaku.co.jp'],
  ['Kowa Company', 'kowa', 'kowa.co.jp'],
  ['Hisamitsu Pharmaceutical', 'hisamitsu', 'hisamitsu.co.jp'],
  ['Santen Pharmaceutical', 'santen', 'santen.com'],
  ['Rohto Pharmaceutical', 'rohto', 'rohto.co.jp'],
  ['Taisho Pharmaceutical', 'taisho', 'taisho.co.jp'],
  ['Kobayashi Pharmaceutical', 'kobayashi', 'kobayashi.co.jp'],
  ['Towa Pharmaceutical', 'towa', 'towayakuhin.co.jp'],
  ['Sawai Pharmaceutical', 'sawai', 'sawai.co.jp'],
  ['Nichi-Iko Pharmaceutical', 'nichi-iko', 'nichiiko.co.jp'],
  ['Meiji Seika Pharma', 'meiji', 'meiji-seika-pharma.co.jp'],
  ['Zeria Pharmaceutical', 'zeria', 'zeria.co.jp'],
  ['Mochida Pharmaceutical', 'mochida', 'mochida.co.jp'],

  // ---- China ----
  ['Sinopharm', 'sinopharm group', 'sinopharm.com'],
  ['Shanghai Pharmaceuticals', 'shanghai pharma,sph', 'sphchina.com'],
  ['CSPC Pharmaceutical Group', 'cspc', 'cspc.com.hk'],
  ['Jiangsu Hengrui Medicine', 'hengrui', 'hengrui.com'],
  ['Fosun Pharma', 'fosun pharmaceutical', 'fosunpharma.com'],
  ['BeiGene', 'beigene', 'beigene.com'],
  ['Innovent Biologics', 'innovent', 'innoventbio.com'],
  ['China Resources Pharma', 'cr pharma', 'crpharm.com'],
  ['Guangzhou Baiyunshan', 'baiyunshan', 'gybys.com.cn'],
  ['Harbin Pharmaceutical', 'harbin pharma,hayao', 'hayao.com'],
  ['Luoxin Pharmaceutical', 'luoxin', 'luoxin.cn'],
  ['Kelun Pharmaceutical', 'kelun', 'kelun.com'],
  ['Livzon Pharmaceutical', 'livzon', 'livzon.com.cn'],
  ['Zhejiang Hisun Pharmaceutical', 'hisun', 'hisunpharm.com'],
  ['Sihuan Pharmaceutical', 'sihuan', 'sihuanpharm.com'],
  ['3SBio', '3sbio', '3sbio.com'],
  ['Changchun High-Tech', 'changchun high tech', 'cytech.com.cn'],
  ['Yunnan Baiyao', 'yunnan baiyao group', 'yunnanbaiyao.com.cn'],
  ['Hansoh Pharma', 'hansoh', 'hansoh.cn'],

  // ---- South Korea ----
  ['Hanmi Pharmaceutical', 'hanmi', 'hanmi.co.kr'],
  ['Celltrion', '', 'celltrion.com'],
  ['Samsung Bioepis', 'samsung bioepis co', 'samsungbioepis.com'],
  ['LG Chem', 'lg chem life sciences', 'lgchem.com'],
  ['Chong Kun Dang Pharmaceutical', 'chong kun dang,ckd', 'ckdpharm.com'],
  ['Daewoong Pharmaceutical', 'daewoong', 'daewoong.co.kr'],
  ['Dong-A ST', 'dong a,dong-a pharmaceutical', 'dong-a.co.kr'],
  ['Yuhan Corporation', 'yuhan', 'yuhan.co.kr'],
  ['GC Pharma', 'green cross', 'gcpharma.co.kr'],
  ['SK Bioscience', 'sk bioscience', 'skbioscience.com'],
  ['Boryung', 'boryung pharmaceutical', 'boryung.co.kr'],
  ['Ilsung Pharmaceuticals', 'ilsung', 'ilsungpharm.co.kr'],
  ['Kolon Life Science', 'kolon', 'kolonls.co.kr'],

  // ---- Other Asia ----
  ['Getz Pharma', 'getz', 'getzpharma.com'],
  ['Hilton Pharma', 'hilton', 'hiltonpharma.com'],
  ['Highnoon Laboratories', 'highnoon', 'highnoon.com'],
  ['Ferozsons Laboratories', 'ferozsons', 'ferozsons.com'],
  ['Square Pharmaceuticals', 'square pharma', 'squarepharma.com.bd'],
  ['Beximco Pharmaceuticals', 'beximco', 'beximcopharma.com'],
  ['Incepta Pharmaceuticals', 'incepta', 'inceptapharma.com'],
  ['Renata Limited', 'renata', 'renata-ltd.com'],
  ['Pharmaniaga', '', 'pharmaniaga.com'],
  ['Kalbe Farma', 'kalbe', 'kalbe.co.id'],
  ['Kimia Farma', '', 'kimiafarma.co.id'],
  ['United Laboratories', 'unilab', 'unilab.com.ph'],
  ['Traphaco', '', 'traphaco.com.vn'],
  ['DHG Pharma', 'dhg pharmaceutical', 'dhgpharma.com.vn'],
  ['Hemas Pharmaceuticals', 'hemas', 'hemas.com'],

  // ---- Middle East ----
  ['Julphar', 'gulf pharmaceutical industries', 'julphar.net'],
  ['Neopharma', 'neopharma llc', 'neopharma.com'],
  ['Tabuk Pharmaceuticals', 'tabuk', 'tabukpharmaceuticals.com'],
  ['SPIMACO', 'saudi pharmaceutical industries', 'spimaco.com.sa'],
  ['Jamjoom Pharma', 'jamjoom', 'jamjoompharma.com'],
  ['Riyadh Pharma', 'riyadh pharmaceutical', 'riyadhpharma.com'],
  ['MS Pharma', 'm.s. pharma', 'ms-pharma.com'],
  ['Pharma International', 'pharma international jordan', 'pharma-int.com'],

  // ---- Latin America ----
  ['Eurofarma', '', 'eurofarma.com.br'],
  ['EMS Pharma', 'ems', 'ems.com.br'],
  ['Aché Laboratórios', 'ache', 'ache.com.br'],
  ['Biolab Farmacêutica', 'biolab', 'biolabfarma.com.br'],
  ['Libbs Farmacêutica', 'libbs', 'libbs.com.br'],
  ['Genomma Lab', 'genomma laboratorios', 'genommalab.com'],
  ['Liomont', 'laboratorios liomont', 'liomont.com.mx'],
  ['Laboratorios Bagó', 'bago', 'bago.com.ar'],
  ['Roemmers', 'laboratorios roemmers', 'roemmers.com.ar'],
  ['Gador', 'laboratorios gador', 'gador.com.ar'],
  ['Procaps', 'procaps group', 'procaps.com.co'],

  // ---- Russia / CIS ----
  ['Pharmstandard', 'pharmstandard group', 'pharmstd.ru'],
  ['R-Pharm', 'r pharm', 'r-pharm.com'],
  ['Biocad', 'biocad biotechnology', 'biocadglobal.com'],
  ['Ozon Pharmaceuticals', 'ozon pharm', 'ozonpharm.ru'],
  ['Geropharm', 'geropharm bio', 'geropharm.com'],

  // ---- Africa ----
  ['Aspen Pharmacare', 'aspen', 'aspenpharma.com'],
  ['Adcock Ingram', 'adcock', 'adcock.co.za'],
  ['Cipla Medpro', 'cipla medpro south africa', 'cipla.co.za'],

  // ---- More USA generics ----
  ['Par Pharmaceutical', 'par pharma', 'parpharm.com'],
  ['Perrigo', 'perrigo company', 'perrigo.com'],
  ['Endo International', 'endo pharmaceuticals', 'endo.com'],
  ['Lannett', 'lannett company', 'lannett.com'],
  ['Mallinckrodt', 'mallinckrodt pharmaceuticals', 'mallinckrodt.com'],
  ['Akorn Pharmaceuticals', 'akorn', 'akorn.com'],
  ['Horizon Therapeutics', 'horizon', 'horizontherapeutics.com'],
  ['Jazz Pharmaceuticals', 'jazz', 'jazzpharma.com'],
  ['Incyte', 'incyte corporation', 'incyte.com'],
  ['BioMarin', 'biomarin pharmaceutical', 'biomarin.com'],
  ['Alexion Pharmaceuticals', 'alexion', 'alexion.com'],
  ['Alcon', 'alcon laboratories', 'alcon.com'],
  ['Bausch Health', 'bausch,valeant', 'bauschhealth.com'],
  ['Eli Lilly', 'lilly', 'lilly.com'],

  // ---- More Europe ----
  ['Gedeon Richter', 'gedeon richter', 'gedeonrichter.com'],
  ['Laboratorios Farmacéuticos Rovi', 'rovi', 'rovi.es'],
  ['Italfarmaco', '', 'italfarmaco.com'],
  ['Bracco', 'bracco imaging', 'bracco.com'],
  ['Dompé', 'dompe farmaceutici', 'dompe.com'],
  ['Medac', 'medac gmbh', 'medac.de'],
  ['Glenmark', 'glenmark pharmaceuticals', 'glenmarkpharma.com'],
  ['Norbrook Laboratories', 'norbrook', 'norbrook.com'],
  ['Dechra Pharmaceuticals', 'dechra', 'dechra.com'],
  ['Virbac', 'virbac sa', 'virbac.com'],
  ['Elanco', 'elanco animal health', 'elanco.com'],
  ['Zoetis', 'zoetis inc', 'zoetis.com'],
  ['Boehringer Ingelheim Animal Health', 'bi animal health', 'boehringer-ingelheim.com'],

  // ---- Additional global generics / injectables ----
  ['Claris Lifesciences', 'claris', 'clarislifesciences.com'],
  ['Panacea Biotec', 'panacea', 'panaceabiotec.com'],
  ['Alembic Pharmaceuticals', 'alembic', 'alembicpharmaceuticals.com'],
  ['Wockhardt', '', 'wockhardt.com'],
  ['Macleods Pharmaceuticals', 'macleods', 'macleodspharma.com'],
  ['Ipca Laboratories', 'ipca', 'ipca.com'],
  ['Ajanta Pharma', 'ajanta', 'ajantapharma.com'],

  // ---- OTC / consumer health ----
  ['Reckitt Benckiser', 'reckitt', 'reckitt.com'],
  ['Haleon', 'haleon plc', 'haleon.com'],
  ['Johnson & Johnson', 'j&j,jnj', 'jnj.com'],
  ['Procter & Gamble', 'p&g,pg', 'pg.com'],
  ['Unilever', 'unilever plc', 'unilever.com'],
  ['Colgate-Palmolive', 'colgate', 'colgate.com'],
  ['Nestlé Health Science', 'nestle', 'nestlehealthscience.com'],
  ['Abbott Nutrition', 'abbott', 'abbott.com'],
  ['Dabur', '', 'dabur.com'],
  ['Himalaya Wellness', 'himalaya', 'himalayawellness.in'],
  ['Zandu', 'zandu', 'zanduayurveda.com'],
  ['Baidyanath', 'shree baidyanath', 'baidyanath.com'],
  ['Dabur India', 'dabur', 'dabur.com'],
  ['Patanjali Ayurved', 'patanjali', 'patanjaliayurved.net'],
  ['Emami', 'emami limited', 'emamiltd.in'],
  ['Hamdard', 'hamdard laboratories', 'hamdard.in'],
  ['Siddhayu', 'siddhayu ayurved', 'siddhayu.com'],

  // ---- Nutraceuticals / supplements ----
  ['Amway', 'amway corporation', 'amway.com'],
  ['Herbalife', 'herbalife nutrition', 'herbalife.com'],
  ['Nature\'s Bounty', 'natures bounty', 'naturesbounty.com'],
  ['GNC', 'gnc holdings', 'gnc.com'],
  ['Optimum Nutrition', 'on,optimum', 'optimumnutrition.com'],

  // ---- Diagnostics / medical devices ----
  ['Roche Diagnostics', 'roche', 'roche.com'],
  ['Siemens Healthineers', 'siemens', 'siemens-healthineers.com'],
  ['Abbott Diagnostics', 'abbott', 'abbott.com'],
  ['Beckman Coulter', 'beckman', 'beckman.com'],
  ['Bio-Rad', 'bio rad laboratories', 'bio-rad.com'],
  ['Thermo Fisher Scientific', 'thermo fisher', 'thermofisher.com'],
  ['Danaher', 'danaher corporation', 'danaher.com'],
  ['Becton Dickinson', 'bd,becton dickinson', 'bd.com'],
  ['Medtronic', 'medtronic plc', 'medtronic.com'],
  ['Stryker', 'stryker corporation', 'stryker.com'],
  ['Johnson & Johnson MedTech', 'j&j', 'jnj.com'],
  ['Getinge', 'getinge ab', 'getinge.com'],
  ['3M Health Care', '3m', '3m.com'],
  ['Cardinal Health', 'cardinal', 'cardinalhealth.com'],
  ['McKesson', 'mckesson corporation', 'mckesson.com'],
  ['Cencora', 'amerisourcebergen', 'cencora.com'],
];

(async () => {
  // Build one multi-row INSERT so the whole seed commits atomically and fast.
  const values = [];
  const params = [];
  const seen = new Set();
  for (const [name, aliases, domain] of COMPANIES) {
    const slug = slugify(name);
    if (!slug || seen.has(slug)) continue; // skip in-process duplicates
    seen.add(slug);
    params.push(name, slug, aliases, favicon(domain));
    const i = params.length;
    values.push('($' + (i - 3) + ', $' + (i - 2) + ', $' + (i - 1) + ', $' + i + ')');
  }

  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM companies')).rows[0].n;
  const res = await pool.query(
    'INSERT INTO companies (name, slug, aliases, logo_url) VALUES ' + values.join(', ') + ' ON CONFLICT (slug) DO NOTHING',
    params
  );
  const after = (await pool.query('SELECT COUNT(*)::int AS n FROM companies')).rows[0].n;
  console.log('Added ' + (after - before) + ' new companies. Total directory: ' + after);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});