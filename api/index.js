// Vercel serverless entry point.
// Vercel's Node.js runtime mounts an exported Express app directly as a
// Serverless Function for every route matched in vercel.json.

const app = require('../server/index');

module.exports = app;
