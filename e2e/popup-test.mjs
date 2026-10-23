// Checks the popup page in a real Chromium: preview, validation, messages sent, and that the
// extension-page content security policy from the manifest does not break it.
// chrome.* is replaced by a small fake; Giphy requests are answered locally.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeGif } from './gif.mjs';
import { launch } from './launch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist');
const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
const CSP = manifest.content_security_policy.extension_pages;
const ID = '3o7TKSjRrfIPjeiVyM';
const ROOM = 'abc-defg-hij';
const gif = encodeGif({ width: 160, height: 90, frames: [{ color: [255, 0, 0], delayMs: 300 }, { color: [0, 0, 255], delayMs: 300 }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fakeChrome = (opts) => `
  window.__sent = [];
  window.__saved = null;
  window.__phase = 'idle';
  window.__stored = ${JSON.stringify(opts.stored ?? null)};
  const status = () => ({ hookReady: ${opts.hookReady ?? true}, supported: true, room: '${ROOM}', phase: window.__phase, cameraOn: true, error: null });
  window.chrome = {
    runtime: { id: 'test' },
    storage: { local: {
      get: async (k) => ({ [k]: window.__stored }),
      set: async (o) => { window.__saved = o; window.__stored = Object.values(o)[0]; },
    } },
    tabs: {
      query: async () => ${opts.onMeet === false ? '[{ id: 7, url: "https://example.com/" }]' : `[{ id: 7, url: "https://meet.google.com/${ROOM}" }]`},
      sendMessage: async (id, req) => {
        if (${opts.unreachable ? 'true' : 'false'}) throw new Error('Could not establish connection.');
        window.__sent.push(req);
        if (req.type === 'start') { window.__phase = 'playing'; return { ok: true, status: status() }; }
        if (req.type === 'stop') { window.__phase = 'idle'; return { ok: true, status: status() }; }
        return { ok: true, status: status() };
      },
    },
  };`;

async function openPopup(browser, opts = {}) {
  const page = await browser.newPage();
  const log = { requests: [], consoleErrors: [], dialogs: [] };
  page.on('console', (m) => m.type() === 'error' && log.consoleErrors.push(m.text()));
  page.on('pageerror', (e) => log.consoleErrors.push(String(e)));
  page.on('dialog', (d) => { log.dialogs.push(d.message()); d.dismiss(); });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = new URL(req.url());
    log.requests.push(req.url());
    if (url.origin === 'https://ext.test') {
      const file = url.pathname.slice(1);
      const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'text/javascript';
      return req.respond({ status: 200, contentType: type, headers: { 'content-security-policy': CSP }, body: readFileSync(join(dist, file)) });
    }
    if (url.hostname.endsWith('.giphy.com') && url.pathname.includes(ID)) {
      return req.respond({ status: 200, contentType: 'image/gif', headers: { 'access-control-allow-origin': '*' }, body: Buffer.from(gif) });
    }
    if (req.url().startsWith('blob:') || req.url().startsWith('data:')) return req.continue();
    return req.abort();
  });
  await page.evaluateOnNewDocument(fakeChrome(opts));
  await page.goto('https://ext.test/popup.html');
  await sleep(150);
  return { page, log };
}

const text = (page, sel) => page.$eval(sel, (e) => e.textContent);
const hidden = (page, sel) => page.$eval(sel, (e) => e.hidden);
const disabled = (page, sel) => page.$eval(sel, (e) => e.disabled);
const type = async (page, value) => {
  await page.$eval('#url', (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); }, value);
  await sleep(450);
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('starts empty with Go disabled, and shows the room of the Meet tab', async (b) => {
  const { page, log } = await openPopup(b);
  assert.equal(await text(page, '#room'), ROOM);
  assert.equal(await disabled(page, '#go'), true);
  assert.match(await text(page, '#preview-msg'), /Paste a Giphy link/);
  assert.deepEqual(log.consoleErrors, []);
});

test('a valid link shows a preview (policy allows the blob image), and Go sends the right message', async (b) => {
  const { page, log } = await openPopup(b);
  await type(page, `https://giphy.com/gifs/funny-cat-${ID}`);
  assert.equal(await hidden(page, '#preview-img'), false);
  assert.match(await page.$eval('#preview-img', (e) => e.src), /^blob:/);
  assert.equal(await page.$eval('#preview-img', (e) => e.complete && e.naturalWidth), 160, 'image decoded');
  assert.equal(await disabled(page, '#go'), false);
  assert.equal(await text(page, '#go'), 'Go');

  await page.select('#fit', 'fit');
  await page.click('#go');
  await sleep(200);
  const start = await page.evaluate(() => window.__sent.find((m) => m.type === 'start'));
  assert.equal(start.room, ROOM);
  assert.equal(start.fit, 'fit');
  assert.equal(start.startHoldMs, 0);
  const bytes = Buffer.from(start.gifBase64, 'base64');
  assert.equal(bytes.subarray(0, 6).toString(), 'GIF89a');
  assert.equal(await text(page, '#go'), 'Stop');
  assert.deepEqual(log.consoleErrors, [], log.consoleErrors.join('\n'));

  const requested = log.requests.filter((u) => u.includes('giphy'));
  assert.ok(requested.length >= 1 && requested.every((u) => /^https:\/\/media\.giphy\.com\/media\/3o7TKSjRrfIPjeiVyM\/giphy[a-z-]*\.gif$/.test(u)), requested.join('\n'));

  // The fit chosen is remembered with this gif.
  const saved = await page.evaluate(() => Object.values(window.__saved)[0]);
  assert.equal(saved.gifs[ID].fit, 'fit');
  assert.equal(saved.lastUrl, `https://giphy.com/gifs/funny-cat-${ID}`);

  // Stop goes back.
  await page.click('#go');
  await sleep(500);
  assert.equal(await text(page, '#go'), 'Go');
});

test('rejected links show an error beside the preview, never fetch, and never enable Go', async (b) => {
  const { page, log } = await openPopup(b);
  const bad = [
    'javascript:alert(1)',
    `http://giphy.com/gifs/x-${ID}`,
    `https://giphy.com.evil.example/gifs/x-${ID}`,
    `https://giphy.com@evil.example/gifs/x-${ID}`,
    `https://giphy.com/gifs/x-<img src=x onerror=alert(1)>`,
    'https://giphy.com/gifs/x-"><script>alert(1)</script>',
    `giphy.com/gifs/x-${ID}`,
  ];
  for (const link of bad) {
    await type(page, link);
    assert.equal(await hidden(page, '#preview-msg'), false, link);
    assert.equal(await page.$eval('#preview-msg', (e) => e.classList.contains('error')), true, link);
    assert.equal(await disabled(page, '#go'), true, link);
    assert.equal(await page.$$eval('#preview-msg img, #preview-msg script', (n) => n.length), 0, link);
  }
  assert.deepEqual(log.dialogs, []);
  assert.deepEqual(log.requests.filter((u) => /evil|giphy/.test(u)), [], 'nothing was fetched');
});

test('a link that stops being valid after an earlier good one clears the preview', async (b) => {
  const { page } = await openPopup(b);
  await type(page, `https://giphy.com/gifs/x-${ID}`);
  assert.equal(await hidden(page, '#preview-img'), false);
  await type(page, 'nonsense');
  assert.equal(await hidden(page, '#preview-img'), true);
  assert.equal(await disabled(page, '#go'), true);
});

test('not on a Meet tab: says so and keeps Go disabled', async (b) => {
  const { page } = await openPopup(b, { onMeet: false });
  await type(page, `https://giphy.com/gifs/x-${ID}`);
  assert.match(await text(page, '#status'), /Open a Google Meet call/);
  assert.equal(await disabled(page, '#go'), true);
  assert.equal(await hidden(page, '#room'), true);
});

test('extension not active on the tab: asks for a reload', async (b) => {
  const { page } = await openPopup(b, { unreachable: true });
  await type(page, `https://giphy.com/gifs/x-${ID}`);
  assert.match(await text(page, '#status'), /Reload the Meet tab/);
  assert.equal(await disabled(page, '#go'), true);
});

test('stored data is validated: a tampered stored link is ignored', async (b) => {
  const { page } = await openPopup(b, { stored: { lastUrl: 'javascript:alert(1)', settings: { startHoldMs: 99999, defaultFit: 'bogus' }, gifs: { '__proto__': { fit: 'fit' } } } });
  assert.equal(await page.$eval('#url', (e) => e.value), '');
  assert.equal(await page.$eval('#hold', (e) => e.value), '3000');
  assert.equal(await page.$eval('#fit', (e) => e.value), 'fill');
});

test('a remembered gif is restored with its own fit', async (b) => {
  const { page } = await openPopup(b, {
    stored: { lastUrl: `https://giphy.com/gifs/x-${ID}`, settings: { startHoldMs: 250, defaultFit: 'fill' }, gifs: { [ID]: { fit: 'stretch', usedAt: 1 } } },
  });
  await sleep(500);
  assert.equal(await page.$eval('#hold', (e) => e.value), '250');
  assert.equal(await page.$eval('#fit', (e) => e.value), 'stretch');
  assert.equal(await hidden(page, '#preview-img'), false);
});

const browser = await launch();
let failed = 0;
for (const t of tests) {
  const t0 = Date.now();
  try {
    await t.fn(browser);
    console.log(`  ok   ${t.name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${t.name}\n       ${String(err.message ?? err).split('\n').join('\n       ')}`);
  }
}
await browser.close();
console.log(failed === 0 ? '\nAll popup checks passed.' : `\n${failed} popup check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
