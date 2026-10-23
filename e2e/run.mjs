// End-to-end check of the built page hook in a real Chromium with a fake camera.
//
// The hook is injected before the page's own scripts (as the extension does), and a stand-in "Meet"
// page requests/stops the camera on Ctrl+E or a button click. A spy under the hook records every
// request that reaches the real getUserMedia, so we can prove the camera hardware is never
// requested when a reaction starts with the camera off.
//
// Set CHROME_PATH to use your own Chrome/Chromium instead of the bundled one.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeGif } from './gif.mjs';
import { launch } from './launch.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hookSource = readFileSync(process.env.HOOK_PATH ?? join(here, '..', 'dist', 'hook.js'), 'utf8');
const fakeMeetHtml = readFileSync(join(here, 'fake-meet.html'), 'utf8');
const bridgeSource = readFileSync(join(here, '..', 'dist', 'bridge.js'), 'utf8');
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const ROOM = 'abc-defg-hij';

const spySource = `(() => {
  const original = MediaDevices.prototype.getUserMedia;
  window.__gum = [];
  MediaDevices.prototype.getUserMedia = function (c) {
    window.__gum.push(JSON.stringify(c));
    return original.call(this, c);
  };
})();`;

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];
const BLUE = [0, 0, 255];
const WHITE = [255, 255, 255];
const rgbGif = (w = 160, h = 90, delay = 400) =>
  encodeGif({ width: w, height: h, frames: [RED, GREEN, BLUE].map((color) => ({ color, delayMs: delay })) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(sample) {
  if (!sample) return 'none';
  const [r, g, b] = sample.center;
  if (r > 200 && g < 70 && b < 70) return 'red';
  if (g > 200 && r < 70 && b < 70) return 'green';
  if (b > 200 && r < 70 && g < 70) return 'blue';
  if (r > 200 && g > 200 && b > 200) return 'white';
  if (r < 25 && g < 25 && b < 25) return 'black';
  return 'camera';
}

const fakeChromeRuntime = `window.__realBridge = true;
window.chrome = { runtime: { id: 'test', onMessage: { addListener: (fn) => { window.__onMessage = fn; } } } };`;

async function newMeetPage(browser, { bridge = false, bridgeFirst = false } = {}) {
  const page = await browser.newPage();
  const context = { close: () => page.close() };
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url() === MEET_URL) req.respond({ status: 200, contentType: 'text/html', body: fakeMeetHtml });
    else req.abort();
  });
  if (bridge) {
    const scripts = bridgeFirst ? [bridgeSource, hookSource] : [hookSource, bridgeSource];
    await page.evaluateOnNewDocument(`${fakeChromeRuntime}\n${spySource}\n${scripts.join('\n')}`);
  } else {
    await page.evaluateOnNewDocument(`${spySource}\n${hookSource}`);
  }
  await page.goto(MEET_URL);
  if (!bridge) await page.waitForFunction(() => window.__connected());
  return { page, context, errors };
}

const send = (page, req, gif) => page.evaluate((r, g) => window.__send(r, g), req, gif ? Array.from(gif) : undefined);
const startReq = (extra = {}) => ({ cmd: 'start', room: ROOM, fit: 'fill', startHoldMs: 0, ...extra });
const status = async (page) => (await send(page, { cmd: 'status' })).status;

async function series(page, ms, every = 35) {
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    out.push({ t: Date.now() - t0, c: classify(await page.evaluate(() => window.__sample())) });
    await sleep(every);
  }
  return out;
}

/** Collapses a series into the order colours appeared in, e.g. ['camera','red','green']. */
const sequence = (s) => s.map((x) => x.c).filter((c, i, a) => i === 0 || c !== a[i - 1]);

async function waitFor(page, predicate, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    if (await predicate()) return Date.now() - t0;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(40);
  }
}

const tests = [];
const test = (name, fn, options = {}) => tests.push({ name, fn, options });

// ---------------------------------------------------------------------------------------------

test('environment: the browser has the APIs the hook needs', async ({ page }) => {
  const caps = await page.evaluate(() => ({
    secure: isSecureContext,
    processor: typeof MediaStreamTrackProcessor,
    generator: typeof MediaStreamTrackGenerator,
    decoder: typeof ImageDecoder,
  }));
  assert.deepEqual(caps, { secure: true, processor: 'function', generator: 'function', decoder: 'function' });
  const s = await status(page);
  assert.equal(s.supported, true);
  assert.equal(s.room, ROOM);
});

