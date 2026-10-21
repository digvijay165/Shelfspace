const state = { user: null, books: [], publicBooks: [], adminBooks: [], adminUsers: [], adminStatus: 'pending', chapters: [], flip: null, authMode: 'login', coverTheme: 'midnight', coverImage: '', sourceName: '', activeBook: null, readerMode: 'private', pages: [], pageIndex: 0, toastTimer: null, textSize: readTextSize(), booksLoaded: false, publicLoaded: false, adminLoaded: false, workspaceUser: null, resetToken: '', pageTitle: document.title };
const TEXT_SIZES = ['small', 'medium', 'large'];
function readTextSize() {
  try { return localStorage.getItem('shelfspace-text-size') || 'medium'; } catch { return 'medium'; }
}

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

async function api(url, options = {}) {
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  } catch {
    throw new Error('We could not reach Shelfspace. Check your internet connection and try again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const fallback = response.status >= 500 ? 'Something went wrong on our side. Please try again in a moment.' : 'Something went wrong. Please try again.';
    const error = Object.assign(new Error(data.error || fallback), { status: response.status, field: data.field || '' });
    if (response.status === 401 && state.user) sessionEnded();
    throw error;
  }
  return data;
}

function sessionEnded() {
  resetSession();
  notify('Your session has ended. Please sign in again.');
  navigate(`/login?next=${encodeURIComponent(location.pathname)}`, { replace: true });
}

// Disables a button and shows a spinner while its work runs, so nothing is submitted twice.
async function busy(button, task) {
  if (!button) return task();
  button.disabled = true; button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true');
  try { return await task(); }
  finally { button.disabled = false; button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); }
}

async function downloadFile(url, fallbackName) {
  const response = await fetch(url, { credentials: 'same-origin' }).catch(() => null);
  if (!response) throw new Error('We could not reach Shelfspace. Check your internet connection and try again.');
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || 'Could not prepare the download.');
  }
  const disposition = response.headers.get('Content-Disposition') || '';
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || fallbackName;
  const objectUrl = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href = objectUrl; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

// ---------- Form validation ----------
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const RULES = {
  name: value => value.trim() ? '' : 'Add your name so we know what to call you.',
  email: value => !value.trim() ? 'Enter your email address.' : EMAIL_PATTERN.test(value.trim()) ? '' : 'That email looks incomplete. It should look like you@example.com.',
  password: value => value ? '' : 'Enter your password.',
  currentPassword: value => value ? '' : 'Enter your current password.',
  newPassword: value => {
    if (!value) return 'Choose a password.';
    const missing = 8 - value.length;
    return missing > 0 ? `Add ${missing} more character${missing === 1 ? '' : 's'}. Passwords need at least 8.` : '';
  }
};

function setFieldError(input, message) {
  const field = input.closest('.field');
  let note = field?.querySelector('.field-error');
  if (!note && field && message) {
    note = el('small', 'field-error');
    note.id = `${input.form?.id || 'form'}-${input.name || input.id}-error`;
    field.append(note);
  }
  input.setAttribute('aria-invalid', String(Boolean(message)));
  if (note) note.textContent = message;
  if (note && message) input.setAttribute('aria-describedby', note.id);
  else if (input.getAttribute('aria-describedby')?.endsWith('-error')) input.removeAttribute('aria-describedby');
}

// Checks each named input with its rule; focuses the first problem. Returns true when all pass.
function validate(form, rules) {
  let first = null;
  for (const [name, rule] of Object.entries(rules)) {
    const input = form.elements[name];
    if (!input) continue;
    const message = rule(input.value);
    setFieldError(input, message);
    if (message && !first) first = input;
  }
  first?.focus();
  return !first;
}

function clearFormErrors(form) {
  form.querySelectorAll('[aria-invalid="true"]').forEach(input => setFieldError(input, ''));
  form.querySelectorAll('.form-error').forEach(node => { node.textContent = ''; });
}

// Shows a server error next to the field it is about, or in the form's general error line.
function showFormError(form, error, fieldMap = {}) {
  const input = error.field && (fieldMap[error.field] || form.elements[error.field]);
  if (input) { setFieldError(input, error.message); input.focus(); }
  else form.querySelector('.form-error').textContent = error.message;
}

// Once a field has been flagged, re-check it as the reader types so the message clears promptly.
document.addEventListener('input', event => {
  const input = event.target;
  if (input.getAttribute?.('aria-invalid') !== 'true') return;
  const rule = input.dataset.rule ? RULES[input.dataset.rule] : RULES[input.name];
  setFieldError(input, rule ? rule(input.value) : (input.value.trim() ? '' : input.closest('.field')?.querySelector('.field-error')?.textContent || ''));
});

document.addEventListener('click', event => {
  const toggle = event.target.closest('.password-toggle');
  if (!toggle) return;
  const input = toggle.previousElementSibling;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  toggle.textContent = showing ? 'Show' : 'Hide';
  toggle.setAttribute('aria-pressed', String(!showing));
  toggle.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  input.focus();
});

function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function escapeClass(value) { return /^[a-z]+$/.test(value) ? value : 'midnight'; }

// ---------- Routing and page titles ----------
const AUTH_ROUTES = { '/': 'login', '/login': 'login', '/signup': 'register', '/forgot-password': 'forgot', '/reset-password': 'reset' };
const WORKSPACE_ROUTES = { '/library': 'library', '/add': 'add', '/admin': 'admin', '/account': 'account' };
const TITLES = {
  '/': 'Shelfspace — your books, beautifully read',
  '/login': 'Sign in · Shelfspace',
  '/signup': 'Create your free account · Shelfspace',
  '/forgot-password': 'Reset your password · Shelfspace',
  '/reset-password': 'Choose a new password · Shelfspace',
  '/library': 'My library · Shelfspace',
  '/add': 'Add a book · Shelfspace',
  '/admin': 'Review submissions · Shelfspace',
  '/account': 'Account settings · Shelfspace',
  '/community': 'Community shelf: free books to read online · Shelfspace'
};
const AUTH_COPY = {
  login: { eyebrow: 'WELCOME BACK', heading: 'Pick up where<br>you left off.', intro: 'Sign in to find your next favorite page.', submit: 'Sign in' },
  register: { eyebrow: 'YOUR OWN LITTLE LIBRARY', heading: 'Make room for<br>your next story.', intro: 'Create a free account and start building your shelf.', submit: 'Create my account' },
  forgot: { eyebrow: 'IT HAPPENS TO EVERYONE', heading: 'Forgot your<br>password?', intro: 'Enter the email you signed up with and we will send you a link to choose a new one.' },
  reset: { eyebrow: 'ALMOST THERE', heading: 'Choose a new<br>password.', intro: 'Pick something you have not used here before. You will be signed in straight away.' }
};

