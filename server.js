const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore } = require('./lib/store');
const mailer = require('./lib/mailer');
const rateLimit = require('./lib/rate-limit');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(ROOT, 'data.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const PORT = Number(process.env.PORT || 4173);
// Local installs stay on this computer; hosts such as Render set HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
// Behind a hosting proxy the TLS connection ends at the proxy, so trust its forwarded headers.
// Vercel always runs behind its own proxy.
const ON_VERCEL = Boolean(process.env.VERCEL);
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || ON_VERCEL;
// Links in emails always use this address, never the request's Host header, so they cannot be spoofed.
const VERCEL_URL = process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '';
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || VERCEL_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const CONTACT_URL = process.env.CONTACT_URL || 'https://github.com/digvijay165/Shelfspace/issues';
let configuredAdminEmail = process.env.ADMIN_EMAIL || '';
if (!configuredAdminEmail) {
  try { configuredAdminEmail = fs.readFileSync(path.join(ROOT, 'admin-email.txt'), 'utf8'); }
  catch {}
}
const ADMIN_EMAIL = String(configuredAdminEmail).trim().toLowerCase();
const MAX_BODY = 4 * 1024 * 1024;
const MAX_BOOK_TEXT = 2 * 1024 * 1024;
const SESSION_DAYS = 30;
const MAX_PENDING_BOOKS = 5;
const MAX_ERROR_REPORTS = 200;
const COVER_THEMES = new Set(['midnight', 'terracotta', 'forest', 'lavender', 'sand', 'rose']);
// Email verification only gates uploads when the server can actually send the email.
const VERIFICATION_REQUIRED = mailer.enabled;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// Paths the single-page app draws itself; anything else that is not a file gets the 404 page.
const APP_ROUTES = new Set(['/', '/login', '/signup', '/forgot-password', '/reset-password', '/library', '/add', '/community', '/admin', '/account']);
const PAGE_ROUTES = { '/privacy': 'privacy.html', '/terms': 'terms.html' };
const TRACKED_PATHS = new Set([...APP_ROUTES, ...Object.keys(PAGE_ROUTES), '/404']);

const store = createStore({ databaseUrl: DATABASE_URL, dataFile: DATA_FILE });
const db = {
  get users() { return store.data.users; },
  get books() { return store.data.books; },
  get sessions() { return store.data.sessions; },
  get tokens() { return store.data.tokens; }
};

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(Object.assign(new Error('Request is too large. Keep book files under 2 MB.'), { status: 413 }));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(Object.assign(new Error('Please send valid JSON.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function cookieValue(req, name) {
  const cookies = (req.headers.cookie || '').split(';');
  for (const part of cookies) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      try { return decodeURIComponent(value.join('=')); } catch { return ''; }
    }
  }
  return '';
}

function isHttps(req) {
  return Boolean(req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'));
}

function clientIp(req) {
  if (TRUST_PROXY) {
    // Vercel replaces X-Forwarded-For with the real client address but passes True-Client-IP through
    // from the visitor, so it is only trusted elsewhere (Render's CDN sets it).
    const header = ON_VERCEL ? req.headers['x-forwarded-for'] : req.headers['true-client-ip'] || req.headers['x-forwarded-for'];
    const forwarded = String(header || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function sessionCookie(token, req, clear = false) {
  const secure = isHttps(req) ? '; Secure' : '';
  return `shelfspace_session=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_DAYS * 86400}${secure}`;
}

// Session tokens are only ever stored hashed, so a leaked database cannot be used to sign in.
async function startSession(user, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  await store.insert('sessions', { tokenHash: hashToken(token), userId: user.id, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + SESSION_DAYS * 86400_000).toISOString() });
  return sessionCookie(token, req);
}

function currentSession(req) {
  const token = cookieValue(req, 'shelfspace_session');
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = db.sessions.find(item => item.tokenHash === tokenHash);
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    store.remove('sessions', tokenHash).catch(() => {});
    return null;
  }
  return session;
}

function currentUser(req) {
  const session = currentSession(req);
  return session ? db.users.find(user => user.id === session.userId) || null : null;
}

async function endSessions(userId, keepTokenHash = '') {
  await store.removeWhere('sessions', item => item.userId === userId && item.tokenHash !== keepTokenHash);
}

async function issueToken(user, purpose, ttlMs) {
  await store.removeWhere('tokens', item => item.userId === user.id && item.purpose === purpose);
  const token = crypto.randomBytes(32).toString('hex');
  await store.insert('tokens', { tokenHash: hashToken(token), userId: user.id, purpose, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + ttlMs).toISOString() });
  return token;
}

function findToken(token, purpose) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const record = db.tokens.find(item => item.tokenHash === hashToken(token) && item.purpose === purpose);
  if (!record || Date.parse(record.expiresAt) <= Date.now()) return null;
  return record;
}

async function sendVerificationEmail(user) {
  const token = await issueToken(user, 'verify', 24 * HOUR);
  await mailer.sendVerification(user, `${APP_URL}/verify-email?token=${token}`);
}

function isAdmin(user) {
  return Boolean(user && (user.role === 'admin' || (ADMIN_EMAIL && user.email === ADMIN_EMAIL)));
}

function safeUser(user) {
  return {
    id: user.id, name: user.name, email: user.email, role: isAdmin(user) ? 'admin' : 'reader', createdAt: user.createdAt,
    emailVerified: Boolean(user.emailVerifiedAt), verificationRequired: VERIFICATION_REQUIRED, onboarded: Boolean(user.onboardedAt)
  };
}

function safePublicBook(book, includeContent = false) {
  const result = {
    id: book.id, title: book.title, author: book.author,
    coverTheme: book.coverTheme, coverImage: book.coverImage || '', createdAt: book.createdAt
  };
  if (includeContent) result.content = book.content;
  return result;
}

function safeAdminBook(book, includeContent = false) {
  const uploader = book.uploader || (() => {
    const owner = db.users.find(item => item.id === book.userId);
    return owner ? { name: owner.name, email: owner.email } : { name: 'Unknown reader', email: '' };
  })();
  const result = {
    id: book.id, title: book.title, author: book.author, coverTheme: book.coverTheme,
    coverImage: book.coverImage || '', sourceName: book.sourceName || '', status: book.status || 'pending',
    createdAt: book.createdAt, reviewedAt: book.reviewedAt || '', reviewNote: book.reviewNote || '', uploader,
    reviewer: book.reviewedBy ? (db.users.find(item => item.id === book.reviewedBy)?.name || '') : '',
    wordCount: wordCount(book.content), contentPreview: String(book.content || '').replace(/^#{1,6}\s+/gm, '').replace(/(\*\*|__)(.+?)\1/g, '$2').slice(0, 700)
  };
  if (includeContent) result.content = book.content;
  return result;
}

function wordCount(text) {
  return (String(text || '').match(/\S+/g) || []).length;
}

function ownerBook({ content, reviewedBy, ...book }) {
  return { ...book, status: book.status || 'pending', reviewNote: book.reviewNote || '' };
}

function validCoverImage(value) {
  if (!value) return true;
  if (typeof value !== 'string' || value.length > 1_400_000) return false;
  return /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(value);
}

function passwordHash(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('hex');
  return { salt, hash };
}

function passwordMatches(user, password) {
  const candidate = passwordHash(String(password || ''), user.salt).hash;
  return candidate.length === user.hash.length && crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.hash, 'hex'));
}