test('camera on: the gif replaces the picture, then the real camera returns', async ({ page }) => {
  await page.evaluate(() => window.__join(true));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 4000, 'camera picture');
  assert.equal((await status(page)).cameraOn, true);

  const reply = await send(page, startReq(), rgbGif());
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const s = await series(page, 2600);
  const seq = sequence(s);
  // The picture starts as the camera, then runs red, green, blue, then the camera returns.
  assert.deepEqual(seq, ['camera', 'red', 'green', 'blue', 'camera'], `unexpected order: ${seq}`);

  assert.equal((await status(page)).phase, 'idle');
  const after = await page.evaluate(() => ({
    log: window.__log,
    gum: window.__gum,
    trackState: window.__tracks[0].readyState,
    audio: window.__audio && window.__audio.readyState,
  }));
  assert.deepEqual(after.log, [], 'the extension never pressed Meet’s camera button');
  assert.equal(after.gum.length, 1, 'one real camera request, never repeated');
  assert.equal(after.trackState, 'live');
  assert.equal(after.audio, 'live', 'audio untouched');
});

test('camera on: a 3-colour gif lasting 1.2 s ends by itself after about 1.2 s', async ({ page }) => {
  await page.evaluate(() => window.__join(true));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 4000, 'camera');
  await send(page, startReq(), rgbGif());
  const t0 = Date.now();
  await waitFor(page, async () => (await status(page)).phase !== 'idle', 1000, 'reaction to start');
  const ended = await waitFor(page, async () => (await status(page)).phase === 'idle', 4000, 'reaction to end');
  const total = Date.now() - t0 + 0;
  assert.ok(total > 900 && total < 2200, `reaction took ${total} ms (ended after ${ended} ms of waiting)`);
});

test('camera off: the camera is switched on for the gif and off again, and the real camera is never requested', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  assert.equal(await page.evaluate(() => window.__hasCamera()), false);
  assert.equal((await status(page)).cameraOn, false);

  const reply = await send(page, startReq(), rgbGif());
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const s = await series(page, 3400);
  const seq = sequence(s);
  assert.ok(!seq.includes('camera'), `the real camera must never show: ${seq}`);
  for (const c of ['red', 'green', 'blue']) assert.ok(seq.includes(c), `never saw ${c}: ${seq}`);

  const after = await page.evaluate(() => ({
    log: window.__log,
    gum: window.__gum,
    hasCamera: window.__hasCamera(),
    trackState: window.__tracks[0]?.readyState,
    audio: window.__audio && window.__audio.readyState,
  }));
  assert.deepEqual(after.log, ['key', 'key'], 'camera switched on, then off again');
  assert.ok(after.gum.every((g) => !g.includes('video')), `the real camera was requested: ${after.gum}`);
  assert.equal(after.hasCamera, false);
  assert.equal(after.trackState, 'ended');
  assert.equal(after.audio, 'live', 'audio untouched');
  const st = await status(page);
  assert.equal(st.phase, 'idle');
  assert.equal(st.cameraOn, false);
  assert.equal(st.error, null);
});

test('camera off: if Meet ignores the shortcut, the button is clicked instead (once)', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  await page.evaluate(() => {
    const original = document.dispatchEvent;
    // Meet "ignoring" Ctrl+E: swallow keydown before the page's handler sees it.
    window.addEventListener('keydown', (e) => e.stopImmediatePropagation(), true);
    void original;
  });
  const reply = await send(page, startReq(), rgbGif());
  assert.equal(reply.ok, true);
  await waitFor(page, async () => (await page.evaluate(() => window.__hasCamera())) === true, 3000, 'the click fallback');
  const log = await page.evaluate(() => window.__log);
  assert.deepEqual(log, ['click']);
  const seq = sequence(await series(page, 1400));
  assert.ok(seq.includes('red'), `expected the gif: ${seq}`);
  assert.ok(!seq.includes('camera'));
});