function navigate(path, { replace = false } = {}) {
  if (path !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState']({}, '', path);
  route();
}

function safeNext(value) {
  return value && WORKSPACE_ROUTES[value] ? value : '/library';
}

function setPageTitle(title) {
  document.title = title;
  state.pageTitle = title;
}

function route() {
  const path = location.pathname;
  const params = new URLSearchParams(location.search);
  if (!$('#reader').hidden) closeReader();
  $('#boot-screen').hidden = true;

  if (AUTH_ROUTES[path]) {
    const mode = AUTH_ROUTES[path];
    if (state.user && mode !== 'reset') return navigate(safeNext(params.get('next')), { replace: true });
    if (mode === 'reset' && params.get('token')) {
      // Keep the token in memory only, so it never lingers in the address bar or browser history.
      state.resetToken = params.get('token');
      history.replaceState({}, '', '/reset-password');
    }
    showAuth(mode);
  } else if (path === '/community') {
    showPublic();
  } else if (WORKSPACE_ROUTES[path]) {
    if (!state.user) return navigate(`/login?next=${encodeURIComponent(path)}`, { replace: true });
    const view = WORKSPACE_ROUTES[path];
    if (view === 'admin' && state.user.role !== 'admin') { notify('Admin access is required.'); return navigate('/library', { replace: true }); }
    showWorkspace(view);
    if (params.get('verified')) {
      state.user.emailVerified = true;
      updateUserChrome();
      notify('Email confirmed. You can add books now.');
      history.replaceState({}, '', path);
    } else if (params.get('verify') === 'invalid') {
      notify('That confirmation link has expired or was already used. Send a new one from the banner.');
      history.replaceState({}, '', path);
    }
  } else {
    window.location.assign(path);
    return;
  }
  setPageTitle(TITLES[path] || TITLES['/']);
  window.ShelfMonitor?.pageView(path);
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === 'register';
  const isPasswordForm = mode === 'login' || isRegister;
  const copy = AUTH_COPY[mode];
  $$('.auth-tab').forEach(tab => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('#auth-tabs').hidden = !isPasswordForm;
  $('#auth-form').hidden = !isPasswordForm;
  $('#forgot-form').hidden = mode !== 'forgot';
  $('#reset-form').hidden = mode !== 'reset';
  $('#name-field').hidden = !isRegister;
  $('#name-field input').required = isRegister;
  $('#password-hint').hidden = !isRegister;
  $('#consent-note').hidden = !isRegister;
  $('#forgot-row').hidden = isRegister;
  $('#auth-heading').innerHTML = copy.heading;
  $('#auth-eyebrow').textContent = copy.eyebrow;
  $('#auth-intro').textContent = copy.intro;
  if (copy.submit) $('#auth-submit-label').textContent = copy.submit;
  const password = $('#auth-form [name="password"]');
  password.autocomplete = isRegister ? 'new-password' : 'current-password';
  password.dataset.rule = isRegister ? 'newPassword' : 'password';
  $('#forgot-sent').hidden = true;
  [$('#auth-form'), $('#forgot-form'), $('#reset-form')].forEach(clearFormErrors);
  if (mode === 'reset' && !state.resetToken) $('#reset-error').textContent = 'This page needs the link from your reset email. Ask for a new link below.';
}

function resetSession() {
  state.user = null;
  state.books = [];
  state.booksLoaded = false;
  state.adminBooks = [];
  state.adminUsers = [];
  state.adminLoaded = false;
  state.workspaceUser = null;
  selectAdminTab('pending');
  $('#admin-search').value = '';
  $$('#auth-form, #profile-form, #password-form, #delete-form').forEach(form => { form.reset(); clearFormErrors(form); });
}

function updateUserChrome() {
  const user = state.user;
  if (!user) return;
  $('#admin-nav').hidden = user.role !== 'admin';
  $('#mobile-admin-nav').hidden = user.role !== 'admin';
  $('#profile-name').textContent = user.name;
  $('#profile-email').textContent = user.email;
  $('#avatar').textContent = (user.name || 'S').trim().charAt(0).toUpperCase();
  $('#welcome-title').textContent = `A shelf of your own, ${user.name.split(/\s+/)[0]}.`;
  const needsVerify = user.verificationRequired && !user.emailVerified;
  $('#verify-banner').hidden = !needsVerify;
  $('#verify-address').textContent = user.email;
  renderOnboarding();
}

function showWorkspace(view) {
  $('#auth-view').hidden = true;
  $('#public-view').hidden = true;
  $('#workspace').hidden = false;
  if (state.workspaceUser !== state.user.id) {
    state.workspaceUser = state.user.id;
    const hours = new Date().getHours();
    $('#today-label').textContent = hours < 12 ? 'A GOOD MORNING FOR A STORY' : hours < 18 ? 'A LITTLE TIME FOR A STORY' : 'A QUIET EVENING FOR A STORY';
    refreshAdminBadge();
  }
  updateUserChrome();
  showSection(view);
}

function showAuth(mode = 'login') {
  $('#reader').hidden = true;
  $('#public-view').hidden = true;
  $('#workspace').hidden = true;
  $('#auth-view').hidden = false;
  document.body.style.overflow = '';
  setAuthMode(mode);
}

function showPublic() {
  $('#auth-view').hidden = true;
  $('#workspace').hidden = true;
  $('#public-view').hidden = false;
  $('#public-return').innerHTML = state.user ? 'Back to my library <span aria-hidden="true">→</span>' : 'Sign in <span aria-hidden="true">→</span>';
  window.scrollTo({ top: 0 });
  loadPublicBooks();
}

// ---------- Onboarding ----------
function hasOpenedBook() {
  try { return localStorage.getItem('shelfspace-opened-book') === '1'; } catch { return false; }
}

function renderOnboarding() {
  const panel = $('#onboarding');
  const user = state.user;
  if (!user || user.onboarded || !state.booksLoaded) { panel.hidden = true; return; }
  const done = { verify: user.emailVerified, book: state.books.length > 0, read: hasOpenedBook() };
  const steps = user.verificationRequired ? ['verify', 'book', 'read'] : ['book', 'read'];
  panel.querySelector('[data-step="verify"]').hidden = !user.verificationRequired;
  panel.querySelector('[data-step="verify"] .step-state').textContent = done.verify ? 'Done' : 'Check your inbox';
  for (const step of ['verify', 'book', 'read']) panel.querySelector(`[data-step="${step}"]`).classList.toggle('done', Boolean(done[step]));
  if (steps.every(step => done[step])) {
    panel.hidden = true;
    finishOnboarding();
    return;
  }
  panel.hidden = false;
}

async function finishOnboarding() {
  if (!state.user || state.user.onboarded) return;
  state.user.onboarded = true;
  try { await api('/api/account/onboarded', { method: 'POST', body: '{}' }); } catch {}
}

// ---------- Loading and empty states ----------
function showSkeletons(grid, count, className) {
  const cards = Array.from({ length: count }, () => {
    const card = el('div', `skeleton-card ${className}`);
    card.append(el('span', 'skeleton-cover'), el('span', 'skeleton-line'), el('span', 'skeleton-line short'));
    return card;
  });
  grid.replaceChildren(...cards);
  grid.hidden = false;
  grid.setAttribute('aria-busy', 'true');
}

function showLoadError(grid, message, retry) {
  const box = el('div', 'load-error');
  box.setAttribute('role', 'alert');
  box.append(el('strong', '', 'This shelf did not load.'), el('p', '', message), actionButton('Try again', 'button-secondary', retry));
  grid.replaceChildren(box);
  grid.hidden = false;
  grid.removeAttribute('aria-busy');
}

async function loadBooks() {
  if (!state.booksLoaded) {
    $('#empty-state').hidden = true; $('#no-results').hidden = true;
    showSkeletons($('#book-grid'), 4, 'book-skeleton');
  }
  try {
    const { books } = await api('/api/books');
    state.books = books;
    state.booksLoaded = true;
    $('#book-grid').removeAttribute('aria-busy');
    renderBooks();
  } catch (error) {
    if (state.booksLoaded) notify(error.message);
    else if (state.user) showLoadError($('#book-grid'), error.message, loadBooks);
  }
}

async function loadPublicBooks() {
  if (!state.publicLoaded) {
    $('#public-empty').hidden = true;
    showSkeletons($('#public-book-grid'), 5, 'public-skeleton');
  }
  try {
    const { books } = await api('/api/public/books');
    state.publicBooks = books;
    state.publicLoaded = true;
    $('#public-book-grid').removeAttribute('aria-busy');
    renderPublicBooks();
  } catch (error) {
    if (state.publicLoaded) notify(error.message);
    else showLoadError($('#public-book-grid'), error.message, loadPublicBooks);
  }
}

async function loadAdminBooks() {
  $('#admin-error').textContent = '';
  const refresh = $('#refresh-admin');
  refresh.classList.add('is-spinning');
  if (!state.adminLoaded) { $('#admin-empty').hidden = true; showSkeletons($('#admin-book-list'), 2, 'admin-skeleton'); }
  try {
    const [{ books }, { users }] = await Promise.all([api('/api/admin/books?status=all'), api('/api/admin/users')]);
    state.adminBooks = books;
    state.adminUsers = users;
    state.adminLoaded = true;
    $('#admin-book-list').removeAttribute('aria-busy');
    renderAdminBooks();
  } catch (error) {
    $('#admin-error').textContent = error.message;
    if (!state.adminLoaded) $('#admin-book-list').replaceChildren();
  } finally { refresh.classList.remove('is-spinning'); }
}

async function loadInsights() {
  const list = $('#insight-errors');
  if (!state.insights) list.replaceChildren(el('li', 'insight-empty', 'Loading…'));
  try {
    state.insights = await api('/api/admin/insights');
    renderInsights();
  } catch (error) { $('#admin-error').textContent = error.message; }
}

const PAGE_NAMES = { '/': 'Home', '/login': 'Sign in', '/signup': 'Create account', '/forgot-password': 'Forgot password', '/reset-password': 'Reset password', '/library': 'My library', '/add': 'Add a book', '/community': 'Community shelf', '/admin': 'Review', '/account': 'Account', '/privacy': 'Privacy policy', '/terms': 'Terms', '/404': 'Page not found' };

function renderInsights() {
  const data = state.insights;
  if (!data) return;
  const total = data.perDay.reduce((sum, day) => sum + day.views, 0);
  const max = Math.max(1, ...data.perDay.map(day => day.views));
  const busiest = data.perDay.reduce((best, day) => day.views > best.views ? day : best, data.perDay[0]);
  $('#insight-total').textContent = `${total.toLocaleString()} ${total === 1 ? 'view' : 'views'}`;
  const chart = $('#insight-chart');
  chart.setAttribute('aria-label', total ? `Daily page views for the last 30 days. ${total} in total; the busiest day was ${formatDate(`${busiest.date}T12:00:00`)} with ${busiest.views}.` : 'No page views recorded in the last 30 days.');
  chart.replaceChildren(...data.perDay.map(day => {
    const bar = el('span', 'insight-bar');
    bar.style.height = `${Math.max(2, (day.views / max) * 100)}%`;
    bar.title = `${formatDate(`${day.date}T12:00:00`)}: ${day.views} ${day.views === 1 ? 'view' : 'views'}`;
    return bar;
  }));
  const pages = $('#insight-pages');
  pages.replaceChildren(...(data.topPages.length ? data.topPages.map(page => {
    const item = el('li');
    const label = el('span', '', PAGE_NAMES[page.path] || page.path);
    const meter = el('span', 'insight-meter'); const fill = el('i'); fill.style.width = `${(page.views / data.topPages[0].views) * 100}%`; meter.append(fill);
    item.append(label, meter, el('strong', '', page.views.toLocaleString()));
    return item;
  }) : [el('li', 'insight-empty', 'No visits recorded yet.')]));
  const status = $('#insight-status');
  const health = data.health;
  const database = health.checks.database;
  const hours = Math.floor(health.uptimeSeconds / 3600);
  const rows = [
    ['Health', health.status === 'ok' ? 'All systems working' : health.status === 'degraded' ? 'Degraded: some saves are failing' : 'Down: storage cannot be reached'],
    ['Storage', `${data.storage === 'postgres' ? 'Postgres database' : 'JSON file on the server disk'} · ${database.status === 'ok' ? `responding in ${database.latencyMs} ms` : `not responding (${database.error || 'unknown error'})`}`],
    ['Saves', health.checks.writes.lastError ? `Last save failed at ${new Date(health.checks.writes.lastError.at).toLocaleTimeString()}: ${health.checks.writes.lastError.message}` : `Working${health.checks.writes.pending ? ` · ${health.checks.writes.pending} waiting to be written` : ''}`],
    ['Email', data.emailEnabled ? 'Sending through Resend' : 'Not set up: links are written to the server log'],
    ['Server', `Up ${hours ? `${hours} h ${Math.floor((health.uptimeSeconds % 3600) / 60)} min` : `${Math.floor(health.uptimeSeconds / 60)} min`} · ${health.runtime.memoryMb} MB memory · Node ${health.runtime.node} · v${health.version}`],
    ['New readers', `${data.newReaders} in the last 30 days`]
  ];
  status.replaceChildren(...rows.flatMap(([term, value]) => [el('dt', '', term), el('dd', '', value)]));
  status.firstElementChild.nextElementSibling.className = `health-${health.status}`;
  if (data.storage !== 'postgres') status.append(el('dd', 'insight-warning', 'On free hosting the disk is wiped on every restart. Set DATABASE_URL to keep accounts and books.'));
  const errors = $('#insight-errors');
  $('#clear-errors').hidden = data.errors.length === 0;
  errors.replaceChildren(...(data.errors.length ? data.errors.map(report => {
    const item = el('li');
    const head = el('div', 'insight-error-head');
    head.append(el('span', `error-source source-${report.source}`, report.source === 'server' ? 'Server' : 'Browser'), el('strong', '', report.message));
    const meta = el('p', '', `${new Date(report.at).toLocaleString()} · ${report.path || 'unknown page'}${report.location ? ` · ${report.location}` : ''}`);
    item.append(head, meta);
    if (report.stack) { const details = el('details'); details.append(el('summary', '', 'Stack trace'), el('pre', '', report.stack)); item.append(details); }
    return item;
  }) : [el('li', 'insight-empty', 'No errors reported. Everything looks healthy.')]));
}

// Keeps the sidebar badge current so admins see new submissions without opening the review page.
async function refreshAdminBadge() {
  if (state.user?.role !== 'admin') return;
  try {
    const { books } = await api('/api/admin/books?status=pending');
    updateAdminBadge(books.length);
  } catch {}
}

function updateAdminBadge(count) {
  $('#admin-nav-badge').textContent = String(count);
  $('#admin-nav-badge').hidden = count === 0;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(label, className, onClick) {
  const node = el('button', `button ${className}`, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

async function setBookStatus(book, nextStatus, note = '') {
  try {
    await api(`/api/admin/books/${book.id}/status`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus, note }) });
    await loadAdminBooks();
    loadBooks();
    if (nextStatus === 'published') { loadPublicBooks(); notify(`“${book.title}” is now on the community shelf.`); }
    else if (nextStatus === 'rejected') notify('Submission declined. The uploader will see your note.');
    else notify('Book returned to the review queue.');
  } catch (error) { notify(error.message); }
}

function makeCover(book, compact = false) {
  const cover = document.createElement('div');
  cover.className = `cover-3d theme-${escapeClass(book.coverTheme)}`;
  if (book.coverImage) {
    const img = document.createElement('img');
    img.className = 'cover-image'; img.alt = `Cover art for ${book.title}`; img.src = book.coverImage; img.loading = 'lazy'; img.decoding = 'async';
    cover.append(img);
    const overlay = document.createElement('span'); overlay.className = 'cover-overlay'; cover.append(overlay);
  }
  const kicker = document.createElement('span'); kicker.className = 'cover-kicker'; kicker.textContent = 'A BOOK BY';
  const title = document.createElement('strong'); title.className = 'cover-title'; title.textContent = book.title;
  const author = document.createElement('span'); author.className = 'cover-author'; author.textContent = book.author || 'Unknown author';
  const ornament = document.createElement('span'); ornament.className = 'cover-ornament'; ornament.textContent = '✳'; ornament.setAttribute('aria-hidden', 'true');
  cover.append(kicker, title, author, ornament);
  return cover;
}

function renderBooks() {
  if (!state.booksLoaded) return;
  const grid = $('#book-grid');
  grid.replaceChildren();
  const query = $('#search-input').value.trim().toLowerCase();
  const filtered = state.books.filter(book => `${book.title} ${book.author}`.toLowerCase().includes(query));
  $('#nav-count').textContent = String(state.books.length);
  $('#book-total').textContent = `${state.books.length} ${state.books.length === 1 ? 'book' : 'books'}`;
  $('#empty-state').hidden = state.books.length !== 0;
  $('#no-results').hidden = state.books.length === 0 || filtered.length !== 0;
  grid.hidden = filtered.length === 0;
  for (const book of filtered) {
    const card = document.createElement('article');
    card.className = 'book-card'; card.tabIndex = 0; card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Read ${book.title} by ${book.author}`);
    const art = document.createElement('div'); art.className = 'book-art-wrap'; art.append(makeCover(book));
    const meta = document.createElement('div'); meta.className = 'book-meta';
    const title = document.createElement('h3'); title.className = 'book-title'; title.textContent = book.title;
    const author = document.createElement('p'); author.className = 'book-author'; author.textContent = book.author || 'Unknown author';
    const bottom = document.createElement('div'); bottom.className = 'book-card-bottom';
    const progress = document.createElement('div'); progress.className = 'mini-progress';
    const bar = document.createElement('span'); bar.style.width = `${Math.max(1, book.progress || 0)}%`; progress.append(bar);
    const status = document.createElement('span');
    status.textContent = book.status === 'pending' ? 'Under review' : book.status === 'rejected' ? 'Not published' : book.progress ? `${book.progress}%` : 'Ready to read';
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete-book'; remove.setAttribute('aria-label', `Remove ${book.title}`); remove.title = 'Remove from library'; remove.textContent = 'Remove';
    remove.addEventListener('click', async event => {
      event.stopPropagation();
      if (!window.confirm(`Remove “${book.title}” from your library?`)) return;
      try { await api(`/api/books/${book.id}`, { method: 'DELETE' }); state.books = state.books.filter(item => item.id !== book.id); renderBooks(); notify('Book removed from your shelf.'); }
      catch (error) { notify(error.message); }
    });
    status.className = `book-status status-text-${book.status}`;
    bottom.append(progress, status, remove); meta.append(title, author, bottom);
    if (book.status === 'rejected') {
      const review = document.createElement('div'); review.className = 'book-review-note';
      if (book.reviewNote) { const note = document.createElement('p'); note.textContent = `“${book.reviewNote}”`; review.append(note); }
      const resubmit = document.createElement('button'); resubmit.type = 'button'; resubmit.className = 'text-button'; resubmit.textContent = 'Send for review again';
      resubmit.addEventListener('click', async event => {
        event.stopPropagation();
        try { await api(`/api/books/${book.id}/resubmit`, { method: 'POST', body: '{}' }); await loadBooks(); refreshAdminBadge(); notify('Sent back to the review queue.'); }
        catch (error) { notify(error.message); }
      });
      review.append(resubmit); meta.append(review);
    }
    card.append(art, meta);
    card.addEventListener('click', () => openReader(book));
    card.addEventListener('keydown', event => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openReader(book); } });
    grid.append(card);
  }
  renderOnboarding();
}

function renderPublicBooks() {
  const grid = $('#public-book-grid');
  grid.replaceChildren();
  const books = state.publicBooks;
  $('#public-book-total').textContent = `${books.length} ${books.length === 1 ? 'book' : 'books'}`;
  $('#public-empty').hidden = books.length > 0;
  grid.hidden = books.length === 0;
  for (const book of books) {
    const card = document.createElement('article');
    card.className = 'public-book-card'; card.tabIndex = 0; card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Read ${book.title} by ${book.author}`);
    const art = document.createElement('div'); art.className = 'public-book-art'; art.append(makeCover(book));
    const meta = document.createElement('div'); meta.className = 'public-book-meta';
    const title = document.createElement('h3'); title.className = 'book-title'; title.textContent = book.title;
    const author = document.createElement('p'); author.className = 'book-author'; author.textContent = book.author || 'Unknown author';
    meta.append(title, author); card.append(art, meta);
    const read = async () => {
      try { const result = await api(`/api/public/books/${book.id}`); openReader(result.book, 'public'); }
      catch (error) { notify(error.message); }
    };
    card.addEventListener('click', read);
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); read(); } });
    grid.append(card);
  }
}

