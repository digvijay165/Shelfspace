// End-to-end checks for accounts, security and pages. Starts the real server on a spare port with a
// throwaway JSON data file; email is not configured, so links are read from the server log.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 5100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shelfspace-test-')), 'data.json');
// Set TEST_DATABASE_URL to run the same checks against Postgres instead of a JSON file.
const DATABASE_URL = process.env.TEST_DATABASE_URL || '';
let server;
let log = '';
let ownerCookie = '';

// Everything the server has written to storage, as text, to check what is (and is not) saved.
async function savedText() {
  if (!DATABASE_URL) return fs.readFileSync(DATA_FILE, 'utf8');
  const { Client } = require('pg');
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  const rows = [];
  for (const table of ['users', 'books', 'sessions', 'auth_tokens']) rows.push(...(await client.query(`SELECT data FROM ${table}`)).rows.map(row => row.data));
  await client.end();
  return JSON.stringify(rows);
}

before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_FILE, DATABASE_URL, RESEND_API_KEY: '', ADMIN_EMAIL: 'owner@example.com', APP_URL: BASE, DEMO_SEED: '' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', chunk => { log += chunk; });
  server.stderr.on('data', chunk => { log += chunk; });
  for (let i = 0; i < 50 && !log.includes('Shelfspace is ready'); i += 1) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(log.includes('Shelfspace is ready'), `server did not start:\n${log}`);
});

after(() => server?.kill());

async function call(method, url, { body, cookie, headers = {} } = {}) {
  const response = await fetch(BASE + url, {
    method, redirect: 'manual',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const setCookie = response.headers.get('set-cookie') || '';
  return { status: response.status, json, text, headers: response.headers, cookie: setCookie.split(';')[0] };
}

const register = (name, email, password = 'a good long phrase') => call('POST', '/api/register', { body: { name, email, password } });

function lastLink(kind) {
  const matches = [...log.matchAll(new RegExp(`${BASE.replace(/[.:/]/g, '\\$&')}/${kind}\\?token=([a-f0-9]{64})`, 'g'))];
  return matches.at(-1)?.[1];
}

const story = 'Once upon a time there was a small library at the edge of a quiet town, and every evening the lamps came on one by one while readers found their seats.';

test('registration validates input and starts a session', async () => {
  assert.equal((await register('', 'a@example.com')).status, 400);
  const badEmail = await register('Ada', 'not-an-email');
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.json.field, 'email');
  assert.equal((await register('Ada', 'ada@example.com', 'short')).json.field, 'password');
  assert.equal((await register('Ada', 'ada@example.com', 'password123')).status, 400, 'common passwords are refused');
  const bot = await call('POST', '/api/register', { body: { name: 'Bot', email: 'bot@example.com', password: 'a good long phrase', website: 'http://spam.example' } });
  assert.equal(bot.status, 400, 'honeypot field blocks bots');

  const ok = await register('Ada Lovelace', 'ada@example.com');
  assert.equal(ok.status, 201);
  assert.match(ok.cookie, /^shelfspace_session=[a-f0-9]{64}$/);
  assert.equal(ok.json.user.emailVerified, false);
  assert.equal((await register('Ada', 'ADA@example.com')).status, 409);
  const me = await call('GET', '/api/me', { cookie: ok.cookie });
  assert.equal(me.json.user.email, 'ada@example.com');
  assert.equal(me.json.user.hash, undefined, 'password hash never leaves the server');
});

test('session tokens are stored hashed, never in plain text', async () => {
  const { cookie } = await call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'a good long phrase' } });
  await new Promise(resolve => setTimeout(resolve, 50));
  const saved = await savedText();
  assert.ok(saved.includes('tokenHash'));
  assert.ok(!saved.includes(cookie.split('=')[1]));
});

test('login, logout and sign out everywhere', async () => {
  const wrong = await call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'nope nope nope' } });
  assert.equal(wrong.status, 401);
  const first = await call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'a good long phrase' } });
  const second = await call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'a good long phrase' } });
  assert.equal(first.status, 200);
  await call('POST', '/api/logout', { cookie: first.cookie });
  assert.equal((await call('GET', '/api/me', { cookie: first.cookie })).json.user, null, 'logout ends the session on the server');
  assert.ok((await call('GET', '/api/me', { cookie: second.cookie })).json.user, 'other sessions survive a normal logout');
  await call('POST', '/api/logout-all', { cookie: second.cookie });
  assert.equal((await call('GET', '/api/me', { cookie: second.cookie })).json.user, null);
});

