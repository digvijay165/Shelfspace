// Regenerates the README screenshots in docs/screenshots.
// Usage: node scripts/screenshots.js [path-to-chrome-or-edge]
// Starts a throwaway server with demo data, drives headless Chrome over the DevTools protocol, then cleans up.
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const PORT = 4185;
const DEBUG_PORT = 9333;
const BASE = `http://127.0.0.1:${PORT}`;
const CHROME = process.argv[2] || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome'
].find(file => fs.existsSync(file));

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelfspace-shots-'));
const demo = require('../demo/books.js');

async function waitFor(url) {
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(url); if (response.ok) return response; } catch (error) { if (i === 99) console.error(error.cause || error); }
    await wait(150);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, { resolve, reject });
    socket.send(JSON.stringify({ id: messageId, method, params }));
  });
  return new Promise(resolve => socket.addEventListener('open', () => resolve({ send, close: () => socket.close() })));
}

async function main() {
  if (!CHROME) throw new Error('Chrome or Edge not found. Pass its path as the first argument.');
  fs.mkdirSync(OUT, { recursive: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), DATA_FILE: path.join(temp, 'data.json'), ADMIN_EMAIL: 'admin@example.test', DEMO_SEED: '1' }
  });
  const browser = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${path.join(temp, 'profile')}`, '--hide-scrollbars', '--no-first-run', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  try {
    await waitFor(`${BASE}/healthz`);
    const targets = await (await waitFor(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    const page = await connect(targets.find(target => target.type === 'page').webSocketDebuggerUrl);
    await page.send('Page.enable');
    await page.send('Runtime.enable');

    const size = async (width, height, mobile = false) => page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile });
    const run = async expression => {
      const result = await page.send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const go = async url => { await page.send('Page.navigate', { url }); await wait(1600); };
    const shot = async name => {
      const { data } = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
      console.log(`saved docs/screenshots/${name}.png`);
    };
    const post = (url, body, method = 'POST') => `await fetch(${JSON.stringify(url)}, { method: ${JSON.stringify(method)}, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(${JSON.stringify(body)}) }).then(r => r.json())`;

    await size(1440, 900);
    await go(BASE);
    await shot('sign-in');

    // A reader uploads books; some get reviewed so every status shows up.
    await run(`${post('/api/register', { name: 'Rosa Lin', email: 'reader@example.test', password: 'demo-reader-pass-1' })};`);
    const uploads = [
      { title: 'Letters from the Lighthouse', author: 'Rosa Lin', coverTheme: 'lavender', content: demo[1].content },
      { title: 'The Orchard Year', author: 'Rosa Lin', coverTheme: 'rose', content: demo[2].content },
      { title: 'Notes on Rain', author: 'Rosa Lin', coverTheme: 'midnight', content: demo[3].content },
      { title: 'A Map of Quiet Places', author: 'Rosa Lin', coverTheme: 'forest', content: demo[0].content }
    ];
    const ids = [];
    for (const book of uploads) ids.push(await run(`return (${post('/api/books', book)}).book.id;`));
    await run(`${post(`/api/books/${ids[3]}/progress`, { progress: 42 }, 'PATCH')}; ${post(`/api/books/${ids[1]}/progress`, { progress: 78 }, 'PATCH')};`);
    await run(`${post('/api/logout', {})}; ${post('/api/register', { name: 'Ada Admin', email: 'admin@example.test', password: 'demo-admin-pass-1' })};`);
    await run(`${post(`/api/admin/books/${ids[3]}/status`, { status: 'published' }, 'PATCH')}; ${post(`/api/admin/books/${ids[2]}/status`, { status: 'rejected', note: 'Lovely writing! Please add a title page and resubmit.' }, 'PATCH')};`);

    await go(BASE);
    await run(`document.querySelector('#admin-nav').click(); await new Promise(r => setTimeout(r, 900)); window.scrollTo(0, 0);`);
    await shot('admin-review');

    await run(`${post('/api/logout', {})}; ${post('/api/login', { email: 'reader@example.test', password: 'demo-reader-pass-1' })};`);
    await go(BASE);
    await shot('library');

    await go(BASE);
    await run(`await new Promise(r => setTimeout(r, 300)); document.querySelector('#signout-button').click(); await new Promise(r => setTimeout(r, 500)); document.querySelector('#explore-public').click(); await new Promise(r => setTimeout(r, 900));`);
    await shot('community-shelf');

    await run(`[...document.querySelectorAll('.public-book-card')].find(card => card.textContent.includes('The Lantern Road')).click(); await new Promise(r => setTimeout(r, 2400));`);
    await shot('reader');
    await run(`document.querySelector('#right-page').click(); await new Promise(r => setTimeout(r, 230));`);
    await shot('page-turn');
    await run(`await new Promise(r => setTimeout(r, 800)); document.querySelector('#reader-contents').click(); await new Promise(r => setTimeout(r, 300));`);
    await shot('contents');

    // Optional: frames of a slowed-down page turn, for building docs/page-turn.gif (set FRAMES_DIR).
    if (process.env.FRAMES_DIR) {
      fs.mkdirSync(process.env.FRAMES_DIR, { recursive: true });
      await run(`document.querySelector('#contents-close').click(); await new Promise(r => setTimeout(r, 300));`);
      const clip = await run(`const box = document.querySelector('.reader-stage').getBoundingClientRect(); return { x: box.x, y: box.y + 60, width: box.width, height: box.height - 120 };`);
      await page.send('Animation.enable');
      await page.send('Animation.setPlaybackRate', { playbackRate: 0.12 });
      let frame = 0;
      const capture = async count => {
        for (let i = 0; i < count; i++) {
          const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 0.42 } });
          fs.writeFileSync(path.join(process.env.FRAMES_DIR, `frame-${String(frame++).padStart(3, '0')}.png`), Buffer.from(data, 'base64'));
        }
      };
      for (const direction of ['#right-page', '#right-page']) {
        await capture(4);
        await run(`document.querySelector('${direction}').click();`);
        await capture(36);
      }
      await page.send('Animation.setPlaybackRate', { playbackRate: 1 });
      console.log(`saved ${frame} frames to ${process.env.FRAMES_DIR}`);
    }

    await size(390, 844, true);
    await go(BASE);
    await run(`document.querySelector('#explore-public').click(); await new Promise(r => setTimeout(r, 900));
      [...document.querySelectorAll('.public-book-card')].find(card => card.textContent.includes('Gardens at Night')).click(); await new Promise(r => setTimeout(r, 2400));`);
    await shot('mobile-reader');
    page.close();
  } finally {
    browser.kill();
    server.kill();
    await wait(500);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