function renderAdminBooks() {
  const list = $('#admin-book-list');
  const userList = $('#admin-user-list');
  list.replaceChildren();
  const counts = { pending: 0, published: 0, rejected: 0 };
  for (const book of state.adminBooks) counts[book.status] = (counts[book.status] || 0) + 1;
  $('#pending-count').textContent = counts.pending;
  $('#published-count').textContent = counts.published;
  $('#rejected-count').textContent = counts.rejected;
  $('#users-count').textContent = state.adminUsers.length;
  $('#stat-pending').textContent = counts.pending;
  $('#stat-published').textContent = counts.published;
  $('#stat-rejected').textContent = counts.rejected;
  $('#stat-readers').textContent = state.adminUsers.length;
  const publishedWords = state.adminBooks.filter(book => book.status === 'published').reduce((sum, book) => sum + (book.wordCount || 0), 0);
  $('#stat-words').textContent = `${publishedWords.toLocaleString()} words shared`;
  updateAdminBadge(counts.pending);

  const showingUsers = state.adminStatus === 'users';
  const showingInsights = state.adminStatus === 'insights';
  list.hidden = showingUsers || showingInsights;
  userList.hidden = !showingUsers;
  $('#admin-insights').hidden = !showingInsights;
  $('.admin-search').hidden = showingInsights;
  if (showingInsights) { $('#admin-empty').hidden = true; loadInsights(); return; }
  $('#admin-search').placeholder = showingUsers ? 'Search readers by name or email...' : 'Search by title, author or uploader...';
  const query = $('#admin-search').value.trim().toLowerCase();
  if (showingUsers) { renderAdminUsers(query); return; }

  const visible = state.adminBooks
    .filter(book => book.status === state.adminStatus)
    .filter(book => `${book.title} ${book.author} ${book.uploader?.name} ${book.uploader?.email}`.toLowerCase().includes(query));
  const empty = $('#admin-empty');
  empty.hidden = visible.length > 0;
  empty.querySelector('h2').textContent = query ? 'No matches.' : state.adminStatus === 'pending' ? 'All caught up.' : 'Nothing here yet.';
  empty.querySelector('p').textContent = query ? 'Try another title, author or uploader.' : state.adminStatus === 'pending' ? 'New book submissions will appear here for review.' : 'Books you review will be listed here.';

  for (const book of visible) {
    const card = el('article', 'moderation-card');
    const art = el('div', 'moderation-art');
    const cover = makeCover(book); cover.classList.add('moderation-cover'); art.append(cover);
    const detail = el('div', 'moderation-detail');
    const top = el('div', 'moderation-title-row');
    const heading = el('div');
    heading.append(el('h2', '', book.title), el('p', 'moderation-author', `by ${book.author || 'Unknown author'}`));
    top.append(heading, el('span', `status-badge status-${book.status}`, book.status === 'pending' ? 'Needs review' : book.status === 'published' ? 'Published' : 'Declined'));

    const uploader = el('p', 'uploader-line');
    uploader.append('Submitted by ', el('strong', '', book.uploader?.name || 'Unknown reader'), ` · ${book.uploader?.email || ''} · ${formatDate(book.createdAt)}`);
    const facts = el('p', 'moderation-facts', `${(book.wordCount || 0).toLocaleString()} words · about ${Math.max(1, Math.round((book.wordCount || 0) / 230))} min read${book.sourceName ? ` · ${book.sourceName}` : ''}`);
    const excerpt = el('p', 'submission-excerpt', book.contentPreview || 'This book has no text content.');
    detail.append(top, uploader, facts, excerpt);
    if (book.status !== 'pending' && (book.reviewer || book.reviewNote)) {
      const review = el('p', 'review-note');
      review.append(el('strong', '', `${book.status === 'published' ? 'Published' : 'Declined'}${book.reviewer ? ` by ${book.reviewer}` : ''} · ${formatDate(book.reviewedAt)}`));
      if (book.reviewNote) review.append(el('span', '', `“${book.reviewNote}”`));
      detail.append(review);
    }

    const actions = el('div', 'moderation-actions');
    actions.append(actionButton('Read full book', 'button-secondary', async () => {
      try { const result = await api(`/api/admin/books/${book.id}`); openReader(result.book, 'admin'); }
      catch (error) { notify(error.message); }
    }));
    if (book.status === 'pending') {
      actions.append(actionButton('Approve & publish', 'button-primary', () => setBookStatus(book, 'published')));
      actions.append(actionButton('Decline…', 'button-quiet', () => {
        actions.hidden = true;
        const form = el('form', 'decline-form');
        const label = el('label', 'field');
        label.append(el('span', '', 'Note for the uploader (optional)'));
        const note = el('textarea'); note.rows = 2; note.maxLength = 500; note.placeholder = 'e.g. Please remove the copyrighted chapters and resubmit.';
        label.append(note);
        const row = el('div', 'moderation-actions');
        const confirm = el('button', 'button button-quiet', 'Decline submission'); confirm.type = 'submit';
        row.append(confirm, actionButton('Cancel', 'button-secondary', () => { form.remove(); actions.hidden = false; }));
        form.append(label, row);
        form.addEventListener('submit', event => { event.preventDefault(); confirm.disabled = true; setBookStatus(book, 'rejected', note.value); });
        detail.append(form);
        note.focus();
      }));
    } else {
      actions.append(actionButton(book.status === 'published' ? 'Unpublish' : 'Return to review', 'button-secondary', () => setBookStatus(book, 'pending')));
    }
    actions.append(actionButton('Delete', 'button-danger', async () => {
      if (!window.confirm(`Permanently delete “${book.title}”? This removes it for the uploader too.`)) return;
      try { await api(`/api/admin/books/${book.id}`, { method: 'DELETE' }); await loadAdminBooks(); loadBooks(); loadPublicBooks(); notify('Book deleted.'); }
      catch (error) { notify(error.message); }
    }));
    detail.append(actions); card.append(art, detail); list.append(card);
  }
}

