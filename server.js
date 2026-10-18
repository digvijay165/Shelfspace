const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_FILE = process.env.DATA_FILE ? path.resolve(process.env.DATA_FILE) : path.join(ROOT, 'data.json');
const PORT = Number(process.env.PORT || 4173);
// Local installs stay on this computer; hosts such as Render set HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
// Behind a hosting proxy the TLS connection ends at the proxy, so trust its forwarded protocol.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
let configuredAdminEmail = process.env.ADMIN_EMAIL || '';
if (!configuredAdminEmail) {
  try { configuredAdminEmail = fs.readFileSync(path.join(ROOT, 'admin-email.txt'), 'utf8'); }
  catch {}
}
const ADMIN_EMAIL = String(configuredAdminEmail).trim().toLowerCase();
const MAX_BODY = 4 * 1024 * 1024;
const MAX_BOOK_TEXT = 2 * 1024 * 1024;
const sessions = new Map();
const COVER_THEMES = new Set(['midnight', 'terracotta', 'forest', 'lavender', 'sand', 'rose']);

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (Array.isArray(parsed.users) && Array.isArray(parsed.books)) return parsed;
  } catch {}
  return { users: [], books: [] };
}

let store = readStore();
function saveStore() {
  const temp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), 'utf8');
  fs.renameSync(temp, DATA_FILE);
}

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
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
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

function currentUser(req) {
  const id = sessions.get(cookieValue(req, 'shelfspace_session'));
  return store.users.find(user => user.id === id) || null;
}