test('email verification link confirms the address once', async () => {
  const token = lastLink('verify-email');
  assert.ok(token, 'verification link was logged');
  const visit = await call('GET', `/verify-email?token=${token}`);
  assert.equal(visit.status, 303);
  assert.equal(visit.headers.get('location'), '/library?verified=1');
  const again = await call('GET', `/verify-email?token=${token}`);
  assert.equal(again.headers.get('location'), '/library?verify=invalid');
  const { cookie } = await call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'a good long phrase' } });
  assert.equal((await call('GET', '/api/me', { cookie })).json.user.emailVerified, true);
});

test('password reset replaces the password and signs out old sessions', async () => {
  const old = await call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'a good long phrase' } });
  const unknown = await call('POST', '/api/password/forgot', { body: { email: 'nobody@example.com' } });
  assert.equal(unknown.status, 200, 'same answer for unknown emails');
  assert.equal((await call('POST', '/api/password/forgot', { body: { email: 'ada@example.com' } })).status, 200);
  await new Promise(resolve => setTimeout(resolve, 100));
  const token = lastLink('reset-password');
  assert.ok(token);
  assert.equal((await call('POST', '/api/password/reset', { body: { token: 'f'.repeat(64), password: 'brand new phrase' } })).status, 400);
  assert.equal((await call('POST', '/api/password/reset', { body: { token, password: 'short' } })).json.field, 'password');
  const reset = await call('POST', '/api/password/reset', { body: { token, password: 'brand new phrase' } });
  assert.equal(reset.status, 200);
  assert.ok(reset.cookie);
  assert.equal((await call('GET', '/api/me', { cookie: old.cookie })).json.user, null);
  assert.equal((await call('POST', '/api/password/reset', { body: { token, password: 'another phrase!' } })).status, 400, 'links are single use');
  assert.equal((await call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'brand new phrase' } })).status, 200);
});

test('uploads are checked and capped while waiting for review', async () => {
  const { cookie } = await call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'brand new phrase' } });
  const tiny = await call('POST', '/api/books', { cookie, body: { title: 'Tiny', content: 'too short' } });
  assert.equal(tiny.status, 400);
  assert.equal(tiny.json.field, 'content');
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await call('POST', '/api/books', { cookie, body: { title: `Book ${i}`, content: story } })).status, 201);
  }
  const sixth = await call('POST', '/api/books', { cookie, body: { title: 'One too many', content: story } });
  assert.equal(sixth.status, 429);
  const other = await register('Grace', 'grace@example.com');
  const { json } = await call('GET', '/api/books', { cookie });
  assert.equal((await call('GET', `/api/books/${json.books[0].id}`, { cookie: other.cookie })).status, 404, 'readers cannot open each other\'s books');
  assert.equal((await call('DELETE', `/api/books/${json.books[0].id}`, { cookie: other.cookie })).status, 404);
  assert.equal((await call('GET', '/api/admin/books', { cookie: other.cookie })).status, 403);
});

test('account export, rename and delete', async () => {
  const { cookie } = await call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'brand new phrase' } });
  const exported = await call('GET', '/api/account/export', { cookie });
  assert.equal(exported.json.books.length, 5);
  assert.equal(exported.json.account.email, 'ada@example.com');
  assert.ok(!exported.text.includes('"hash"'));
  assert.equal((await call('PATCH', '/api/account', { cookie, body: { name: 'Countess Ada' } })).json.user.name, 'Countess Ada');
  const refused = await call('DELETE', '/api/account', { cookie, body: { password: 'wrong password' } });
  assert.equal(refused.status, 400);
  assert.equal((await call('DELETE', '/api/account', { cookie, body: { password: 'brand new phrase' } })).status, 200);
  assert.equal((await call('GET', '/api/me', { cookie })).json.user, null);
  assert.equal((await call('POST', '/api/login', { body: { email: 'ada@example.com', password: 'brand new phrase' } })).status, 401);
  const saved = await savedText();
  assert.ok(!saved.includes('ada@example.com'), 'books are deleted with the account');
});