function passwordProblem(password) {
  if (password.length < 8 || password.length > 128) return 'Choose a password between 8 and 128 characters.';
  if (/^(.)\1+$/.test(password) || /^(password|12345678|qwertyui)/i.test(password)) return 'That password is too easy to guess. Try a short phrase instead.';
  return '';
}

// Answers 429 with a friendly message when a limit is hit. Returns true if the request was stopped.
function limited(res, key, max, windowMs, message) {
  const retryAfter = rateLimit.hit(key, max, windowMs);
  if (!retryAfter) return false;
  const wait = retryAfter < 90 ? `${retryAfter} seconds` : `${Math.ceil(retryAfter / 60)} minutes`;
  sendJson(res, 429, { error: `${message} Please try again in ${wait}.` }, { 'Retry-After': String(retryAfter) });
  return true;
}

function recordError(source, details) {
  const report = {
    id: crypto.randomUUID(), source, at: new Date().toISOString(),
    message: String(details.message || 'Unknown error').slice(0, 500),
    stack: String(details.stack || '').slice(0, 2000),
    location: String(details.location || '').slice(0, 300),
    path: String(details.path || '').slice(0, 200)
  };
  store.insert('clientErrors', report).catch(() => {});
  const reports = store.data.clientErrors;
  if (reports.length > MAX_ERROR_REPORTS) {
    const oldest = new Set(reports.slice().sort((a, b) => a.at.localeCompare(b.at)).slice(0, reports.length - MAX_ERROR_REPORTS).map(item => item.id));
    store.removeWhere('clientErrors', item => oldest.has(item.id)).catch(() => {});
  }
}