function renderAdminUsers(query) {
  const list = $('#admin-user-list');
  list.replaceChildren();
  const visible = state.adminUsers.filter(user => `${user.name} ${user.email}`.toLowerCase().includes(query));
  const empty = $('#admin-empty');
  empty.hidden = visible.length > 0;
  empty.querySelector('h2').textContent = 'No readers found.';
  empty.querySelector('p').textContent = 'Try another name or email.';
  for (const user of visible) {
    const row = el('div', 'user-row');
    const avatar = el('span', 'user-avatar', (user.name || '?').trim().charAt(0).toUpperCase());
    const who = el('div', 'user-who');
    const name = el('strong', '', user.name);
    if (user.isYou) name.append(el('em', '', ' (you)'));
    who.append(name, el('span', '', user.email));
    const stats = el('div', 'user-stats', `${user.bookCount} uploaded · ${user.publishedCount} published · joined ${formatDate(user.createdAt)}`);
    const role = el('span', `role-badge role-${user.role}`, user.role === 'admin' ? 'Admin' : 'Reader');
    const actions = el('div', 'user-actions');
    if (!user.isYou && !(user.lockedAdmin && user.role === 'admin')) {
      const next = user.role === 'admin' ? 'reader' : 'admin';
      actions.append(actionButton(next === 'admin' ? 'Make admin' : 'Remove admin', 'button-secondary', async () => {
        if (next === 'admin' && !window.confirm(`Give ${user.name} admin access? They will be able to publish, decline and delete books.`)) return;
        try {
          await api(`/api/admin/users/${user.id}/role`, { method: 'PATCH', body: JSON.stringify({ role: next }) });
          await loadAdminBooks();
          notify(next === 'admin' ? `${user.name} is now an admin.` : `${user.name} is now a reader.`);
        } catch (error) { notify(error.message); }
      }));
    }
    row.append(avatar, who, stats, role, actions);
    list.append(row);
  }
}