test('manual toggle mid-reaction (camera was on): cancels, and the extension does not fight the user', async ({ page }) => {
  await page.evaluate(() => window.__join(true));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 4000, 'camera');
  await send(page, startReq(), encodeGif({ width: 160, height: 90, frames: [{ color: RED, delayMs: 3000 }] }));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'red', 2000, 'red');
  await page.evaluate(() => window.__userToggle()); // the user turns the camera off
  await waitFor(page, async () => (await status(page)).phase === 'idle', 2000, 'cancel');
  await sleep(1500);
  assert.equal(await page.evaluate(() => window.__hasCamera()), false, 'camera stays off, as the user chose');
  assert.deepEqual(await page.evaluate(() => window.__log), []);
  assert.equal((await status(page)).cameraOn, false);
});

test('manual toggle mid-reaction (camera was off): cancels and presses nothing more', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  await send(page, startReq(), encodeGif({ width: 160, height: 90, frames: [{ color: RED, delayMs: 3000 }] }));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'red', 3000, 'red');
  await page.evaluate(() => window.__userToggle()); // the user turns the camera off
  await waitFor(page, async () => (await status(page)).phase === 'idle', 2000, 'cancel');
  await sleep(1500);
  assert.deepEqual(await page.evaluate(() => window.__log), ['key'], 'only the extension’s own turn-on press');
  assert.equal(await page.evaluate(() => window.__hasCamera()), false);
});

test('Stop (camera was on): the camera returns at once', async ({ page }) => {
  await page.evaluate(() => window.__join(true));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 4000, 'camera');
  await send(page, startReq(), encodeGif({ width: 160, height: 90, frames: [{ color: RED, delayMs: 4000 }] }));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'red', 2000, 'red');
  const reply = await send(page, { cmd: 'stop', room: ROOM });
  assert.equal(reply.ok, true);
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 1500, 'camera back');
  assert.equal((await status(page)).phase, 'idle');
  assert.deepEqual(await page.evaluate(() => window.__log), []);
});

test('Stop (camera was off): the camera is switched off again', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  await send(page, startReq(), encodeGif({ width: 160, height: 90, frames: [{ color: RED, delayMs: 4000 }] }));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'red', 3000, 'red');
  await send(page, { cmd: 'stop', room: ROOM });
  await waitFor(page, async () => (await page.evaluate(() => window.__hasCamera())) === false, 3000, 'camera off');
  await waitFor(page, async () => (await status(page)).phase === 'idle', 3000, 'idle');
  assert.deepEqual(await page.evaluate(() => window.__log), ['key', 'key']);
  assert.ok((await page.evaluate(() => window.__gum)).every((g) => !g.includes('video')));
});

test('start hold: the first frame is held still before the gif moves', async ({ page }) => {
  await page.evaluate(() => window.__join(true));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 4000, 'camera');
  await send(page, startReq({ startHoldMs: 800 }), rgbGif());
  const s = await series(page, 2600);
  const red = s.filter((x) => x.c === 'red');
  const green = s.find((x) => x.c === 'green');
  assert.ok(red.length > 0 && green, `expected red then green: ${sequence(s)}`);
  const redSpan = red.at(-1).t - red[0].t;
  assert.ok(redSpan > 1000, `red (800 ms hold + 400 ms frame) should last about 1.2 s, lasted ${redSpan} ms`);
});

test('a gif longer than 5 seconds is cut off at 5 seconds', async ({ page }) => {
  await page.evaluate(() => window.__join(true));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 4000, 'camera');
  const long = encodeGif({
    width: 160,
    height: 90,
    frames: [RED, GREEN, BLUE, WHITE].map((color) => ({ color, delayMs: 2500 })),
  });
  await send(page, startReq(), long);
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'red', 2000, 'red');
  const t0 = Date.now();
  await waitFor(page, async () => (await status(page)).phase === 'idle', 8000, 'end');
  const took = Date.now() - t0;
  assert.ok(took > 4000 && took < 5800, `expected about 5 s, took ${took} ms`);
  const seq = sequence(await series(page, 400));
  assert.deepEqual(seq, ['camera']);
});