function sessionCookie(token, req, clear = false) {
  const https = req.socket.encrypted || (TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
  const secure = https ? '; Secure' : '';
  return `shelfspace_session=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : 604800}${secure}`;
}

function isAdmin(user) {
  return Boolean(user && (user.role === 'admin' || (ADMIN_EMAIL && user.email === ADMIN_EMAIL)));
}

function safeUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: isAdmin(user) ? 'admin' : 'reader' };
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
    const owner = store.users.find(item => item.id === book.userId);
    return owner ? { name: owner.name, email: owner.email } : { name: 'Unknown reader', email: '' };
  })();
  const result = {
    id: book.id, title: book.title, author: book.author, coverTheme: book.coverTheme,
    coverImage: book.coverImage || '', sourceName: book.sourceName || '', status: book.status || 'pending',
    createdAt: book.createdAt, reviewedAt: book.reviewedAt || '', reviewNote: book.reviewNote || '', uploader,
    reviewer: book.reviewedBy ? (store.users.find(item => item.id === book.reviewedBy)?.name || '') : '',
    wordCount: wordCount(book.content), contentPreview: String(book.content || '').slice(0, 700)
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

function serveStatic(req, res, pathname) {
  const requested = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = path.resolve(PUBLIC, requested);
  if (!file.startsWith(`${PUBLIC}${path.sep}`) && file !== path.join(PUBLIC, 'index.html')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(file, (err, content) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
    const ext = path.extname(file).toLowerCase();
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    res.end(req.method === 'HEAD' ? undefined : content);
  });
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;
  if (req.method === 'POST' && pathname === '/api/register') {
    const body = await readBody(req);
    const name = String(body.name || '').trim().slice(0, 60);
    const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
    const password = String(body.password || '');
    if (name.length < 1) return sendJson(res, 400, { error: 'Add your name to create an account.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 128) return sendJson(res, 400, { error: 'Choose a password between 8 and 128 characters.' });
    if (store.users.some(user => user.email === email)) return sendJson(res, 409, { error: 'An account with that email already exists. Try signing in.' });
    const credentials = passwordHash(password);
    const user = { id: crypto.randomUUID(), name, email, role: ADMIN_EMAIL && email === ADMIN_EMAIL ? 'admin' : 'reader', ...credentials, createdAt: new Date().toISOString() };
    store.users.push(user); saveStore();
    const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id);
    return sendJson(res, 201, { user: safeUser(user) }, { 'Set-Cookie': sessionCookie(token, req) });
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const user = store.users.find(item => item.email === email);
    const candidate = user ? passwordHash(password, user.salt).hash : '';
    const matches = user && candidate.length === user.hash.length && crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.hash, 'hex'));
    if (!matches) return sendJson(res, 401, { error: 'That email and password do not match.' });
    const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, user.id);
    return sendJson(res, 200, { user: safeUser(user) }, { 'Set-Cookie': sessionCookie(token, req) });
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    sessions.delete(cookieValue(req, 'shelfspace_session'));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', req, true) });
  }

  const user = currentUser(req);
  if (req.method === 'GET' && pathname === '/api/me') {
    return sendJson(res, 200, { user: user ? safeUser(user) : null });
  }
  if (req.method === 'GET' && pathname === '/api/public/books') {
    const books = store.books.filter(book => book.status === 'published').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(safePublicBook);
    return sendJson(res, 200, { books });
  }
  const publicBookMatch = pathname.match(/^\/api\/public\/books\/([\w-]+)$/);
  if (req.method === 'GET' && publicBookMatch) {
    const book = store.books.find(item => item.id === publicBookMatch[1] && item.status === 'published');
    if (!book) return sendJson(res, 404, { error: 'That published book could not be found.' });
    return sendJson(res, 200, { book: safePublicBook(book, true) });
  }
  if (!user) return sendJson(res, 401, { error: 'Please sign in to continue.' });

  if (pathname.startsWith('/api/admin/')) {
    if (!isAdmin(user)) return sendJson(res, 403, { error: 'Admin access is required to review books.' });
    if (req.method === 'GET' && pathname === '/api/admin/export') {
      const exportedAt = new Date().toISOString();
      const books = store.books.map(book => ({
        id: book.id, title: book.title, author: book.author, content: book.content,
        coverTheme: book.coverTheme, coverImage: book.coverImage || '', sourceName: book.sourceName || '',
        status: book.status || 'pending', progress: book.progress || 0, createdAt: book.createdAt,
        reviewedAt: book.reviewedAt || '', uploader: safeAdminBook(book).uploader
      }));
      const users = store.users.map(item => ({ id: item.id, name: item.name, email: item.email, createdAt: item.createdAt }));
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
    if (req.method === 'GET' && pathname === '/api/admin/books') {
      const status = url.searchParams.get('status') || 'pending';
      const allowed = new Set(['pending', 'published', 'rejected', 'all']);
      if (!allowed.has(status)) return sendJson(res, 400, { error: 'Choose a valid review status.' });
      const books = store.books
        .filter(book => status === 'all' || (book.status || 'pending') === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(book => safeAdminBook(book));
      return sendJson(res, 200, { books });
    }
    const adminBookMatch = pathname.match(/^\/api\/admin\/books\/([\w-]+)(?:\/(status))?$/);
    if (adminBookMatch) {
      const [, id, statusPath] = adminBookMatch;
      const book = store.books.find(item => item.id === id);
      if (!book) return sendJson(res, 404, { error: 'Book not found.' });
      if (req.method === 'GET' && !statusPath) return sendJson(res, 200, { book: safeAdminBook(book, true) });
      if (req.method === 'DELETE' && !statusPath) {
        store.books = store.books.filter(item => item.id !== id); saveStore();
        return sendJson(res, 200, { ok: true });
      }
      if (req.method === 'PATCH' && statusPath) {
        const body = await readBody(req);
        if (!['pending', 'published', 'rejected'].includes(body.status)) return sendJson(res, 400, { error: 'Choose pending, published, or rejected.' });
        book.status = body.status;
        book.reviewedAt = body.status === 'pending' ? '' : new Date().toISOString();
        book.reviewedBy = user.id;
        book.reviewNote = body.status === 'pending' ? '' : String(body.note || '').trim().slice(0, 500);
        saveStore();
        return sendJson(res, 200, { book: safeAdminBook(book) });
      }
    }
    if (req.method === 'GET' && pathname === '/api/admin/users') {
      const users = store.users
        .map(item => {
          const books = store.books.filter(book => book.userId === item.id);
          return {
            id: item.id, name: item.name, email: item.email, role: isAdmin(item) ? 'admin' : 'reader', createdAt: item.createdAt,
            bookCount: books.length, publishedCount: books.filter(book => book.status === 'published').length,
            lockedAdmin: Boolean(ADMIN_EMAIL && item.email === ADMIN_EMAIL), isYou: item.id === user.id
          };
        })
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return sendJson(res, 200, { users });
    }
    const adminUserMatch = pathname.match(/^\/api\/admin\/users\/([\w-]+)\/role$/);
    if (req.method === 'PATCH' && adminUserMatch) {
      const target = store.users.find(item => item.id === adminUserMatch[1]);
      if (!target) return sendJson(res, 404, { error: 'Account not found.' });
      const body = await readBody(req);
      if (!['admin', 'reader'].includes(body.role)) return sendJson(res, 400, { error: 'Choose admin or reader.' });
      if (target.id === user.id) return sendJson(res, 400, { error: 'You cannot change your own role.' });
      if (body.role === 'reader' && ADMIN_EMAIL && target.email === ADMIN_EMAIL) return sendJson(res, 400, { error: 'The site owner always keeps admin access.' });
      target.role = body.role; saveStore();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'That admin page could not be found.' });
  }

  if (req.method === 'GET' && pathname === '/api/books') {
    // The list omits book text so large libraries load quickly; the reader fetches it per book.
    const books = store.books.filter(book => book.userId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(ownerBook);
    return sendJson(res, 200, { books });
  }

  if (req.method === 'POST' && pathname === '/api/books') {
    const body = await readBody(req);
    const title = String(body.title || '').trim().slice(0, 140);
    const content = typeof body.content === 'string' ? body.content : '';
    const author = String(body.author || '').trim().slice(0, 100);
    const coverTheme = COVER_THEMES.has(body.coverTheme) ? body.coverTheme : 'midnight';
    const sourceName = String(body.sourceName || '').trim().slice(0, 200);
    if (!title) return sendJson(res, 400, { error: 'Give your book a title.' });
    if (!content.trim()) return sendJson(res, 400, { error: 'Upload a text file or paste some book text.' });
    if (Buffer.byteLength(content, 'utf8') > MAX_BOOK_TEXT) return sendJson(res, 413, { error: 'That book is over 2 MB. Try a smaller text file.' });
    if (!validCoverImage(body.coverImage)) return sendJson(res, 400, { error: 'Choose a PNG, JPG, WebP, or GIF image under 1 MB for the cover.' });
    const book = {
      id: crypto.randomUUID(), userId: user.id, title, author: author || 'Unknown author', content,
      coverTheme, coverImage: body.coverImage || '', sourceName, progress: 0,
      status: 'pending', uploader: { name: user.name, email: user.email }, createdAt: new Date().toISOString()
    };
    store.books.push(book); saveStore();
    return sendJson(res, 201, { book: { ...ownerBook(book), content } });
  }

  const match = pathname.match(/^\/api\/books\/([\w-]+)(?:\/(progress|resubmit))?$/);
  if (match) {
    const [, id, action] = match;
    const progressPath = action === 'progress';
    const book = store.books.find(item => item.id === id && item.userId === user.id);
    if (!book) return sendJson(res, 404, { error: 'Book not found.' });
    if (req.method === 'GET' && !action) return sendJson(res, 200, { book: { ...ownerBook(book), content: book.content } });
    if (req.method === 'POST' && action === 'resubmit') {
      if (book.status !== 'rejected') return sendJson(res, 400, { error: 'Only declined books can be sent back for review.' });
      book.status = 'pending'; book.reviewedAt = ''; book.reviewNote = ''; saveStore();
      return sendJson(res, 200, { book: ownerBook(book) });
    }
    if (req.method === 'PATCH' && progressPath) {
      const body = await readBody(req);
      book.progress = Math.max(0, Math.min(100, Math.round(Number(body.progress) || 0)));
      saveStore();
      return sendJson(res, 200, { progress: book.progress });
    }
    if (req.method === 'DELETE' && !action) {
      store.books = store.books.filter(item => item.id !== id); saveStore();
      return sendJson(res, 200, { ok: true });
    }
  }
  return sendJson(res, 404, { error: 'That page could not be found.' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS' }); return res.end(); }
      return await handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('Method not allowed'); }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    const status = error.status || 500;
    sendJson(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : error.message });
  }
});

if (process.argv[2] === 'promote-admin') {
  const email = String(process.argv[3] || '').trim().toLowerCase();
  const user = store.users.find(item => item.email === email);
  if (!email || !user) {
    console.error('Account not found. Create the account first, then run: npm run admin:promote -- reader@example.com');
    process.exitCode = 1;
  } else {
    user.role = 'admin';
    saveStore();
    console.log(`${user.email} now has admin access. Sign out and sign back in to refresh the session.`);
  }
} else {
  server.listen(PORT, HOST, () => {
    console.log(`Shelfspace is ready at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`Library data is saved in ${DATA_FILE}`);
  });
}
