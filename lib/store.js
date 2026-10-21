// Persistence for Shelfspace. Everything is kept in memory for fast reads and written through to
// either Postgres (when DATABASE_URL is set) or a local JSON file. Each collection is a table of
// { id, data jsonb } rows, so the app can evolve record shapes without migrations.
const fs = require('node:fs');
const path = require('node:path');

const COLLECTIONS = ['users', 'books', 'sessions', 'tokens', 'pageViews', 'clientErrors'];
const TABLES = { users: 'users', books: 'books', sessions: 'sessions', tokens: 'auth_tokens', pageViews: 'page_views', clientErrors: 'error_reports' };
const KEYS = { sessions: 'tokenHash', tokens: 'tokenHash' };

function emptyData() {
  return Object.fromEntries(COLLECTIONS.map(name => [name, []]));
}

function keyOf(collection, record) {
  return record[KEYS[collection] || 'id'];
}

function normalize(parsed) {
  const data = emptyData();
  for (const name of COLLECTIONS) if (Array.isArray(parsed?.[name])) data[name] = parsed[name];
  return data;
}

class FileStore {
  constructor(file) {
    this.file = file;
    this.kind = 'file';
    this.data = emptyData();
    this.timer = null;
  }

  async load() {
    try { this.data = normalize(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch {}
    return this.data;
  }

  writeNow() {
    clearTimeout(this.timer); this.timer = null;
    const temp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
    fs.renameSync(temp, this.file);
  }

  async save() { this.writeNow(); }
  async remove() { this.writeNow(); }
  async removeWhere() { this.writeNow(); }
  saveLater() { if (!this.timer) this.timer = setTimeout(() => this.writeNow(), 5000); }
  async flush() { if (this.timer) this.writeNow(); }
  get pendingWrites() { return this.timer ? 1 : 0; }

  // Healthy when the data folder can still be written to.
  async ping() {
    await fs.promises.access(path.dirname(this.file), fs.constants.W_OK);
  }
  async close() { await this.flush(); }
}

class PostgresStore {
  constructor(connectionString) {
    const { Pool } = require('pg');
    const local = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
    // Hosted Postgres providers require TLS; a local database usually does not.
    const ssl = process.env.DATABASE_SSL === '0' || (local && process.env.DATABASE_SSL !== '1') ? false : { rejectUnauthorized: process.env.DATABASE_SSL_STRICT === '1' };
    // node-postgres ignores channel_binding in the URL, so turn it on explicitly when it is asked for
    // (Neon's connection strings include it); it ties the login to the TLS session.
    const enableChannelBinding = /[?&]channel_binding=require\b/.test(connectionString);
    this.pool = new Pool({ connectionString, ssl, max: 5, connectionTimeoutMillis: 5000, enableChannelBinding });
    // An idle connection dropping (database restart, network blip) must not crash the server;
    // the pool reconnects on the next query and the health check reports the outage meanwhile.
    this.pool.on('error', error => console.error('Database connection lost:', error.message));
    this.kind = 'postgres';
    this.data = emptyData();
    this.dirty = new Map();
    this.timer = null;
    // Writes run one after another so a later save can never land before an earlier one.
    this.queue = Promise.resolve();
    this.lastWriteError = null;
  }

  get pendingWrites() { return this.dirty.size; }

  async ping() {
    const client = await this.pool.connect();
    try { await client.query('SELECT 1'); } finally { client.release(); }
  }

  async load() {
    for (const name of COLLECTIONS) {
      const table = TABLES[name];
      await this.pool.query(`CREATE TABLE IF NOT EXISTS ${table} (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
      // Row level security with no policies: only the table owner (this server) can read or write.
      // That keeps rows private even if the database is exposed through an auto-generated API
      // such as Supabase's, which would otherwise publish every public table.
      await this.pool.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      const { rows } = await this.pool.query(`SELECT data FROM ${table}`);
      this.data[name] = rows.map(row => row.data);
    }
    return this.data;
  }

  run(task) {
    const next = this.queue.then(task).then(result => { this.lastWriteError = null; return result; }, error => {
      this.lastWriteError = { message: error.message, at: new Date().toISOString() };
      throw error;
    });
    this.queue = next.catch(() => {});
    return next;
  }

  async save(collection, record) {
    this.dirty.delete(`${collection}:${keyOf(collection, record)}`);
    const json = JSON.stringify(record);
    return this.run(() => this.pool.query(
      `INSERT INTO ${TABLES[collection]} (id, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [keyOf(collection, record), json]
    ));
  }

  async remove(collection, id) {
    this.dirty.delete(`${collection}:${id}`);
    return this.run(() => this.pool.query(`DELETE FROM ${TABLES[collection]} WHERE id = $1`, [id]));
  }

  async removeWhere(collection, ids) {
    if (!ids.length) return;
    for (const id of ids) this.dirty.delete(`${collection}:${id}`);
    return this.run(() => this.pool.query(`DELETE FROM ${TABLES[collection]} WHERE id = ANY($1)`, [ids]));
  }

  // For frequent, low-stakes updates (reading progress, page view counts): batched every few seconds.
  saveLater(collection, record) {
    this.dirty.set(`${collection}:${keyOf(collection, record)}`, { collection, record });
    if (!this.timer) this.timer = setTimeout(() => this.flush().catch(error => console.error('Could not save pending changes:', error.message)), 5000);
  }

  async flush() {
    clearTimeout(this.timer); this.timer = null;
    const pending = [...this.dirty.values()];
    this.dirty.clear();
    for (const { collection, record } of pending) await this.save(collection, record);
  }

  async close() {
    await this.flush();
    await this.queue;
    await this.pool.end();
  }
}

// A thin wrapper so callers can say store.save('books', book) without caring about the backend.
function createStore({ databaseUrl, dataFile }) {
  const backend = databaseUrl ? new PostgresStore(databaseUrl) : new FileStore(dataFile);
  return {
    get kind() { return backend.kind; },
    get data() { return backend.data; },
    load: () => backend.load(),
    ping: () => backend.ping(),
    get pendingWrites() { return backend.pendingWrites; },
    get lastWriteError() { return backend.lastWriteError || null; },
    save: (collection, record) => backend.save(collection, record),
    saveLater: (collection, record) => backend.saveLater(collection, record),
    async remove(collection, id) {
      const list = backend.data[collection];
      const index = list.findIndex(item => keyOf(collection, item) === id);
      if (index !== -1) list.splice(index, 1);
      return backend.remove(collection, id);
    },
    async removeWhere(collection, predicate) {
      const removed = backend.data[collection].filter(predicate);
      if (!removed.length) return 0;
      backend.data[collection] = backend.data[collection].filter(item => !predicate(item));
      await backend.removeWhere(collection, removed.map(item => keyOf(collection, item)));
      return removed.length;
    },
    async insert(collection, record) {
      backend.data[collection].push(record);
      return backend.save(collection, record);
    },
    flush: () => backend.flush(),
    close: () => backend.close()
  };
}

module.exports = { createStore, COLLECTIONS, keyOf, normalize };
