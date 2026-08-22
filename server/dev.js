// Local development entry — starts the Express server on a plain port.
// (The app itself is exported from index.js so Vercel can import it too.)
const app = require('./index');

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('');
  console.log('  💊 MediStock is running!');
  console.log(`  ➜  Open http://localhost:${PORT} in your browser`);
  console.log('  ➜  Demo logins ->  owner / owner123   |   staff / staff123');
  console.log('');
});