function countPageView(pathname) {
  const page = TRACKED_PATHS.has(pathname) ? pathname : '/404';
  const date = new Date().toISOString().slice(0, 10);
  const id = `${date}:${page}`;
  let record = store.data.pageViews.find(item => item.id === id);
  if (!record) { record = { id, date, path: page, views: 0 }; store.data.pageViews.push(record); }
  record.views += 1;
  store.saveLater('pageViews', record);
}

const STARTED_AT = new Date();
const VERSION = require('./package.json').version;

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms); })]).finally(() => clearTimeout(timer));
}

// Checks that the server can still reach its storage. Details (error text, memory) are for admins
// only, because database errors can mention hostnames.
async function health(details = false) {
  const started = process.hrtime.bigint();
  let database;
  try {
    await withTimeout(store.ping(), 3000);
    database = { status: 'ok', latencyMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6) };
  } catch (error) {
    database = { status: 'down', ...(details ? { error: error.message } : {}) };
  }
  const writeError = store.lastWriteError;
  const writes = { status: writeError ? 'failing' : 'ok', pending: store.pendingWrites, ...(details && writeError ? { lastError: writeError } : {}) };
  const status = database.status === 'down' ? 'down' : writes.status === 'ok' ? 'ok' : 'degraded';
  const result = {
    status, version: VERSION, startedAt: STARTED_AT.toISOString(), uptimeSeconds: Math.round(process.uptime()),
    checks: { database: { kind: store.kind, ...database }, writes, email: { status: mailer.enabled ? 'ok' : 'not_configured' } }
  };
  if (details) {
    const memory = process.memoryUsage();
    result.runtime = { node: process.version, memoryMb: Math.round(memory.rss / 1048576), heapMb: Math.round(memory.heapUsed / 1048576) };
    result.counts = { users: db.users.length, books: db.books.length, activeSessions: db.sessions.length };
  }
  return result;
}

let publicHealth = null;

function insights() {
  const days = [];
  for (let i = 29; i >= 0; i -= 1) days.push(new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10));
  const inRange = store.data.pageViews.filter(item => item.date >= days[0]);
  const perDay = days.map(date => ({ date, views: inRange.filter(item => item.date === date).reduce((sum, item) => sum + item.views, 0) }));
  const totals = new Map();
  for (const item of inRange) totals.set(item.path, (totals.get(item.path) || 0) + item.views);
  const topPages = [...totals].map(([page, views]) => ({ path: page, views })).sort((a, b) => b.views - a.views).slice(0, 10);
  const errors = store.data.clientErrors.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50);
  const since = Date.now() - 30 * 86400_000;
  const newReaders = db.users.filter(user => Date.parse(user.createdAt) >= since).length;
  return { perDay, topPages, errors, newReaders, storage: store.kind, emailEnabled: mailer.enabled };
}

function securityHeaders(req) {
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  };
  if (isHttps(req)) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.json': 'application/json; charset=utf-8'
};

// HTML pages carry the site address in canonical links and social tags, filled in per install.
function sendPage(req, res, file, status = 200) {
  fs.readFile(path.join(PUBLIC, file), 'utf8', (err, content) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Page unavailable'); }
    const html = content.replaceAll('{{APP_URL}}', APP_URL).replaceAll('{{CONTACT_URL}}', CONTACT_URL);
    res.writeHead(status, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache', ...securityHeaders(req) });
    res.end(req.method === 'HEAD' ? undefined : html);
  });
}

