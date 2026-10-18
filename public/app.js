const state = { user: null, books: [], publicBooks: [], adminBooks: [], adminUsers: [], adminStatus: 'pending', chapters: [], flip: null, authMode: 'login', coverTheme: 'midnight', coverImage: '', sourceName: '', activeBook: null, readerMode: 'private', pages: [], pageIndex: 0, toastTimer: null, textSize: readTextSize() };
const TEXT_SIZES = ['small', 'medium', 'large'];
function readTextSize() {
  try { return localStorage.getItem('shelfspace-text-size') || 'medium'; } catch { return 'medium'; }
}

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function escapeClass(value) { return /^[a-z]+$/.test(value) ? value : 'midnight'; }

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === 'register';
  $$('.auth-tab').forEach(tab => {
    const active = tab.dataset.authMode === mode;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
  $('#name-field').hidden = !isRegister;
  $('#name-field input').required = isRegister;
  $('#auth-heading').innerHTML = isRegister ? 'Make room for<br>your next story.' : 'Pick up where<br>you left off.';
  $('#auth-eyebrow').textContent = isRegister ? 'YOUR OWN LITTLE LIBRARY' : 'WELCOME BACK';
  $('#auth-intro').textContent = isRegister ? 'Create an account and start building your shelf.' : 'Sign in to find your next favorite page.';
  $('#auth-submit-label').textContent = isRegister ? 'Create my account' : 'Sign in';
  $('#auth-form [name="password"]').autocomplete = isRegister ? 'new-password' : 'current-password';
  $('#auth-error').textContent = '';
}

function showWorkspace() {
  $('#auth-view').hidden = true;
  $('#public-view').hidden = true;
  $('#workspace').hidden = false;
  $('#admin-nav').hidden = state.user.role !== 'admin';
  $('#profile-name').textContent = state.user.name;
  $('#profile-email').textContent = state.user.email;
  $('#avatar').textContent = (state.user.name || 'S').trim().charAt(0).toUpperCase();
  $('#welcome-title').textContent = `A shelf of your own, ${state.user.name.split(/\s+/)[0]}.`;
  const hours = new Date().getHours();
  $('#today-label').textContent = hours < 12 ? 'A GOOD MORNING FOR A STORY' : hours < 18 ? 'A LITTLE TIME FOR A STORY' : 'A QUIET EVENING FOR A STORY';
  $('#library-view').hidden = false;
  $('#add-view').hidden = true;
  $('#admin-view').hidden = true;
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === 'library'));
  loadBooks();
  refreshAdminBadge();
}

function showAuth() {
  $('#reader').hidden = true;
  $('#public-view').hidden = true;
  $('#workspace').hidden = true;
  $('#auth-view').hidden = false;
  document.body.style.overflow = '';
  state.user = null;
  state.books = [];
  state.adminBooks = [];
  state.adminUsers = [];
  selectAdminTab('pending');
  $('#admin-search').value = '';
  $('#auth-form').reset();
  setAuthMode('login');
}

function showPublic() {
  $('#auth-view').hidden = true;
  $('#workspace').hidden = true;
  $('#public-view').hidden = false;
  $('#public-return').innerHTML = state.user ? 'Back to my library <span>→</span>' : 'Sign in <span>→</span>';
  loadPublicBooks();
}

async function loadBooks() {
  try {
    const { books } = await api('/api/books');
    state.books = books;
    renderBooks();
  } catch (error) { notify(error.message); }
}

async function loadPublicBooks() {
  try {
    const { books } = await api('/api/public/books');
    state.publicBooks = books;
    renderPublicBooks();
  } catch (error) { notify(error.message); }
}

