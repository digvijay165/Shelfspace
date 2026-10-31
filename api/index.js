// Vercel entry point. vercel.json sends every page and API request here; images, scripts and styles
// are served straight from public/. The same handler runs as a long-lived server with `node server.js`.
const { waitUntil } = require('@vercel/functions');
const shelfspace = require('../server');

module.exports = async (req, res) => {
  if (!process.env.DATABASE_URL) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('DATABASE_URL is not set. Add a Postgres connection string in the Vercel project settings.');
  }
  try {
    await shelfspace.prepare();
    // Another copy of the server may have saved changes since this one last read the database.
    await shelfspace.store.refresh();
  } catch (error) {
    console.error('Database unavailable:', error.message);
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '10' });
    return res.end('Shelfspace cannot reach its database right now. Please try again in a moment.');
  }
  await shelfspace.handle(req, res);
  // Reading progress and page views are batched; save them before Vercel pauses this copy.
  waitUntil(shelfspace.store.flush().catch(error => console.error('Could not save pending changes:', error.message)));
};
