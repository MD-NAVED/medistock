/**
 * Smoke test for Purchases page and MobileReviewList component rendering.
 * Renders Purchases with:
 *  1. Empty items array ([])
 *  2. 30 mock items (mixed valid and invalid)
 *  3. 30 all-valid items
 * Asserts:
 *  - No crash / ReferenceError on render
 *  - countValid correctly reflects verified count
 *  - Save button text reflects "(x/30 verified)"
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('../client/node_modules/esbuild');

console.log('=== Running Purchases & MobileReviewList Render Smoke Test ===');

const runnerSrc = `
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const assert = require('assert');

const origWarn = console.warn;
console.warn = (...args) => {
  if (args[0] && typeof args[0] === 'string' && args[0].includes('useLayoutEffect')) return;
  origWarn(...args);
};
const { MemoryRouter } = require('react-router-dom');
const createCache = require('@emotion/cache').default || require('@emotion/cache');
const { CacheProvider } = require('@emotion/react');

const cache = createCache({ key: 'css', prepend: true });

function TestWrapper({ children }) {
  return React.createElement(MemoryRouter, null,
    React.createElement(CacheProvider, { value: cache }, children)
  );
}

// Mock browser globals for SSR render test
global.navigator = { userAgent: 'Mozilla/5.0 (Node.js)' };
global.window = {
  location: { pathname: '/purchases', search: '', hash: '' },
  navigator: global.navigator,
  matchMedia: () => ({ matches: true, addListener: () => {}, removeListener: () => {} })
};
global.localStorage = {
  getItem: () => JSON.stringify({ id: 1, role: 'owner', tier: 'elite', username: 'owner' }),
  setItem: () => {},
  removeItem: () => {}
};

// Import Purchases and MobileReviewList
const PurchasesModule = require('./src/pages/Purchases.jsx');
const Purchases = PurchasesModule.default || PurchasesModule;

const MobileReviewListModule = require('./src/components/MobileReviewList.jsx');
const MobileReviewList = MobileReviewListModule.default || MobileReviewListModule;

// Generate 30 mock items (15 valid, 15 needing fix)
const mock30Items = Array.from({ length: 30 }, (_, i) => ({
  medicine_id: i < 15 ? (100 + i) : null,
  batch_number: 'BATCH-' + i,
  expiry_date: '2027-08-31',
  quantity: String(10 + i),
  buy_price: String(50 + i),
  candidates: []
}));

const mock30AllValid = Array.from({ length: 30 }, (_, i) => ({
  medicine_id: 100 + i,
  batch_number: 'BATCH-' + i,
  expiry_date: '2027-08-31',
  quantity: String(10 + i),
  buy_price: String(50 + i),
  candidates: []
}));

const mockMedicines = Array.from({ length: 30 }, (_, i) => ({
  id: 100 + i,
  name: 'Medicine ' + i,
  company: 'Pharma ' + i,
  buy_price: 50 + i
}));

// TEST 1: Render Purchases with empty items array
console.log('  TEST 1: Render Purchases with empty items array ([])...');
const htmlEmpty = ReactDOMServer.renderToString(
  React.createElement(TestWrapper, null,
    React.createElement(Purchases, {
      initialLines: [],
      initialOpen: true,
      initialScannedNotice: true,
      disablePortal: true
    })
  )
);
assert(typeof htmlEmpty === 'string' && htmlEmpty.length > 0, 'Purchases failed to render with empty items array');
assert(!htmlEmpty.includes('ReferenceError'), 'Render contained ReferenceError');
console.log('  PASS  Purchases renders cleanly with empty items array (no crash)');

// TEST 2: Render Purchases with 30 mock items (15 valid, 15 invalid)
console.log('  TEST 2: Render Purchases with 30 mock items (15 valid, 15 invalid)...');
const html30 = ReactDOMServer.renderToString(
  React.createElement(TestWrapper, null,
    React.createElement(Purchases, {
      initialLines: mock30Items,
      initialOpen: true,
      initialScannedNotice: true,
      disablePortal: true
    })
  )
);
assert(typeof html30 === 'string' && html30.length > 0, 'Purchases failed to render with 30 items');
assert(!html30.includes('ReferenceError'), 'Render contained ReferenceError');
assert(html30.includes('15/30 verified'), 'Save button must display correct count (15/30 verified)');
console.log('  PASS  Purchases renders cleanly with 30 mock items and displays "(15/30 verified)"');

// TEST 3: Render Purchases with 30 all-valid items
console.log('  TEST 3: Render Purchases with 30 all-valid items...');
const html30Valid = ReactDOMServer.renderToString(
  React.createElement(TestWrapper, null,
    React.createElement(Purchases, {
      initialLines: mock30AllValid,
      initialOpen: true,
      initialScannedNotice: true,
      disablePortal: true
    })
  )
);
assert(typeof html30Valid === 'string' && html30Valid.length > 0, 'Purchases failed to render with 30 valid items');
assert(html30Valid.includes('30/30 verified'), 'Save button must display (30/30 verified)');
console.log('  PASS  Purchases renders cleanly with 30 valid items and displays "(30/30 verified)"');

// TEST 4: Render MobileReviewList standalone with empty lines
console.log('  TEST 4: Render MobileReviewList with empty lines ([])...');
const htmlMobileEmpty = ReactDOMServer.renderToString(
  React.createElement(TestWrapper, null,
    React.createElement(MobileReviewList, {
      lines: [],
      setLines: () => {},
      setLine: () => {},
      medicines: mockMedicines,
      scannedNotice: true
    })
  )
);
assert(typeof htmlMobileEmpty === 'string', 'MobileReviewList failed to render empty');
console.log('  PASS  MobileReviewList renders cleanly with empty lines');

// TEST 5: Render MobileReviewList standalone with 30 items
console.log('  TEST 5: Render MobileReviewList with 30 items...');
const htmlMobile30 = ReactDOMServer.renderToString(
  React.createElement(TestWrapper, null,
    React.createElement(MobileReviewList, {
      lines: mock30Items,
      setLines: () => {},
      setLine: () => {},
      medicines: mockMedicines,
      scannedNotice: true
    })
  )
);
assert(typeof htmlMobile30 === 'string' && htmlMobile30.length > 0, 'MobileReviewList failed to render 30 items');
assert(htmlMobile30.includes('BATCH-15'), 'MobileReviewList must render needs-fix item batch');
console.log('  PASS  MobileReviewList renders cleanly with 30 items (showing needs-fix items)');

console.log('\\nAll 5 render smoke tests passed successfully!\\n');
`;

const clientDir = path.join(__dirname, '..', 'client');
const tempEntry = path.join(clientDir, 'temp-smoke-entry.js');
const tempBundle = path.join(clientDir, 'temp-smoke-bundle.cjs');

fs.writeFileSync(tempEntry, runnerSrc, 'utf8');

const mockPlugin = {
  name: 'mock-heavy-deps',
  setup(build) {
    build.onResolve({ filter: /pdfProcessor|invoiceParser/ }, args => ({
      path: args.path,
      namespace: 'mock-parser-ns'
    }));
    build.onLoad({ filter: /.*/, namespace: 'mock-parser-ns' }, () => ({
      contents: 'export const parseInvoiceFile = () => Promise.resolve({}); export const parseInvoicePDF = () => Promise.resolve({});',
      loader: 'js'
    }));

    build.onResolve({ filter: /\.\.\/auth/ }, args => ({
      path: args.path,
      namespace: 'mock-auth-ns'
    }));
    build.onLoad({ filter: /.*/, namespace: 'mock-auth-ns' }, () => ({
      contents: 'export const useAuth = () => ({ user: { role: "owner", tier: "elite", username: "owner" } }); export const AuthProvider = ({children}) => children;',
      loader: 'js'
    }));
  }
};

(async () => {
  try {
    await esbuild.build({
      entryPoints: [tempEntry],
      bundle: true,
      platform: 'node',
      outfile: tempBundle,
      format: 'cjs',
      external: ['stream', 'util', 'path', 'fs', 'events', 'crypto', 'buffer', 'http', 'https', 'net', 'tls', 'zlib', 'os', 'child_process'],
      plugins: [mockPlugin],
      loader: { '.jsx': 'jsx', '.js': 'js' },
      jsx: 'automatic',
      define: {
        'import.meta.env': JSON.stringify({ VITE_API_BASE: '', DEV: false, PROD: true, MODE: 'production' })
      }
    });

    const { spawnSync } = require('child_process');
    const res = spawnSync(process.execPath, [tempBundle], {
      stdio: 'inherit',
      cwd: clientDir
    });
    if (res.status !== 0) {
      throw new Error(`Smoke test runner exited with code ${res.status}`);
    }
  } catch (err) {
    console.error('SMOKE TEST FAILED:', err.message);
    process.exit(1);
  } finally {
    if (fs.existsSync(tempEntry)) fs.unlinkSync(tempEntry);
    if (fs.existsSync(tempBundle)) fs.unlinkSync(tempBundle);
  }
})();