function switchView(view) {
  navigate(view === 'community' ? '/community' : `/${view}`);
}

const SECTIONS = ['library', 'add', 'admin', 'account'];
function showSection(view) {
  for (const name of SECTIONS) $(`#${name}-view`).hidden = name !== view;
  $$('.nav-item, .mobile-nav-item').forEach(item => {
    const active = item.dataset.view === view;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  if (view === 'library') loadBooks();
  if (view === 'admin') loadAdminBooks();
  if (view === 'account') fillAccount();
  if (view === 'add') {
    $('#book-error').textContent = '';
    if (state.user.verificationRequired && !state.user.emailVerified) $('#book-error').textContent = 'Confirm your email address first: use the link we sent you, or send a new one from the banner above.';
    $('#book-title').focus({ preventScroll: true });
  }
  window.scrollTo({ top: 0 });
}

function fillAccount() {
  const user = state.user;
  $('#profile-form [name="name"]').value = user.name;
  $('#account-email').value = user.email;
  const since = `Member since ${formatDate(user.createdAt)}.`;
  $('#account-verified').textContent = user.emailVerified ? `Email confirmed. ${since}` : user.verificationRequired ? `Not confirmed yet: check your inbox for our link. ${since}` : since;
}

function updateCoverPreview() {
  const preview = $('#cover-preview');
  preview.className = `cover-preview theme-${state.coverTheme}`;
  preview.style.backgroundImage = state.coverImage ? `linear-gradient(#0002,#0005), url("${state.coverImage}")` : '';
  preview.style.backgroundSize = state.coverImage ? 'cover' : '';
  preview.style.backgroundPosition = state.coverImage ? 'center' : '';
  $('#cover-preview-title').textContent = ($('#book-title').value.trim() || 'YOUR TITLE').toUpperCase();
  $('#cover-preview-author').textContent = ($('#book-author').value.trim() || 'YOUR NAME').toUpperCase();
}

// Book formatting: chapter headings start a fresh page, paragraphs get book typography, and light
// Markdown (headings, bold, quotes, rules) is tidied so .md files read like a printed book.
const CHAPTER_LINE = /^(#{1,2}\s+\S.*|(chapter|part|book|act|section)\s+([0-9]+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b.*|(prologue|epilogue|preface|introduction|afterword)\b.*)$/i;

function cleanMarkdown(text) {
  return text
    .replace(/^#{3,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, '⁂');
}

function parseChapters(text) {
  const lines = cleanMarkdown(text.replace(/\r\n?/g, '\n')).split('\n');
  const chapters = [];
  let current = { title: '', lines: [] };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const standsAlone = index === 0 || !lines[index - 1].trim();
    if (standsAlone && trimmed.length <= 90 && CHAPTER_LINE.test(trimmed)) {
      if (current.title || current.lines.join('').trim()) chapters.push(current);
      current = { title: trimmed.replace(/^#{1,2}\s+/, ''), lines: [] };
    } else current.lines.push(line);
  });
  chapters.push(current);
  return chapters.map(chapter => ({ title: chapter.title, text: chapter.lines.join('\n').trim() })).filter(chapter => chapter.title || chapter.text);
}

function splitText(text, limit, firstLimit = limit) {
  const pages = [];
  let remaining = text.trim();
  let size = firstLimit;
  while (remaining.length > size) {
    let cut = remaining.lastIndexOf('\n', size);
    if (cut < size * .55) cut = remaining.lastIndexOf(' ', size);
    if (cut < size * .55) cut = size;
    pages.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
    size = limit;
  }
  if (remaining || !pages.length) pages.push(remaining);
  return pages;
}

function buildPages(text, limit) {
  const pages = [];
  const chapters = [];
  for (const chapter of parseChapters(text)) {
    if (chapter.title) chapters.push({ title: chapter.title, page: pages.length });
    splitText(chapter.text, limit, chapter.title ? Math.floor(limit * .72) : limit).forEach((chunk, index) => {
      pages.push({ heading: index === 0 ? chapter.title : '', chapterTitle: chapters.at(-1)?.title || '', text: chunk, words: (chunk.match(/\S+/g) || []).length });
    });
  }
  if (!pages.length) pages.push({ heading: '', chapterTitle: '', text: '', words: 0 });
  return { pages, chapters };
}

function fillCopy(copy, page) {
  copy.replaceChildren();
  if (!page) return;
  if (page.heading) {
    const heading = document.createElement('h3'); heading.className = 'page-chapter'; heading.textContent = page.heading;
    copy.append(heading);
  }
  page.text.split(/\n{2,}/).forEach((paragraph, index) => {
    if (!paragraph.trim()) return;
    const p = document.createElement('p');
    if (paragraph.trim() === '⁂') p.className = 'page-break-mark';
    else if (index === 0 && page.heading) p.className = 'drop-cap';
    p.textContent = paragraph;
    copy.append(p);
  });
}

function pageArticle(side) {
  const article = document.createElement('article');
  article.className = `reader-page ${side}`;
  const title = document.createElement('span'); title.className = 'page-running-title';
  const copy = document.createElement('div'); copy.className = 'page-copy';
  const number = document.createElement('span'); number.className = 'page-number';
  article.append(title, copy, number);
  return article;
}

function fillPage(article, index) {
  const page = state.pages[index];
  const book = state.activeBook;
  // Like a printed book: the book title runs on the left, the current chapter on the right.
  article.querySelector('.page-running-title').textContent = !page || page.heading ? '' : index % 2 === 0 ? book.title : (page.chapterTitle || book.author || book.title);
  fillCopy(article.querySelector('.page-copy'), page);
  article.querySelector('.page-number').textContent = page ? String(index + 1) : '';
  article.classList.toggle('blank-page', !page);
}

// Estimates how many characters fit on one page at the current size, by measuring a sample of the book.
function pageCapacity(text) {
  const page = $('#left-page');
  const copy = $('#left-copy');
  copy.replaceChildren();
  const available = page.getBoundingClientRect().bottom - parseFloat(getComputedStyle(page).paddingBottom) - copy.getBoundingClientRect().top;
  const sample = cleanMarkdown(text.replace(/\r\n?/g, '\n')).trim().slice(0, 3000) || 'Sample text';
  copy.style.minHeight = '0';
  fillCopy(copy, { heading: '', text: sample });
  const used = copy.scrollHeight;
  copy.style.minHeight = '';
  copy.replaceChildren();
  if (!available || !used) return 420;
  return Math.max(150, Math.min(4000, Math.floor(sample.length * (available / used) * 0.88)));
}

function renderSpread() {
  fillPage($('#left-page'), state.pageIndex);
  fillPage($('#right-page'), state.pageIndex + 1);
}

function currentPercent() {
  const spreadCount = Math.ceil(state.pages.length / 2);
  return spreadCount <= 1 ? 0 : Math.round((state.pageIndex / 2) / (spreadCount - 1) * 100);
}

function updateReaderMeta() {
  const book = state.activeBook;
  const leftIndex = state.pageIndex;
  const total = state.pages.length;
  $('#reader-title').textContent = book.title;
  const backTo = state.readerMode === 'public' ? 'Community shelf' : state.readerMode === 'admin' ? 'Review queue' : 'My library';
  $('#reader-close-label').textContent = backTo;
  $('#reader-close').setAttribute('aria-label', `Back to ${backTo.toLowerCase()}`);
  $('#reader-author').textContent = book.author || 'Unknown author';
  const displayStart = Math.min(leftIndex + 1, total);
  const displayEnd = Math.min(leftIndex + 2, total);
  $('#page-count').textContent = displayStart === displayEnd ? `Page ${displayStart} of ${total}` : `Pages ${displayStart}–${displayEnd} of ${total}`;
  const percent = currentPercent();
  $('#progress-percent').textContent = `${percent}%`;
  $('#progress-bar').style.width = `${percent}%`;
  $('#reader-progress-label').textContent = `${percent}% COMPLETE`;
  $('#prev-page').disabled = leftIndex === 0;
  $('#next-page').disabled = leftIndex + 2 >= total;
  const wordsLeft = state.pages.slice(leftIndex).reduce((sum, page) => sum + page.words, 0);
  const minutes = Math.round(wordsLeft / 230);
  $('#reader-time-left').textContent = wordsLeft === 0 ? 'THE END' : minutes < 1 ? 'LESS THAN A MINUTE LEFT' : `ABOUT ${minutes} MIN LEFT`;
  // The page edges thicken on whichever side holds more of the book.
  const fraction = total <= 2 ? 0 : leftIndex / (total - 2);
  $('#book-spread').style.setProperty('--stack-left', `${2 + Math.round(fraction * 9)}px`);
  $('#book-spread').style.setProperty('--stack-right', `${2 + Math.round((1 - fraction) * 9)}px`);
  $$('#contents-list button').forEach(button => {
    const start = Number(button.dataset.page);
    const next = Number(button.dataset.next);
    button.classList.toggle('current', leftIndex + 1 >= start && leftIndex < next);
  });
  clearTimeout(state.progressTimer);
  if (state.readerMode === 'private') {
    state.progressTimer = setTimeout(() => {
      api(`/api/books/${book.id}/progress`, { method: 'PATCH', body: JSON.stringify({ progress: percent }) }).then(() => {
        book.progress = percent;
        renderBooks();
      }).catch(() => {});
    }, 250);
  }
}

function renderReader() {
  renderSpread();
  updateReaderMeta();
}

function lastSpreadIndex() {
  return Math.max(0, Math.ceil(state.pages.length / 2) - 1) * 2;
}

function currentFraction() {
  const spreadCount = Math.ceil(state.pages.length / 2);
  return spreadCount <= 1 ? 0 : (state.pageIndex / 2) / (spreadCount - 1);
}

function paginate(fraction) {
  finishFlip();
  const { pages, chapters } = buildPages(state.activeBook.content, pageCapacity(state.activeBook.content));
  state.pages = pages;
  state.chapters = chapters;
  const spreadCount = Math.ceil(pages.length / 2);
  state.pageIndex = Math.min(Math.round(fraction * Math.max(0, spreadCount - 1)) * 2, lastSpreadIndex());
  renderContents();
}

function renderContents() {
  const list = $('#contents-list');
  list.replaceChildren();
  $('#reader-contents').hidden = state.chapters.length < 2;
  state.chapters.forEach((chapter, index) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.page = String(chapter.page + 1);
    button.dataset.next = String(state.chapters[index + 1]?.page ?? state.pages.length);
    const name = document.createElement('span'); name.textContent = chapter.title;
    const number = document.createElement('small'); number.textContent = String(chapter.page + 1);
    button.append(name, number);
    button.addEventListener('click', () => { toggleContents(false); turnTo(chapter.page - (chapter.page % 2)); });
    item.append(button);
    list.append(item);
  });
}

function toggleContents(open = $('#contents-panel').hidden) {
  $('#contents-panel').hidden = !open;
  $('#reader-contents').setAttribute('aria-expanded', String(open));
  if (open) ($('#contents-list button.current') || $('#contents-list button'))?.focus({ preventScroll: true });
}

function applyTextSize() {
  $('#reader').dataset.textSize = state.textSize;
  $('#reader-menu').title = `Text size: ${state.textSize}`;
  $('#reader-menu').setAttribute('aria-label', `Change text size (now ${state.textSize})`);
}

function applySoundButtons() {
  $('#reader-sound').setAttribute('aria-pressed', String(ShelfSound.effects));
  $('#reader-sound').title = ShelfSound.effects ? 'Page sounds on' : 'Page sounds off';
  $('#reader-sound').setAttribute('aria-label', ShelfSound.effects ? 'Turn page sounds off' : 'Turn page sounds on');
  $('#reader-rain').setAttribute('aria-pressed', String(ShelfSound.rain));
  $('#reader-rain').title = ShelfSound.rain ? 'Rain ambience on' : 'Rain ambience off';
  $('#reader-rain').setAttribute('aria-label', ShelfSound.rain ? 'Turn rain ambience off' : 'Turn rain ambience on');
}

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Opening: the cover swings open on its spine before the first spread settles in.
function playCoverOpen(book) {
  const spread = $('#book-spread');
  const flap = $('#cover-flap');
  spread.classList.remove('opening');
  $('#book-object').classList.remove('arriving');
  if (reducedMotion.matches) return;
  flap.querySelector('.flap-front').className = `flap-front theme-${escapeClass(book.coverTheme)}`;
  flap.querySelector('.flap-front').style.backgroundImage = book.coverImage ? `linear-gradient(#0002,#0006), url("${book.coverImage}")` : '';
  flap.querySelector('.flap-title').textContent = book.title;
  flap.querySelector('.flap-author').textContent = book.author || 'Unknown author';
  void spread.offsetWidth;
  spread.classList.add('opening');
  $('#book-object').classList.add('arriving');
  ShelfSound.bookOpen();
  flap.addEventListener('animationend', () => { spread.classList.remove('opening'); $('#book-object').classList.remove('arriving'); }, { once: true });
}

function finishFlip() {
  if (state.flip) state.flip.done();
}

// A page turn is a real 3D leaf: its front is the page you were reading and its back is the next one.
function turnTo(target) {
  if (!state.activeBook) return;
  target = Math.max(0, Math.min(lastSpreadIndex(), target));
  finishFlip();
  if (target === state.pageIndex) return;
  const from = state.pageIndex;
  const forward = target > from;
  ShelfSound.pageTurn();
  state.pageIndex = target;
  if (reducedMotion.matches) { renderReader(); return; }
  const leaf = document.createElement('div');
  leaf.className = `page-leaf ${forward ? 'leaf-forward' : 'leaf-backward'}`;
  leaf.setAttribute('aria-hidden', 'true');
  const front = pageArticle(forward ? 'right-page' : 'left-page');
  const back = pageArticle(forward ? 'left-page' : 'right-page');
  fillPage(front, forward ? from + 1 : from);
  fillPage(back, forward ? target : target + 1);
  front.classList.add('leaf-front');
  back.classList.add('leaf-back');
  leaf.append(front, back);
  // Reveal the destination underneath the turning leaf; the other side changes when it lands.
  if (forward) fillPage($('#right-page'), target + 1);
  else fillPage($('#left-page'), target);
  $('#book-spread').append(leaf);
  $('#book-spread').classList.add(forward ? 'turning-forward' : 'turning-backward');
  let finished = false;
  state.flip = {
    done() {
      if (finished) return;
      finished = true;
      leaf.remove();
      $('#book-spread').classList.remove('turning-forward', 'turning-backward');
      state.flip = null;
      renderSpread();
    }
  };
  leaf.addEventListener('animationend', state.flip.done, { once: true });
  updateReaderMeta();
}

async function openReader(book, mode = 'private') {
  if (typeof book.content !== 'string') {
    try { book = Object.assign(book, (await api(`/api/books/${book.id}`)).book); }
    catch (error) { notify(error.message); return; }
  }
  state.activeBook = book;
  state.readerMode = mode;
  applyTextSize();
  applySoundButtons();
  toggleContents(false);
  $('#reader').hidden = false;
  document.body.style.overflow = 'hidden';
  paginate((book.progress || 0) / 100);
  renderReader();
  playCoverOpen(book);
  $('#reader-close').focus({ preventScroll: true });
  document.title = `${book.title}${book.author && book.author !== 'Unknown author' ? ` by ${book.author}` : ''} · Shelfspace`;
  try { localStorage.setItem('shelfspace-opened-book', '1'); } catch {}
}

function cycleTextSize() {
  state.textSize = TEXT_SIZES[(TEXT_SIZES.indexOf(state.textSize) + 1) % TEXT_SIZES.length];
  try { localStorage.setItem('shelfspace-text-size', state.textSize); } catch {}
  applyTextSize();
  if (!state.activeBook) return;
  paginate(currentFraction());
  renderReader();
  notify(`Text size: ${state.textSize}`);
}

function closeReader() {
  finishFlip();
  ShelfSound.stopAmbience();
  ShelfSound.bookClose();
  toggleContents(false);
  $('#reader').hidden = true;
  document.body.style.overflow = '';
  const wasPrivate = state.readerMode === 'private';
  state.activeBook = null;
  document.title = state.pageTitle;
  if (wasPrivate) renderBooks();
  else renderOnboarding();
}

function movePages(direction) {
  if (!state.activeBook) return;
  turnTo(state.pageIndex + direction * 2);
}

$$('[data-auth-mode]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.authMode === 'register' ? '/signup' : `/login${location.search}`)));
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const isRegister = state.authMode === 'register';
  $('#auth-error').textContent = '';
  const rules = isRegister ? { name: RULES.name, email: RULES.email, password: RULES.newPassword } : { email: RULES.email, password: RULES.password };
  if (!validate(form, rules)) return;
  const data = new FormData(form);
  const payload = { email: data.get('email'), password: data.get('password') };
  if (isRegister) { payload.name = data.get('name'); payload.website = data.get('website'); }
  await busy(form.querySelector('button[type="submit"]'), async () => {
    try {
      const result = await api(isRegister ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(payload) });
      state.user = result.user;
      form.reset();
      navigate(isRegister ? '/library' : safeNext(new URLSearchParams(location.search).get('next')));
      if (isRegister) notify(result.user.verificationRequired ? `Welcome, ${result.user.name.split(/\s+/)[0]}! We sent a confirmation link to ${result.user.email}.` : `Welcome to Shelfspace, ${result.user.name.split(/\s+/)[0]}!`);
    } catch (error) { showFormError(form, error); }
  });
});

$('#forgot-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  $('#forgot-error').textContent = '';
  if (!validate(form, { email: RULES.email })) return;
  await busy(form.querySelector('button[type="submit"]'), async () => {
    try {
      const result = await api('/api/password/forgot', { method: 'POST', body: JSON.stringify({ email: form.elements.email.value }) });
      const sent = $('#forgot-sent');
      sent.hidden = false;
      sent.innerHTML = result.emailEnabled
        ? '<strong>Check your inbox.</strong> If an account uses that address, a reset link is on its way. It works for one hour.'
        : '<strong>Request received.</strong> This site has not set up email yet, so the reset link goes to the site owner. Please contact them to get it.';
    } catch (error) { showFormError(form, error); }
  });
});