test('cross-site requests that change data are refused', async () => {
  const response = await call('POST', '/api/login', { body: { email: 'grace@example.com', password: 'a good long phrase' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(response.status, 403);
});

test('pages: titles, 404, legal pages, robots, sitemap and security headers', async () => {
  const home = await call('GET', '/');
  assert.equal(home.status, 200);
  assert.match(home.text, /<meta name="description" content="[^"]{50,}">/);
  assert.ok(home.text.includes(`<link rel="canonical" href="${BASE}/">`));
  assert.match(home.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  for (const route of ['/login', '/signup', '/library', '/community', '/account', '/forgot-password', '/reset-password']) {
    assert.equal((await call('GET', route)).status, 200, route);
  }
  const missing = await call('GET', '/no/such/page');
  assert.equal(missing.status, 404);
  assert.match(missing.text, /<title>Page not found · Shelfspace<\/title>/);
  assert.equal((await call('GET', '/index.html')).status, 404);
  assert.equal((await call('GET', '/../server.js')).status, 404);
  const privacy = await call('GET', '/privacy');
  assert.equal(privacy.status, 200);
  assert.ok(!privacy.text.includes('{{'), 'placeholders are filled in');
  assert.equal((await call('GET', '/terms')).status, 200);
  assert.match((await call('GET', '/robots.txt')).text, /Sitemap: .*\/sitemap\.xml/);
  assert.match((await call('GET', '/sitemap.xml')).text, /<loc>.*\/community<\/loc>/);
  assert.equal((await call('GET', '/library/')).headers.get('location'), '/library');
});

test('analytics and error reports are recorded for admins only', async () => {
  await call('POST', '/api/analytics', { body: { path: '/community?token=secret' } });
  await call('POST', '/api/client-errors', { body: { message: 'Boom', stack: 'at x', path: '/library' } });
  const owner = await register('Owner', 'owner@example.com');
  ownerCookie = owner.cookie;
  assert.equal(owner.json.user.role, 'admin');
  const insights = await call('GET', '/api/admin/insights', { cookie: owner.cookie });
  assert.equal(insights.status, 200);
  assert.ok(insights.json.topPages.some(page => page.path === '/community'));
  assert.ok(!JSON.stringify(insights.json).includes('secret'), 'query strings are never stored');
  assert.ok(insights.json.errors.some(report => report.message === 'Boom'));
  const reader = await call('POST', '/api/login', { body: { email: 'grace@example.com', password: 'a good long phrase' } });
  assert.equal((await call('GET', '/api/admin/insights', { cookie: reader.cookie })).status, 403);
});

test('repeated wrong passwords pause the account and registrations are rate limited', async () => {
  for (let i = 0; i < 8; i += 1) await call('POST', '/api/login', { body: { email: 'grace@example.com', password: 'wrong wrong wrong' } });
  const locked = await call('POST', '/api/login', { body: { email: 'grace@example.com', password: 'a good long phrase' } });
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get('retry-after'));
  let status = 0;
  for (let i = 0; i < 6 && status !== 429; i += 1) status = (await register(`Person ${i}`, `person${i}@example.com`)).status;
  assert.equal(status, 429);
});

test('health checks report storage status without leaking details', async () => {
  assert.equal((await call('GET', '/healthz')).text, 'ok');
  const health = await call('GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.json.status, 'ok');
  assert.equal(health.json.checks.database.status, 'ok');
  assert.equal(health.json.checks.database.kind, DATABASE_URL ? 'postgres' : 'file');
  assert.equal(typeof health.json.checks.database.latencyMs, 'number');
  assert.equal(health.json.checks.email.status, 'not_configured');
  assert.ok(health.json.uptimeSeconds >= 0);
  assert.equal(health.json.counts, undefined, 'public health hides counts');
  assert.equal(health.json.runtime, undefined, 'public health hides runtime details');
  const insights = await call('GET', '/api/admin/insights', { cookie: ownerCookie });
  assert.equal(insights.json.health.status, 'ok');
  assert.ok(insights.json.health.runtime.memoryMb > 0);
  assert.ok(insights.json.health.counts.users >= 1);
});