test('fit modes: fill covers, fit leaves bars, stretch ignores the aspect ratio', async ({ page }) => {
  await page.evaluate(() => window.__join(true));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 4000, 'camera');
  const square = encodeGif({ width: 90, height: 90, frames: [{ color: RED, delayMs: 2500 }] });
  const corners = {};
  for (const fit of ['fill', 'fit', 'stretch']) {
    await send(page, startReq({ fit }), square);
    await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'red', 2000, `red (${fit})`);
    await sleep(150);
    corners[fit] = await page.evaluate(() => window.__sample().corner);
    await send(page, { cmd: 'stop', room: ROOM });
    await waitFor(page, async () => (await status(page)).phase === 'idle', 2000, 'idle');
  }
  const isRed = ([r, g, b]) => r > 200 && g < 70 && b < 70;
  const isBlack = ([r, g, b]) => r < 25 && g < 25 && b < 25;
  assert.ok(isRed(corners.fill), `fill corner ${corners.fill}`);
  assert.ok(isBlack(corners.fit), `fit corner ${corners.fit}`);
  assert.ok(isRed(corners.stretch), `stretch corner ${corners.stretch}`);
});

test('a reaction meant for another meeting is refused, and nothing is touched', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  const reply = await send(page, startReq({ room: 'zzz-zzzz-zzz' }), rgbGif());
  assert.equal(reply.ok, false);
  assert.match(reply.error, /meeting/);
  const stop = await send(page, { cmd: 'stop', room: 'zzz-zzzz-zzz' });
  assert.equal(stop.ok, false);
  assert.deepEqual(await page.evaluate(() => window.__log), []);
});

test('a broken gif is refused before the camera is touched', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  const junk = new Uint8Array(200).map((_, i) => (i * 7) % 256);
  junk.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const reply = await send(page, startReq(), junk);
  assert.equal(reply.ok, false);
  assert.deepEqual(await page.evaluate(() => window.__log), []);
  assert.equal((await status(page)).phase, 'idle');
});

test('malformed commands are ignored', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  const answered = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve('no answer'), 600);
        window.__send({ cmd: 'eval', code: 'alert(1)' }).then(() => {
          clearTimeout(timer);
          resolve('answered');
        });
      }),
  );
  assert.equal(answered, 'no answer');
  assert.deepEqual(await page.evaluate(() => window.__log), []);
});

test('a second handshake from a page script cannot take over the channel', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  const hijacked = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const ch = new MessageChannel();
        let got = false;
        ch.port1.onmessage = () => {
          got = true;
        };
        window.postMessage({ __mgr: 'port' }, location.origin, [ch.port2]);
        ch.port1.postMessage({ id: 99, cmd: 'stop', room: 'abc-defg-hij' });
        setTimeout(() => resolve(got), 400);
      }),
  );
  assert.equal(hijacked, false);
  assert.equal((await status(page)).hookReady, true);
});

test('screen sharing and audio-only requests are left alone', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true });
    return {
      audioTracks: audioOnly.getAudioTracks().length,
      videoTracks: audioOnly.getVideoTracks().length,
      gum: window.__gum.slice(),
      displayMediaPatched: navigator.mediaDevices.getDisplayMedia.toString().includes('native code'),
    };
  });
  assert.equal(result.audioTracks, 1);
  assert.equal(result.videoTracks, 0);
  assert.deepEqual(result.gum, ['{"audio":true}']);
  assert.equal(result.displayMediaPatched, true);
});


// ---- the real bridge in the chain: popup message -> bridge -> hook -> picture ------------------------

const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const ask = (page, req, sender = { id: 'test' }) =>
  page.evaluate(
    (r, s) =>
      new Promise((resolve) => {
        const keep = window.__onMessage(r, s, resolve);
        if (keep !== true) setTimeout(() => resolve('__no-response__'), 400);
      }),
    req,
    sender,
  );

for (const bridgeFirst of [false, true]) {
  const order = bridgeFirst ? 'bridge loads first' : 'hook loads first';

  test(`bridge (${order}): status reaches the hook and comes back`, async ({ page }) => {
    const reply = await ask(page, { type: 'status' });
    assert.equal(reply.ok, true, JSON.stringify(reply));
    assert.equal(reply.status.hookReady, true);
    assert.equal(reply.status.supported, true);
    assert.equal(reply.status.room, ROOM);
    assert.equal(reply.status.phase, 'idle');
  }, { bridge: true, bridgeFirst });
}

test('bridge: a reaction started by a popup message plays (camera on), audio untouched', async ({ page }) => {
  await page.evaluate(() => window.__join(true));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 4000, 'camera');
  const reply = await ask(page, { type: 'start', room: ROOM, gifBase64: b64(rgbGif()), fit: 'fill', startHoldMs: 0 });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const seq = sequence(await series(page, 2400));
  assert.deepEqual(seq, ['camera', 'red', 'green', 'blue', 'camera'], `${seq}`);
  assert.equal(await page.evaluate(() => window.__audio.readyState), 'live');
}, { bridge: true });