$('#reset-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  $('#reset-error').textContent = '';
  const ok = validate(form, {
    password: RULES.newPassword,
    confirm: value => !value ? 'Type your new password again.' : value !== form.elements.password.value ? 'The two passwords do not match yet.' : ''
  });
  if (!ok) return;
  if (!state.resetToken) { $('#reset-error').textContent = 'This page needs the link from your reset email. Ask for a new link below.'; return; }
  await busy(form.querySelector('button[type="submit"]'), async () => {
    try {
      const result = await api('/api/password/reset', { method: 'POST', body: JSON.stringify({ token: state.resetToken, password: form.elements.password.value }) });
      state.resetToken = '';
      state.user = result.user;
      state.workspaceUser = null;
      form.reset();
      navigate('/library');
      notify('Password saved. You are signed in, and your other devices were signed out.');
    } catch (error) { showFormError(form, error); }
  });
});

async function signOut() {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  resetSession();
  navigate('/login');
  notify('You have signed out. See you soon.');
}
$('#signout-button').addEventListener('click', signOut);
$('#mobile-signout').addEventListener('click', signOut);

$('#resend-verification').addEventListener('click', event => busy(event.currentTarget, async () => {
  try {
    const result = await api('/api/email/resend', { method: 'POST', body: '{}' });
    if (result.alreadyVerified) { state.user.emailVerified = true; updateUserChrome(); notify('Your email is already confirmed.'); }
    else notify(`A new link is on its way to ${state.user.email}.`);
  } catch (error) { notify(error.message); }
}));

