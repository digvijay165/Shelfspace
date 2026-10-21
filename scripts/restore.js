// Restores a backup made by scripts/backup.js into the configured database or JSON file.
// Usage: npm run restore -- backups/shelfspace-backup-....json --yes
// Records in the backup replace records with the same id; nothing else is deleted unless --replace
// is given, in which case the existing accounts, books and sessions are removed first.
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('../lib/store');

const ROOT = path.join(__dirname, '..');
const file = process.argv[2];
const confirmed = process.argv.includes('--yes');
const replace = process.argv.includes('--replace');

async function main() {
  if (!file || !fs.existsSync(file)) throw new Error('Pass the backup file to restore, for example: npm run restore -- backups/shelfspace-backup-2026-10-21.json --yes');
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (snapshot.format !== 'shelfspace-backup-v1') throw new Error('That file is not a Shelfspace backup.');
  const store = createStore({ databaseUrl: process.env.DATABASE_URL, dataFile: process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(ROOT, 'data.json') });
  await store.load();
  const target = store.kind === 'postgres' ? 'the Postgres database in DATABASE_URL' : 'the JSON data file';
  if (!confirmed) {
    console.log(`This will restore ${snapshot.users.length} accounts and ${snapshot.books.length} books from ${snapshot.createdAt} into ${target}${replace ? ', removing what is there now' : ''}.`);
    console.log('Run again with --yes to continue.');
    return store.close();
  }
  if (replace) {
    for (const name of ['users', 'books', 'sessions', 'tokens']) await store.removeWhere(name, () => true);
  }
  for (const name of ['users', 'books', 'pageViews', 'clientErrors']) {
    for (const record of snapshot[name] || []) {
      const list = store.data[name];
      const index = list.findIndex(item => item.id === record.id);
      if (index === -1) list.push(record); else list[index] = record;
      await store.save(name, record);
    }
  }
  await store.close();
  console.log(`Restored ${snapshot.users.length} accounts and ${snapshot.books.length} books into ${target}. Restart the server to load them.`);
}

main().catch(error => { console.error('Restore failed:', error.message); process.exit(1); });