test('bridge: a reaction with the camera off never requests the real camera', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  const reply = await ask(page, { type: 'start', room: ROOM, gifBase64: b64(rgbGif()), fit: 'fill', startHoldMs: 0 });
  assert.equal(reply.ok, true, JSON.stringify(reply));
  const seq = sequence(await series(page, 3400));
  assert.ok(!seq.includes('camera'), `${seq}`);
  for (const c of ['red', 'green', 'blue']) assert.ok(seq.includes(c), `${seq}`);
  assert.deepEqual(await page.evaluate(() => window.__log), ['key', 'key']);
  assert.ok((await page.evaluate(() => window.__gum)).every((g) => !g.includes('video')));
}, { bridge: true });

test('bridge: Stop from the popup ends it', async ({ page }) => {
  await page.evaluate(() => window.__join(true));
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 4000, 'camera');
  const long = encodeGif({ width: 160, height: 90, frames: [{ color: RED, delayMs: 4000 }] });
  await ask(page, { type: 'start', room: ROOM, gifBase64: b64(long), fit: 'fill', startHoldMs: 0 });
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'red', 2000, 'red');
  const status1 = (await ask(page, { type: 'status' })).status;
  assert.ok(['holding', 'playing'].includes(status1.phase), status1.phase);
  const stop = await ask(page, { type: 'stop', room: ROOM });
  assert.equal(stop.ok, true);
  assert.equal(stop.status.phase, 'idle');
  await waitFor(page, async () => classify(await page.evaluate(() => window.__sample())) === 'camera', 1500, 'camera back');
}, { bridge: true });

test('bridge: a command for a different meeting is refused', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  const reply = await ask(page, { type: 'start', room: 'zzz-zzzz-zzz', gifBase64: b64(rgbGif()), fit: 'fill', startHoldMs: 0 });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /meeting/);
  assert.deepEqual(await page.evaluate(() => window.__log), []);
}, { bridge: true });

test('bridge: messages from other senders and malformed messages get no action', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  const other = await ask(page, { type: 'start', room: ROOM, gifBase64: b64(rgbGif()), fit: 'fill', startHoldMs: 0 }, { id: 'someone-else' });
  assert.equal(other, '__no-response__');
  for (const bad of [
    { type: 'eval', code: 'alert(1)' },
    { type: 'start', room: ROOM, gifBase64: '<script>', fit: 'fill', startHoldMs: 0 },
    { type: 'start', room: ROOM, gifBase64: b64(rgbGif()), fit: 'cover', startHoldMs: 0 },
    { type: 'start', room: ROOM, gifBase64: b64(rgbGif()), fit: 'fill', startHoldMs: -1 },
    'start',
    null,
  ]) {
    const reply = await ask(page, bad);
    assert.equal(reply.ok, false, JSON.stringify(bad));
  }
  assert.deepEqual(await page.evaluate(() => window.__log), []);
}, { bridge: true });

test('bridge: valid base64 that is not a gif is refused before anything is touched', async ({ page }) => {
  await page.evaluate(() => window.__join(false));
  const reply = await ask(page, { type: 'start', room: ROOM, gifBase64: Buffer.from('<html>not a gif at all</html>').toString('base64'), fit: 'fill', startHoldMs: 0 });
  assert.equal(reply.ok, false);
  assert.deepEqual(await page.evaluate(() => window.__log), []);
}, { bridge: true });

// ---------------------------------------------------------------------------------------------

const only = process.argv[2];
const browser = await launch();
let failed = 0;
for (const t of tests) {
  if (only && !t.name.includes(only)) continue;
  const env = await newMeetPage(browser, t.options);
  const t0 = Date.now();
  try {
    await t.fn(env);
    const pageErrors = env.errors.filter((e) => !/Failed to load resource|net::ERR/.test(e));
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(' | ')}`);
    console.log(`  ok   ${t.name} (${Date.now() - t0} ms)`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${t.name}\n       ${String(err.message ?? err).split('\n').join('\n       ')}`);
  } finally {
    await env.context.close().catch(() => undefined);
  }
}
await browser.close();
console.log(failed === 0 ? '\nAll browser checks passed.' : `\n${failed} browser check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