$('#onboarding-dismiss').addEventListener('click', () => { $('#onboarding').hidden = true; finishOnboarding(); });

$('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  $('#profile-error').textContent = '';
  if (!validate(form, { name: RULES.name })) return;
  await busy(form.querySelector('button[type="submit"]'), async () => {
    try {
      const { user } = await api('/api/account', { method: 'PATCH', body: JSON.stringify({ name: form.elements.name.value }) });
      state.user = user;
      updateUserChrome();
      notify('Your profile is saved.');
    } catch (error) { showFormError(form, error); }
  });
});

$('#password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  $('#password-error').textContent = '';
  if (!validate(form, { currentPassword: RULES.currentPassword, newPassword: RULES.newPassword })) return;
  await busy(form.querySelector('button[type="submit"]'), async () => {
    try {
      await api('/api/account/password', { method: 'POST', body: JSON.stringify({ currentPassword: form.elements.currentPassword.value, newPassword: form.elements.newPassword.value }) });
      form.reset();
      notify('Password updated. Your other devices have been signed out.');
    } catch (error) { showFormError(form, error); }
  });
});

$('#signout-everywhere').addEventListener('click', event => {
  if (!window.confirm('Sign out of Shelfspace on every device, including this one?')) return;
  busy(event.currentTarget, async () => {
    try {
      await api('/api/logout-all', { method: 'POST', body: '{}' });
      resetSession();
      navigate('/login');
      notify('Signed out everywhere.');
    } catch (error) { notify(error.message); }
  });
});

$('#export-account').addEventListener('click', event => busy(event.currentTarget, async () => {
  try { await downloadFile('/api/account/export', 'my-shelfspace.json'); notify('Your data is downloading.'); }
  catch (error) { notify(error.message); }
}));

$('#delete-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  $('#delete-error').textContent = '';
  if (!validate(form, { password: RULES.password })) return;
  const count = state.books.length;
  if (!window.confirm(`Delete your account${count ? ` and your ${count} ${count === 1 ? 'book' : 'books'}` : ''}? This cannot be undone.`)) return;
  await busy(form.querySelector('button[type="submit"]'), async () => {
    try {
      await api('/api/account', { method: 'DELETE', body: JSON.stringify({ password: form.elements.password.value }) });
      resetSession();
      navigate('/');
      notify('Your account and books have been deleted.');
    } catch (error) { showFormError(form, error); }
  });
});

