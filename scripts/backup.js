// Writes a complete, restorable snapshot of the library (accounts with password hashes, books,
// page views and error reports) to backups/. Sessions and email links are left out on purpose.
// Usage: npm run backup            (uses DATABASE_URL, or DATA_FILE / ./data.json)
//        npm run backup -- --keep 14   (also deletes all but the 14 newest backups)
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../lib/store');

const ROOT = path.join(__dirname, '..');
const DIR = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, 'backups'));
const keepIndex = process.argv.indexOf('--keep');
const keep = keepIndex !== -1 ? Number(process.argv[keepIndex + 1]) : 0;

async function main() {
  const store = createStore({ databaseUrl: process.env.DATABASE_URL, dataFile: process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(ROOT, 'data.json') });
  const data = await store.load();
  const snapshot = { format: 'shelfspace-backup-v1', createdAt: new Date().toISOString(), source: store.kind, users: data.users, books: data.books, pageViews: data.pageViews, clientErrors: data.clientErrors };
  await store.close();
  fs.mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `shelfspace-backup-${snapshot.createdAt.replace(/[:.]/g, '-')}.json`);
  // Backups contain password hashes, so only the current user may read them.
  fs.writeFileSync(file, JSON.stringify(snapshot), { encoding: 'utf8', mode: 0o600 });
  console.log(`Saved ${data.users.length} accounts and ${data.books.length} books to ${file}`);
  if (keep > 0) {
    const old = fs.readdirSync(DIR).filter(name => /^shelfspace-backup-.*\.json$/.test(name)).sort().reverse().slice(keep);
    for (const name of old) fs.unlinkSync(path.join(DIR, name));
    if (old.length) console.log(`Removed ${old.length} older backup${old.length === 1 ? '' : 's'}`);
  }
}

main().catch(error => { console.error('Backup failed:', error.message); process.exit(1); });