function sendText(req, res, type, body) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function serveStatic(req, res, pathname) {
  if (APP_ROUTES.has(pathname)) return sendPage(req, res, 'index.html');
  if (PAGE_ROUTES[pathname]) return sendPage(req, res, PAGE_ROUTES[pathname]);
  if (pathname === '/robots.txt') {
    return sendText(req, res, TYPES['.txt'], `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /library\nDisallow: /add\nDisallow: /admin\nDisallow: /account\nDisallow: /reset-password\n\nSitemap: ${APP_URL}/sitemap.xml\n`);
  }
  if (pathname === '/sitemap.xml') {
    const urls = ['/', '/community', '/signup', '/login', '/privacy', '/terms'].map(item => `  <url><loc>${APP_URL}${item === '/' ? '/' : item}</loc></url>`).join('\n');
    return sendText(req, res, TYPES['.xml'], `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  }
  let requested;
  try { requested = decodeURIComponent(pathname.slice(1)); } catch { return sendPage(req, res, '404.html', 404); }
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(`${PUBLIC}${path.sep}`)) return sendPage(req, res, '404.html', 404);
  const ext = path.extname(file).toLowerCase();
  if (ext === '.html') return sendPage(req, res, '404.html', 404);
  fs.readFile(file, (err, content) => {
    if (err) return sendPage(req, res, '404.html', 404);
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

async function handleVerifyEmail(req, res, url) {
  const record = findToken(url.searchParams.get('token'), 'verify');
  const user = record && db.users.find(item => item.id === record.userId);
  if (!user) {
    res.writeHead(303, { Location: '/library?verify=invalid' }); return res.end();
  }
  user.emailVerifiedAt = user.emailVerifiedAt || new Date().toISOString();
  await store.save('users', user);
  await store.removeWhere('tokens', item => item.userId === user.id && item.purpose === 'verify');
  res.writeHead(303, { Location: '/library?verified=1' });
  res.end();
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  const ip = clientIp(req);
  if (limited(res, `api:${ip}`, 600, 5 * MINUTE, 'You are making requests very quickly.')) return;

  if (req.method === 'POST' && pathname === '/api/register') {
    if (limited(res, `register-attempt:${ip}`, 30, HOUR, 'Too many sign-up attempts from this network.')) return;
    const createdRecently = rateLimit.blocked(`register:${ip}`, 5);
    if (createdRecently) return sendJson(res, 429, { error: `Several accounts were already created from this network. Please try again in ${Math.ceil(createdRecently / 60)} minutes.` }, { 'Retry-After': String(createdRecently) });
    const body = await readBody(req);
    // Real people never see this field; simple bots fill in every input they find.
    if (body.website) return sendJson(res, 400, { error: 'We could not create that account. Please try again.' });
    const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(body.password || '');
    if (name.length < 1) return sendJson(res, 400, { error: 'Add your name to create an account.', field: 'name' });
    if (/https?:\/\/|www\./i.test(name)) return sendJson(res, 400, { error: 'Names cannot contain links.', field: 'name' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email address, like you@example.com.', field: 'email' });
    const problem = passwordProblem(password);
    if (problem) return sendJson(res, 400, { error: problem, field: 'password' });
    if (db.users.some(user => user.email === email)) return sendJson(res, 409, { error: 'An account with that email already exists. Try signing in instead.', field: 'email' });
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(), name, email, role: ADMIN_EMAIL && email === ADMIN_EMAIL ? 'admin' : 'reader', ...passwordHash(password),
      createdAt: now, emailVerifiedAt: null, onboardedAt: null
    };
    await store.insert('users', user);
    rateLimit.hit(`register:${ip}`, 5, HOUR);
    sendVerificationEmail(user).catch(error => console.error('Could not send verification email:', error.message));
    return sendJson(res, 201, { user: safeUser(user) }, { 'Set-Cookie': await startSession(user, req) });
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    if (limited(res, `login:${ip}`, 20, 15 * MINUTE, 'Too many sign-in attempts.')) return;
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || !password) return sendJson(res, 400, { error: 'Enter your email and password.' });
    const lockKey = `login-fail:${email}`;
    const locked = rateLimit.blocked(lockKey, 8);
    if (locked) return sendJson(res, 429, { error: `This account is paused after several wrong passwords. Try again in ${Math.ceil(locked / 60)} minutes, or reset your password.` }, { 'Retry-After': String(locked) });
    const user = db.users.find(item => item.email === email);
    const matches = user ? passwordMatches(user, password) : (passwordHash(password), false);
    if (!matches) {
      rateLimit.hit(lockKey, 8, 15 * MINUTE);
      return sendJson(res, 401, { error: 'That email and password do not match. Check for typos, or reset your password.' });
    }
    rateLimit.reset(lockKey);
    return sendJson(res, 200, { user: safeUser(user) }, { 'Set-Cookie': await startSession(user, req) });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    const session = currentSession(req);
    if (session) await store.remove('sessions', session.tokenHash);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, true) });
  }

  if (req.method === 'POST' && pathname === '/api/password/forgot') {
    if (limited(res, `forgot:${ip}`, 5, HOUR, 'Too many reset requests from this network.')) return;
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return sendJson(res, 400, { error: 'Enter the email address you signed up with.', field: 'email' });
    const user = db.users.find(item => item.email === email);
    // The answer is the same whether or not the account exists, so this cannot be used to find accounts.
    if (user && !rateLimit.hit(`forgot-email:${email}`, 3, HOUR)) {
      const token = await issueToken(user, 'reset', HOUR);
      mailer.sendPasswordReset(user, `${APP_URL}/reset-password?token=${token}`).catch(error => console.error('Could not send reset email:', error.message));
    }
    return sendJson(res, 200, { ok: true, emailEnabled: mailer.enabled });
  }

  if (req.method === 'POST' && pathname === '/api/password/reset') {
    if (limited(res, `reset:${ip}`, 10, HOUR, 'Too many reset attempts.')) return;
    const body = await readBody(req);
    const record = findToken(body.token, 'reset');
    const user = record && db.users.find(item => item.id === record.userId);
    if (!user) return sendJson(res, 400, { error: 'This reset link has expired or was already used. Ask for a new one.' });
    const password = String(body.password || '');
    const problem = passwordProblem(password);
    if (problem) return sendJson(res, 400, { error: problem, field: 'password' });
    Object.assign(user, passwordHash(password));
    // Opening the link proves the reader controls the inbox.
    user.emailVerifiedAt = user.emailVerifiedAt || new Date().toISOString();
    await store.save('users', user);
    await store.removeWhere('tokens', item => item.userId === user.id && item.purpose === 'reset');
    await endSessions(user.id);
    rateLimit.reset(`login-fail:${user.email}`);
    return sendJson(res, 200, { user: safeUser(user) }, { 'Set-Cookie': await startSession(user, req) });
  }

  if (req.method === 'POST' && pathname === '/api/analytics') {
    if (rateLimit.hit(`analytics:${ip}`, 120, 10 * MINUTE)) return sendJson(res, 202, { ok: true });
    const body = await readBody(req);
    countPageView(String(body.path || '').split('?')[0]);
    return sendJson(res, 202, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/client-errors') {
    if (rateLimit.hit(`client-errors:${ip}`, 20, 10 * MINUTE)) return sendJson(res, 202, { ok: true });
    const body = await readBody(req);
    recordError('browser', { message: body.message, stack: body.stack, location: body.location, path: String(body.path || '').split('?')[0] });
    return sendJson(res, 202, { ok: true });
  }

  const session = currentSession(req);
  const user = session ? db.users.find(item => item.id === session.userId) || null : null;
  if (req.method === 'GET' && pathname === '/api/me') {
    return sendJson(res, 200, { user: user ? safeUser(user) : null });
  }
  if (req.method === 'GET' && pathname === '/api/public/books') {
    const books = db.books.filter(book => book.status === 'published').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(book => safePublicBook(book));
    return sendJson(res, 200, { books });
  }
  const publicBookMatch = pathname.match(/^\/api\/public\/books\/([\w-]+)$/);
  if (req.method === 'GET' && publicBookMatch) {
    const book = db.books.find(item => item.id === publicBookMatch[1] && item.status === 'published');
    if (!book) return sendJson(res, 404, { error: 'That book is no longer on the community shelf.' });
    return sendJson(res, 200, { book: safePublicBook(book, true) });
  }
  if (!user) return sendJson(res, 401, { error: 'Your session has ended. Please sign in again.' });

  if (req.method === 'POST' && pathname === '/api/logout-all') {
    await endSessions(user.id);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, true) });
  }

  if (req.method === 'POST' && pathname === '/api/email/resend') {
    if (user.emailVerifiedAt) return sendJson(res, 200, { ok: true, alreadyVerified: true });
    if (limited(res, `verify-resend:${user.id}`, 3, HOUR, 'We have already sent a few emails.')) return;
    await sendVerificationEmail(user);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/account') {
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      if (!name) return sendJson(res, 400, { error: 'Your name cannot be empty.', field: 'name' });
      if (/https?:\/\/|www\./i.test(name)) return sendJson(res, 400, { error: 'Names cannot contain links.', field: 'name' });
      user.name = name;
      await store.save('users', user);
      return sendJson(res, 200, { user: safeUser(user) });
    }
    if (req.method === 'DELETE') {
      if (limited(res, `delete-account:${user.id}`, 5, 15 * MINUTE, 'Too many attempts.')) return;
      const body = await readBody(req);
      if (!passwordMatches(user, body.password)) return sendJson(res, 400, { error: 'That password is not right. Your account was not deleted.', field: 'password' });
      await store.removeWhere('books', book => book.userId === user.id);
      await store.removeWhere('tokens', item => item.userId === user.id);
      await endSessions(user.id);
      await store.remove('users', user.id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, true) });
    }
  }

  if (req.method === 'POST' && pathname === '/api/account/password') {
    if (limited(res, `change-password:${user.id}`, 5, 15 * MINUTE, 'Too many attempts.')) return;
    const body = await readBody(req);
    if (!passwordMatches(user, body.currentPassword)) return sendJson(res, 400, { error: 'Your current password is not right.', field: 'currentPassword' });
    const password = String(body.newPassword || '');
    const problem = passwordProblem(password);
    if (problem) return sendJson(res, 400, { error: problem, field: 'newPassword' });
    Object.assign(user, passwordHash(password));
    await store.save('users', user);
    // Other devices are signed out; this one stays signed in.
    await endSessions(user.id, session.tokenHash);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === 'POST' && pathname === '/api/account/onboarded') {
    user.onboardedAt = user.onboardedAt || new Date().toISOString();
    await store.save('users', user);
    return sendJson(res, 200, { user: safeUser(user) });
  }

  if (req.method === 'GET' && pathname === '/api/account/export') {
    const exportedAt = new Date().toISOString();
    const books = db.books.filter(book => book.userId === user.id).map(({ userId, reviewedBy, ...book }) => book);
    const payload = JSON.stringify({ format: 'shelfspace-account-v1', exportedAt, account: { name: user.name, email: user.email, createdAt: user.createdAt }, books }, null, 2);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="my-shelfspace-${exportedAt.slice(0, 10)}.json"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(payload);
  }

  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(user)) return sendJson(res, 403, { error: 'Admin access is required to review books.' });
    if (req.method === 'GET' && pathname === '/api/admin/export') {
      const exportedAt = new Date().toISOString();
      const books = db.books.map(book => ({
        id: book.id, title: book.title, author: book.author, content: book.content,
        coverTheme: book.coverTheme, coverImage: book.coverImage || '', sourceName: book.sourceName || '',
        status: book.status || 'pending', progress: book.progress || 0, createdAt: book.createdAt,
        reviewedAt: book.reviewedAt || '', uploader: safeAdminBook(book).uploader
      }));
      const users = db.users.map(item => ({ id: item.id, name: item.name, email: item.email, createdAt: item.createdAt }));
      const payload = JSON.stringify({ format: 'shelfspace-export-v1', exportedAt, users, books }, null, 2);
      const filename = `shelfspace-export-${exportedAt.slice(0, 10)}.json`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(payload);
    }
    if (req.method === 'GET' && pathname === '/api/admin/insights') return sendJson(res, 200, { ...insights(), health: await health(true) });
    if (req.method === 'DELETE' && pathname === '/api/admin/errors') {
      await store.removeWhere('clientErrors', () => true);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/admin/books') {
      const status = url.searchParams.get('status') || 'pending';
      const allowed = new Set(['pending', 'published', 'rejected', 'all']);
      if (!allowed.has(status)) return sendJson(res, 400, { error: 'Choose a valid review status.' });
      const books = db.books
        .filter(book => status === 'all' || (book.status || 'pending') === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(book => safeAdminBook(book));
      return sendJson(res, 200, { books });
    }
    const adminBookMatch = pathname.match(/^\/api\/admin\/books\/([\w-]+)(?:\/(status))?$/);
    if (adminBookMatch) {
      const [, id, statusPath] = adminBookMatch;
      const book = db.books.find(item => item.id === id);
      if (!book) return sendJson(res, 404, { error: 'That book was already removed.' });
      if (req.method === 'GET' && !statusPath) return sendJson(res, 200, { book: safeAdminBook(book, true) });
      if (req.method === 'DELETE' && !statusPath) {
        await store.remove('books', id);
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && statusPath) {
        const body = await readBody(req);
        if (!['pending', 'published', 'rejected'].includes(body.status)) return sendJson(res, 400, { error: 'Choose pending, published, or rejected.' });
        book.status = body.status;
        book.reviewedAt = body.status === 'pending' ? '' : new Date().toISOString();
        book.reviewedBy = user.id;
        book.reviewNote = body.status === 'pending' ? '' : String(body.note || '').trim().slice(0, 500);
        await store.save('books', book);
        return sendJson(res, 200, { book: safeAdminBook(book) });
      }
    }
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      const users = db.users
        .map(item => {
          const books = db.books.filter(book => book.userId === item.id);
          return {
            id: item.id, name: item.name, email: item.email, role: isAdmin(item) ? 'admin' : 'reader', createdAt: item.createdAt,
            bookCount: books.length, publishedCount: books.filter(book => book.status === 'published').length,
            emailVerified: Boolean(item.emailVerifiedAt),
            lockedAdmin: Boolean(ADMIN_EMAIL && item.email === ADMIN_EMAIL), isYou: item.id === user.id
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return sendJson(res, 200, { users });
    }
    const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([\w-]+)\/role$/);
    if (req.method === 'PATCH' && adminUserMatch) {
      const target = db.users.find(item => item.id === adminUserMatch[1]);
      if (!target) return sendJson(res, 404, { error: 'Account not found.' });
      const body = await readBody(req);
      if (!['admin', 'reader'].includes(body.role)) return sendJson(res, 400, { error: 'Choose admin or reader.' });
      if (target.id === user.id) return sendJson(res, 400, { error: 'You cannot change your own role.' });
      if (body.role === 'reader' && ADMIN_EMAIL && target.email === ADMIN_EMAIL) return sendJson(res, 400, { error: 'The site owner always keeps admin access.' });
      target.role = body.role;
      await store.save('users', target);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'That admin page could not be found.' });
  }

  if (req.method === 'GET' && pathname === '/api/books') {
    // The list omits book text so large libraries load quickly; the reader fetches it per book.
    const books = db.books.filter(book => book.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(ownerBook);
    return sendJson(res, 200, { books });
  }

  if (req.method === 'POST' && pathname === '/api/books') {
    if (VERIFICATION_REQUIRED && !user.emailVerifiedAt && !isAdmin(user)) return sendJson(res, 403, { error: 'Please confirm your email address before adding books. Check your inbox, or send a new link from the banner above.' });
    if (!isAdmin(user) && limited(res, `upload:${user.id}`, 10, HOUR, 'You have added a lot of books in the last hour.')) return;
    const pending = db.books.filter(book => book.userId === user.id && book.status === 'pending').length;
    if (!isAdmin(user) && pending >= MAX_PENDING_BOOKS) return sendJson(res, 429, { error: `You already have ${pending} books waiting for review. Once an editor has looked at them you can add more.` });
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 140);
    const content = typeof body.content === 'string' ? body.content : '';
    const author = String(body.author || '').trim().slice(0, 100);
    const coverTheme = COVER_THEMES.has(body.coverTheme) ? body.coverTheme : 'midnight';
    const sourceName = String(body.sourceName || '').trim().slice(0, 200);
    if (!title) return sendJson(res, 400, { error: 'Give your book a title.', field: 'title' });
    if (!content.trim()) return sendJson(res, 400, { error: 'Upload a text file or paste some book text.', field: 'content' });
    if (wordCount(content) < 20) return sendJson(res, 400, { error: 'That text is very short. Add at least a paragraph (20 words or more).', field: 'content' });
    if (Buffer.byteLength(content, 'utf8') > MAX_BOOK_TEXT) return sendJson(res, 413, { error: 'That book is over 2 MB. Try a smaller text file.', field: 'content' });
    if (!validCoverImage(body.coverImage)) return sendJson(res, 400, { error: 'Choose a PNG, JPG, WebP, or GIF image under 1 MB for the cover.' });
    const book = {
      id: crypto.randomUUID(), userId: user.id, title, author: author || 'Unknown author', content,
      coverTheme, coverImage: body.coverImage || '', sourceName, progress: 0,
      status: 'pending', uploader: { name: user.name, email: user.email }, createdAt: new Date().toISOString()
    };
    await store.insert('books', book);
    return sendJson(res, 201, { book: { ...ownerBook(book), content } });
  }

  const match = pathname.match(/^\/api\/books\/([\w-]+)(?:\/(progress|resubmit))?$/);
  if (match) {
    const [, id, action] = match;
    const book = db.books.find(item => item.id === id && item.userId === user.id);
    if (!book) return sendJson(res, 404, { error: 'That book is no longer in your library.' });
    if (req.method === 'GET' && !action) return sendJson(res, 200, { book: { ...ownerBook(book), content: book.content } });
    if (req.method === 'POST' && action === 'resubmit') {
      if (book.status !== 'rejected') return sendJson(res, 400, { error: 'Only declined books can be sent back for review.' });
      book.status = 'pending'; book.reviewedAt = ''; book.reviewNote = '';
      await store.save('books', book);
      return sendJson(res, 200, { book: ownerBook(book) });
    }
    if (req.method === 'PATCH' && action === 'progress') {
      const body = await readBody(req);
      book.progress = Math.max(0, Math.min(100, Math.round(Number(body.progress) || 0)));
      store.saveLater('books', book);
      return sendJson(res, 200, { progress: book.progress });
    }
    if (req.method === 'DELETE' && !action) {
      await store.remove('books', id);
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: 'That page could not be found.' });
}

// Browsers send an Origin header on cross-site requests; anything that changes data must come from here.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return !origin;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://localhost');
    // Liveness for the host: answers without touching storage, so a database outage does not
    // make the host restart a server that is otherwise fine.
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('ok'); }
    // Readiness: checks storage and reports each part. 503 when the database cannot be reached.
    if (url.pathname === '/api/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!publicHealth || Date.now() - publicHealth.at > 5000) publicHealth = { at: Date.now(), result: health(false) };
      const result = await publicHealth.result;
      return sendJson(res, result.status === 'down' ? 503 : 200, result);
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return sendJson(res, 403, { error: 'Requests must come from Shelfspace itself.' });
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end('Method not allowed'); }
    if (url.pathname === '/verify-email') return await handleVerifyEmail(req, res, url);
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      res.writeHead(301, { Location: url.pathname.replace(/\/+$/, '') + url.search }); return res.end();
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    const status = error.status || 500;
    if (status === 500) {
      console.error(error);
      recordError('server', { message: error.message, stack: error.stack, path: url?.pathname || '' });
    }
    if (res.headersSent || res.destroyed) return;
    sendJson(res, status, { error: status === 500 ? 'Something went wrong on our side. Please try again in a moment.' : error.message });
  }
}

async function prepareData() {
  await store.load();
  // First start on a new database: bring over an existing JSON library if there is one.
  if (store.kind === 'postgres' && db.users.length === 0 && db.books.length === 0 && fs.existsSync(DATA_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      for (const user of legacy.users || []) await store.insert('users', user);
      for (const book of legacy.books || []) await store.insert('books', book);
      console.log(`Imported ${db.users.length} accounts and ${db.books.length} books from ${DATA_FILE}`);
    } catch (error) { console.error('Could not import the existing JSON library:', error.message); }
  }
  // Accounts created before email verification existed are treated as verified and onboarded.
  for (const user of db.users) {
    if (user.emailVerifiedAt === undefined) {
      user.emailVerifiedAt = user.createdAt; user.onboardedAt = user.onboardedAt || user.createdAt;
      await store.save('users', user);
    }
  }
  await store.removeWhere('sessions', item => Date.parse(item.expiresAt) <= Date.now());
  await store.removeWhere('tokens', item => Date.parse(item.expiresAt) <= Date.now());
  // Hosted demos start with a few published sample books so the community shelf is never empty.
  if (process.env.DEMO_SEED === '1' && db.books.length === 0) {
    const now = Date.now();
    const samples = require('./demo/books.js');
    for (const [index, book] of samples.entries()) {
      await store.insert('books', {
        id: crypto.randomUUID(), userId: '', title: book.title, author: book.author, content: book.content,
        coverTheme: book.coverTheme, coverImage: '', sourceName: '', progress: 0, status: 'published',
        uploader: { name: 'Shelfspace', email: '' }, reviewNote: '',
        createdAt: new Date(now - index * 60_000).toISOString(), reviewedAt: new Date(now).toISOString()
      });
    }
  }
}

// Serverless hosts (api/index.js) call this on every request; it loads the data once per server copy
// and tries again on the next request if the database could not be reached.
let prepared = null;
function prepare() {
  if (!prepared) prepared = prepareData().catch(error => { prepared = null; throw error; });
  return prepared;
}

async function main() {
  await prepareData();
  if (process.argv[2] === 'promote-admin') {
    const email = String(process.argv[3] || '').trim().toLowerCase();
    const user = db.users.find(item => item.email === email);
    if (!email || !user) {
      console.error('Account not found. Create the account first, then run: npm run admin:promote -- reader@example.com');
      process.exitCode = 1;
    } else {
      user.role = 'admin';
      await store.save('users', user);
      console.log(`${user.email} now has admin access. Sign out and sign back in to refresh the session.`);
    }
    return store.close();
  }
  setInterval(() => {
    store.removeWhere('sessions', item => Date.parse(item.expiresAt) <= Date.now()).catch(() => {});
    store.removeWhere('tokens', item => Date.parse(item.expiresAt) <= Date.now()).catch(() => {});
  }, HOUR).unref();
  const server = http.createServer(handle);
  server.listen(PORT, HOST, () => {
    console.log(`Shelfspace is ready at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(store.kind === 'postgres' ? 'Library data is saved in Postgres (DATABASE_URL)' : `Library data is saved in ${DATA_FILE}`);
    if (!mailer.enabled) console.log('Email is not configured (RESEND_API_KEY); verification and reset links will be printed here.');
  });
  // Hosts send SIGTERM before a restart or redeploy: finish batched writes first.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => {
      server.close();
      store.close().catch(error => console.error(error.message)).finally(() => process.exit(0));
      setTimeout(() => process.exit(1), 8000).unref();
    });
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Shelfspace could not start:', error.message);
    process.exit(1);
  });
}

module.exports = { handle, prepare, store };