$$('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
$('.profile').addEventListener('click', event => { if (!event.target.closest('button')) switchView('account'); });
$('#public-return').addEventListener('click', () => navigate(state.user ? '/library' : '/login'));
// In-app links change the page without a full reload; ordinary links (privacy, terms) still navigate.
document.addEventListener('click', event => {
  const link = event.target.closest('a[data-link]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
});
window.addEventListener('popstate', route);
$('#refresh-admin').addEventListener('click', () => (state.adminStatus === 'insights' ? loadInsights() : loadAdminBooks()));
$('#clear-errors').addEventListener('click', async () => {
  if (!window.confirm('Clear every error report?')) return;
  try { await api('/api/admin/errors', { method: 'DELETE' }); await loadInsights(); notify('Error reports cleared.'); }
  catch (error) { notify(error.message); }
});
$('#export-data').addEventListener('click', event => busy(event.currentTarget, async () => {
  try { await downloadFile('/api/admin/export', 'shelfspace-export.json'); notify('Export downloaded.'); }
  catch (error) { notify(error.message); }
}));
function selectAdminTab(status) {
  state.adminStatus = status;
  $$('[data-admin-status]').forEach(tab => {
    const active = tab.dataset.adminStatus === status;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
}
$$('[data-admin-status]').forEach(button => button.addEventListener('click', () => {
  selectAdminTab(button.dataset.adminStatus);
  renderAdminBooks();
}));
$('#search-input').addEventListener('input', renderBooks);
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
  if ($('#workspace').hidden || !$('#reader').hidden) return;
  event.preventDefault();
  if ($('#library-view').hidden) switchView('library');
  $('#search-input').focus();
});
if (!/Mac|iPhone|iPad/.test(navigator.platform)) $('.search-box kbd').textContent = 'Ctrl K';

const fileInput = $('#book-file');
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) { $('#book-error').textContent = 'That file is over 2 MB. Choose a smaller text file.'; fileInput.value = ''; return; }
  try {
    const text = await file.text();
    $('#book-content').value = text;
    state.sourceName = file.name;
    const suggested = file.name.replace(/\.(txt|md)$/i, '').replace(/[_-]+/g, ' ').trim();
    if (!$('#book-title').value.trim()) $('#book-title').value = suggested;
    $('#upload-title').textContent = file.name;
    $('#upload-hint').textContent = `${(file.size / 1024).toFixed(0)} KB · ready to add`;
    $('#book-error').textContent = '';
    updateCoverPreview();
  } catch { $('#book-error').textContent = 'We couldn’t read that file. Try a UTF-8 text file.'; }
});

const dropZone = $('#drop-zone');
['dragenter', 'dragover'].forEach(name => dropZone.addEventListener(name, event => { event.preventDefault(); dropZone.classList.add('dragging'); }));
['dragleave', 'drop'].forEach(name => dropZone.addEventListener(name, event => {
  event.preventDefault();
  if (event.type === 'dragleave' && dropZone.contains(event.relatedTarget)) return;
  dropZone.classList.remove('dragging');
}));
dropZone.addEventListener('drop', event => {
  const file = [...event.dataTransfer.files].find(item => /\.(txt|md)$/i.test(item.name));
  if (!file) { $('#book-error').textContent = 'Choose a .txt or .md file.'; return; }
  const transfer = new DataTransfer(); transfer.items.add(file); fileInput.files = transfer.files; fileInput.dispatchEvent(new Event('change'));
});

$('#cover-file').addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  if (file.size > 1024 * 1024) { $('#book-error').textContent = 'Cover images must be under 1 MB.'; event.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => { state.coverImage = reader.result; $('#remove-cover').hidden = false; $('#book-error').textContent = ''; updateCoverPreview(); };
  reader.readAsDataURL(file);
});
$('#remove-cover').addEventListener('click', () => { state.coverImage = ''; $('#cover-file').value = ''; $('#remove-cover').hidden = true; updateCoverPreview(); });
$$('.theme-swatch').forEach(button => button.addEventListener('click', () => {
  state.coverTheme = button.dataset.theme;
  $$('.theme-swatch').forEach(item => item.classList.toggle('selected', item === button));
  updateCoverPreview();
}));
$('#book-title').addEventListener('input', updateCoverPreview);
$('#book-author').addEventListener('input', updateCoverPreview);

$('#book-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  const content = $('#book-content').value;
  const title = $('#book-title').value.trim();
  $('#book-error').textContent = '';
  setFieldError($('#book-title'), title ? '' : 'Give your book a title. The file name works fine.');
  setFieldError($('#book-content'), content.trim() ? '' : 'Upload a text file above, or paste some book text here.');
  if (!content.trim()) { $('#book-content').focus(); return; }
  if (!title) { $('#book-title').focus(); return; }
  await busy(button, async () => {
    try {
      const { book } = await api('/api/books', { method: 'POST', body: JSON.stringify({ title, author: $('#book-author').value.trim(), content, coverTheme: state.coverTheme, coverImage: state.coverImage, sourceName: state.sourceName }) });
      state.books.unshift(book);
      form.reset();
      $('#book-content').value = ''; $('#book-file').value = ''; $('#cover-file').value = ''; $('#book-author').value = '';
      $('#upload-title').textContent = 'Drop your file here'; $('#upload-hint').innerHTML = 'or <u>browse your device</u>';
      state.sourceName = ''; state.coverImage = ''; state.coverTheme = 'midnight';
      $('#remove-cover').hidden = true; $$('.theme-swatch').forEach(item => item.classList.toggle('selected', item.dataset.theme === 'midnight'));
      updateCoverPreview(); navigate('/library'); openReader(book);
      notify('Your book is on your shelf and waiting for an editor to review it. Enjoy reading!');
    } catch (error) { showFormError(form, error, { title: $('#book-title'), content: $('#book-content') }); }
  });
});

$('#reader-close').addEventListener('click', closeReader);
$('#prev-page').addEventListener('click', () => movePages(-1));
$('#next-page').addEventListener('click', () => movePages(1));
$('#reader-menu').addEventListener('click', cycleTextSize);
$('#reader-contents').addEventListener('click', () => toggleContents());
$('#contents-close').addEventListener('click', () => { toggleContents(false); $('#reader-contents').focus(); });
$('#reader-sound').addEventListener('click', () => { ShelfSound.toggleEffects(); applySoundButtons(); notify(ShelfSound.effects ? 'Page sounds on' : 'Page sounds off'); });
$('#reader-rain').addEventListener('click', () => { ShelfSound.toggleRain(); applySoundButtons(); notify(ShelfSound.rain ? 'Soft rain on. Enjoy the quiet.' : 'Rain off'); });
$('#admin-search').addEventListener('input', renderAdminBooks);

// Click a page to turn it, or swipe on touch screens.
let lastSwipe = 0;
$('#left-page').addEventListener('click', () => { if (Date.now() - lastSwipe > 400 && window.getSelection().isCollapsed) movePages(-1); });
$('#right-page').addEventListener('click', () => { if (Date.now() - lastSwipe > 400 && window.getSelection().isCollapsed) movePages(1); });
let swipeStart = null;
$('#book-object').addEventListener('pointerdown', event => { if (event.pointerType !== 'mouse') swipeStart = { x: event.clientX, y: event.clientY }; });
$('#book-object').addEventListener('pointerup', event => {
  if (!swipeStart) return;
  const dx = event.clientX - swipeStart.x;
  const dy = event.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) { lastSwipe = Date.now(); movePages(dx < 0 ? 1 : -1); }
});

// The open book leans gently toward the pointer, like holding it in your hands.
$('.reader-stage').addEventListener('pointermove', event => {
  if (event.pointerType !== 'mouse' || reducedMotion.matches) return;
  const box = $('.reader-stage').getBoundingClientRect();
  const x = (event.clientX - box.left) / box.width - .5;
  const y = (event.clientY - box.top) / box.height - .5;
  $('#book-spread').style.setProperty('--tilt-x', `${(x * 6).toFixed(2)}deg`);
  $('#book-spread').style.setProperty('--tilt-y', `${(-y * 4).toFixed(2)}deg`);
});
$('.reader-stage').addEventListener('pointerleave', () => {
  $('#book-spread').style.setProperty('--tilt-x', '0deg');
  $('#book-spread').style.setProperty('--tilt-y', '0deg');
});
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.activeBook || $('#reader').hidden) return;
    paginate(currentFraction());
    renderReader();
  }, 200);
});
document.addEventListener('keydown', event => {
  if ($('#reader').hidden) return;
  if (event.key === 'Escape') {
    if (!$('#contents-panel').hidden) { toggleContents(false); $('#reader-contents').focus(); }
    else closeReader();
    return;
  }
  if (event.target.closest?.('#contents-panel')) return;
  if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); movePages(-1); }
  if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); movePages(1); }
  if (event.key === 'Home') { event.preventDefault(); turnTo(0); }
  if (event.key === 'End') { event.preventDefault(); turnTo(lastSpreadIndex()); }
});

async function start() {
  try {
    const { user } = await api('/api/me');
    state.user = user;
  } catch { /* The sign-in screen is still usable if the API is unavailable. */ }
  route();
}
start();