async function loadAdminBooks() {
  $('#admin-error').textContent = '';
  try {
    const [{ books }, { users }] = await Promise.all([api('/api/admin/books?status=all'), api('/api/admin/users')]);
    state.adminBooks = books;
    state.adminUsers = users;
    renderAdminBooks();
  } catch (error) { $('#admin-error').textContent = error.message; }
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
    img.className = 'cover-image'; img.alt = ''; img.src = book.coverImage;
    cover.append(img);
    const overlay = document.createElement('span'); overlay.className = 'cover-overlay'; cover.append(overlay);
  }
  const kicker = document.createElement('span'); kicker.className = 'cover-kicker'; kicker.textContent = 'A BOOK BY';
  const title = document.createElement('strong'); title.className = 'cover-title'; title.textContent = book.title;
  const author = document.createElement('span'); author.className = 'cover-author'; author.textContent = book.author || 'Unknown author';
  const ornament = document.createElement('span'); ornament.className = 'cover-ornament'; ornament.textContent = '✳';
  cover.append(kicker, title, author, ornament);
  return cover;
}

function renderBooks() {
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
    card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openReader(book); } });
    grid.append(card);
  }
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
  list.hidden = showingUsers;
  userList.hidden = !showingUsers;
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
  if (view === 'community') { showPublic(); return; }
  if (view === 'admin' && state.user?.role !== 'admin') { notify('Admin access is required.'); return; }
  const isAdd = view === 'add';
  $('#library-view').hidden = view !== 'library';
  $('#add-view').hidden = !isAdd;
  $('#admin-view').hidden = view !== 'admin';
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === view));
  if (view === 'admin') loadAdminBooks();
  if (isAdd) {
    $('#book-error').textContent = '';
    $('#book-title').focus({ preventScroll: true });
  } else renderBooks();
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  if (wasPrivate) renderBooks();
}

function movePages(direction) {
  if (!state.activeBook) return;
  turnTo(state.pageIndex + direction * 2);
}

$$('[data-auth-mode]').forEach(button => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const payload = { email: form.get('email'), password: form.get('password') };
  if (state.authMode === 'register') payload.name = form.get('name');
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true; $('#auth-error').textContent = '';
  try {
    const result = await api(state.authMode === 'register' ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(payload) });
    state.user = result.user; showWorkspace();
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { button.disabled = false; }
});

async function signOut() {
  try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
  showAuth();
}
$('#signout-button').addEventListener('click', signOut);
$('#mobile-signout').addEventListener('click', signOut);

$$('[data-view]').forEach(button => button.addEventListener('click', () => switchView(button.dataset.view)));
$('#explore-public').addEventListener('click', showPublic);
$('#public-return').addEventListener('click', () => {
  if (state.user) { showWorkspace(); switchView('library'); }
  else { showAuth(); }
});
$('#refresh-admin').addEventListener('click', loadAdminBooks);
$('#export-data').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await fetch('/api/admin/export', { credentials: 'same-origin' });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error || 'Could not export the library.');
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'shelfspace-export.json';
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = objectUrl; link.download = filename; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    notify('Export downloaded. Attach the JSON file in Claude to transfer it.');
  } catch (error) { notify(error.message); }
  finally { button.disabled = false; }
});
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
  if (!content.trim()) { $('#book-error').textContent = 'Upload a text file or paste some book text first.'; $('#book-content').focus(); return; }
  button.disabled = true; $('#book-error').textContent = '';
  try {
    const { book } = await api('/api/books', { method: 'POST', body: JSON.stringify({ title, author: $('#book-author').value.trim(), content, coverTheme: state.coverTheme, coverImage: state.coverImage, sourceName: state.sourceName }) });
    state.books.unshift(book); renderBooks();
    form.reset();
    $('#book-content').value = ''; $('#book-file').value = ''; $('#cover-file').value = ''; $('#book-author').value = '';
    $('#upload-title').textContent = 'Drop your file here'; $('#upload-hint').innerHTML = 'or <u>browse your device</u>';
    state.sourceName = ''; state.coverImage = ''; state.coverTheme = 'midnight';
    $('#remove-cover').hidden = true; $$('.theme-swatch').forEach(item => item.classList.toggle('selected', item.dataset.theme === 'midnight'));
    updateCoverPreview(); switchView('library'); openReader(book);
    notify('Your book is on the shelf and waiting for review. Enjoy reading!');
  } catch (error) { $('#book-error').textContent = error.message; }
  finally { button.disabled = false; }
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
    if (user) { state.user = user; showWorkspace(); }
  } catch { /* The sign-in screen is still usable if the API is unavailable. */ }
}
start();
