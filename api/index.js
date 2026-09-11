// Vercel serverless entry point.
// Vercel's Node.js runtime mounts an exported Express app directly as a
// Serverless Function for every route matched in vercel.json.

// Preload standard fonts for Vercel NFT bundler
try {
  require('pdfkit/standard-fonts/Helvetica');
  require('pdfkit/standard-fonts/HelveticaBold');
} catch (e) {}

const app = require('../server/index');

module.exports = app;
