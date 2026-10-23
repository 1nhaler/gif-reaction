import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { base64ToBytes, base64LengthFor, bytesToBase64, isBase64 } from '../src/shared/base64';
import { cameraStateFromAttribute, isCameraToggleLabel } from '../src/shared/camera-label';
import { DEFAULT_HEIGHT, DEFAULT_WIDTH, pickSyntheticSize, wantsAudio, wantsVideo } from '../src/shared/constraints';
import { computeDrawRect } from '../src/shared/fit';
import { parseHookRequest, parsePopupRequest } from '../src/shared/protocol';
import { isRoomCode, parseRoomCode } from '../src/shared/room';
import { MAX_STORED_GIFS } from '../src/shared/constants';
import { defaultState, fitFor, recordGifUse, sanitizeStoredState } from '../src/shared/storage';
import { buildTimeline, chooseDecodeScale, frameIndexAt, framesNeeded, normalizeFrameDurationMs } from '../src/shared/timeline';

const ID = '3o7TKSjRrfIPjeiVyM';

describe('computeDrawRect', () => {
  it('fill covers the frame and crops the overflow', () => {
    const r = computeDrawRect(400, 400, 1280, 720, 'fill');
    assert.equal(r.dw, 1280);
    assert.equal(r.dh, 1280);
    assert.equal(r.dx, 0);
    assert.equal(r.dy, (720 - 1280) / 2);
  });
  it('fit keeps the whole image and centres it', () => {
    const r = computeDrawRect(400, 400, 1280, 720, 'fit');
    assert.equal(r.dh, 720);
    assert.equal(r.dw, 720);
    assert.equal(r.dx, (1280 - 720) / 2);
    assert.equal(r.dy, 0);
  });
  it('stretch ignores the aspect ratio', () => {
    assert.deepEqual(computeDrawRect(400, 300, 1280, 720, 'stretch'), { dx: 0, dy: 0, dw: 1280, dh: 720 });
  });
  it('same aspect ratio fills exactly in every mode', () => {
    for (const mode of ['fill', 'fit', 'stretch'] as const) {
      assert.deepEqual(computeDrawRect(640, 360, 1280, 720, mode), { dx: 0, dy: 0, dw: 1280, dh: 720 });
    }
  });
  it('survives zero sizes', () => {
    const r = computeDrawRect(0, 0, 1280, 720, 'fill');
    assert.ok(Number.isFinite(r.dw) && Number.isFinite(r.dh));
  });
});

describe('timeline', () => {
  it('treats tiny or missing frame delays as 100 ms, like browsers', () => {
    assert.equal(normalizeFrameDurationMs(0), 100);
    assert.equal(normalizeFrameDurationMs(10), 100);
    assert.equal(normalizeFrameDurationMs(null), 100);
    assert.equal(normalizeFrameDurationMs(undefined), 100);
    assert.equal(normalizeFrameDurationMs(NaN), 100);
    assert.equal(normalizeFrameDurationMs(40), 40);
  });
  it('finds the frame on screen at a given time', () => {
    const t = buildTimeline([100, 200, 100]);
    assert.equal(t.totalMs, 400);
    assert.equal(frameIndexAt(t, 0), 0);
    assert.equal(frameIndexAt(t, 99), 0);
    assert.equal(frameIndexAt(t, 100), 1);
    assert.equal(frameIndexAt(t, 299), 1);
    assert.equal(frameIndexAt(t, 300), 2);
    assert.equal(frameIndexAt(t, 5000), 2);
    assert.equal(frameIndexAt(t, -5), 0);
  });
  it('handles an empty timeline', () => {
    assert.equal(frameIndexAt(buildTimeline([]), 100), 0);
  });
  it('only decodes as many frames as the cap needs', () => {
    assert.equal(framesNeeded(Array(200).fill(100), 5000), 50);
    assert.equal(framesNeeded([100, 100], 5000), 2);
    assert.equal(framesNeeded(Array(1000).fill(20), 5000), 250);
    assert.equal(framesNeeded(Array(5000).fill(20), 600_000), 400);
  });
  it('scales down decoding only when the memory budget would be exceeded', () => {
    assert.equal(chooseDecodeScale(480, 270, 50), 1);
    const s = chooseDecodeScale(1920, 1080, 250, 192 * 1024 * 1024);
    assert.ok(s < 1 && s > 0);
    assert.ok(1920 * s * 1080 * s * 4 * 250 <= 192 * 1024 * 1024 * 1.001);
  });
});

describe('room codes', () => {
  it('reads the room from a Meet URL', () => {
    assert.equal(parseRoomCode('https://meet.google.com/abc-defg-hij'), 'abc-defg-hij');
    assert.equal(parseRoomCode('https://meet.google.com/abc-defg-hij?authuser=1'), 'abc-defg-hij');
    assert.equal(parseRoomCode('https://meet.google.com/abc-defg-hij/'), 'abc-defg-hij');
  });
  it('ignores everything that is not a room', () => {
    assert.equal(parseRoomCode('https://meet.google.com/'), null);
    assert.equal(parseRoomCode('https://meet.google.com/landing'), null);
    assert.equal(parseRoomCode('https://meet.google.com/lookup/abcdefg'), null);
    assert.equal(parseRoomCode('http://meet.google.com/abc-defg-hij'), null);
    assert.equal(parseRoomCode('https://evil.example/abc-defg-hij'), null);
    assert.equal(parseRoomCode('https://meet.google.com.evil.example/abc-defg-hij'), null);
    assert.equal(parseRoomCode(undefined), null);
    assert.equal(parseRoomCode('nonsense'), null);
  });
  it('validates a code', () => {
    assert.equal(isRoomCode('abc-defg-hij'), true);
    assert.equal(isRoomCode('ABC-defg-hij'), false);
    assert.equal(isRoomCode('abc-defg-hij; x'), false);
    assert.equal(isRoomCode(5), false);
  });
});

describe('base64', () => {
  it('round-trips binary data, including large buffers', () => {
    const bytes = new Uint8Array(200_000);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 251;
    const text = bytesToBase64(bytes);
    assert.equal(text.length, base64LengthFor(bytes.length));
    assert.deepEqual(base64ToBytes(text), bytes);
  });
  it('recognises valid base64 only', () => {
    assert.equal(isBase64('AAAA'), true);
    assert.equal(isBase64('AAA='), true);
    assert.equal(isBase64('AAA'), false);
    assert.equal(isBase64('AA!A'), false);
    assert.equal(isBase64('<script>'), false);
  });
});

describe('Meet camera button detection', () => {
  it('matches the shortcut hint in any language', () => {
    assert.equal(isCameraToggleLabel('Turn off camera (ctrl + e)'), true);
    assert.equal(isCameraToggleLabel('Matikan kamera (ctrl + e)'), true);
    assert.equal(isCameraToggleLabel('Turn on camera (⌘ + e)'), true);
    assert.equal(isCameraToggleLabel('Turn on camera (cmd + E)'), true);
    assert.equal(isCameraToggleLabel('Kamera ausschalten (Strg + E)'), false); // not Latin "ctrl": falls back to key events
  });
  it('does not match the microphone or other buttons', () => {
    assert.equal(isCameraToggleLabel('Turn off microphone (ctrl + d)'), false);
    assert.equal(isCameraToggleLabel('Leave call'), false);
    assert.equal(isCameraToggleLabel(null), false);
    assert.equal(isCameraToggleLabel(undefined), false);
  });
  it('reads on/off from the data attribute', () => {
    assert.equal(cameraStateFromAttribute('false'), 'on');
    assert.equal(cameraStateFromAttribute('true'), 'off');
    assert.equal(cameraStateFromAttribute(null), 'unknown');
    assert.equal(cameraStateFromAttribute('maybe'), 'unknown');
  });
});

describe('constraints', () => {
  it('uses the size Meet asked for', () => {
    assert.deepEqual(pickSyntheticSize({ width: { ideal: 640 }, height: { ideal: 360 } }), { width: 640, height: 360 });
    assert.deepEqual(pickSyntheticSize({ width: 1280, height: 720 }), { width: 1280, height: 720 });
    assert.deepEqual(pickSyntheticSize({ width: { exact: 960 }, height: { min: 400, max: 540 } }), { width: 960, height: 540 });
  });
  it('falls back to 720p for anything odd', () => {
    const d = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    assert.deepEqual(pickSyntheticSize(true), d);
    assert.deepEqual(pickSyntheticSize({}), d);
    assert.deepEqual(pickSyntheticSize({ width: 99999, height: 99999 }), d);
    assert.deepEqual(pickSyntheticSize({ width: NaN, height: 10 }), d);
    assert.deepEqual(pickSyntheticSize(null), d);
  });
  it('rounds odd sizes to even', () => {
    assert.deepEqual(pickSyntheticSize({ width: 641, height: 361 }), { width: 642, height: 362 });
  });
  it('detects what was requested', () => {
    assert.equal(wantsVideo({ video: true }), true);
    assert.equal(wantsVideo({ video: { width: 1 } }), true);
    assert.equal(wantsVideo({ video: false, audio: true }), false);
    assert.equal(wantsVideo(undefined), false);
    assert.equal(wantsAudio({ audio: true }), true);
    assert.equal(wantsAudio({ video: true }), false);
  });
});

describe('storage sanitising', () => {
  it('returns defaults for garbage', () => {
    for (const bad of [null, undefined, 5, 'x', [], { settings: 5, gifs: 'no', favorites: 'no' }]) {
      assert.deepEqual(sanitizeStoredState(bad), defaultState());
    }
  });
  it('keeps valid data and drops invalid fields one by one', () => {
    const s = sanitizeStoredState({
      settings: { startHoldMs: 250.4, defaultFit: 'fit' },
      lastUrl: `https://giphy.com/gifs/x-${ID}`,
      gifs: { [ID]: { fit: 'stretch', usedAt: 5 }, 'not an id': { fit: 'fit', usedAt: 1 }, abcdefghij: { fit: 'bogus', usedAt: 1 } },
      favorites: [ID, 'nope', 42],
    });
    assert.equal(s.settings.startHoldMs, 250);
    assert.equal(s.settings.defaultFit, 'fit');
    assert.equal(s.lastUrl, `https://giphy.com/gifs/x-${ID}`);
    assert.deepEqual(Object.keys(s.gifs), [ID]);
    assert.equal(s.gifs[ID]?.fit, 'stretch');
    assert.deepEqual(s.favorites, [ID]);
  });
  it('drops a stored URL that no longer validates', () => {
    assert.equal(sanitizeStoredState({ lastUrl: 'https://evil.example/x' }).lastUrl, '');
    assert.equal(sanitizeStoredState({ lastUrl: 'javascript:alert(1)' }).lastUrl, '');
  });
  it('clamps the start hold', () => {
    assert.equal(sanitizeStoredState({ settings: { startHoldMs: -5 } }).settings.startHoldMs, 0);
    assert.equal(sanitizeStoredState({ settings: { startHoldMs: 1e9 } }).settings.startHoldMs, 3000);
    assert.equal(sanitizeStoredState({ settings: { startHoldMs: 'abc' } }).settings.startHoldMs, 0);
  });
  it('is not fooled by prototype keys', () => {
    const raw = JSON.parse('{"gifs":{"__proto__":{"fit":"fit","usedAt":1}},"settings":{"__proto__":{"defaultFit":"fit"}}}');
    const s = sanitizeStoredState(raw);
    assert.deepEqual(Object.keys(s.gifs), []);
    assert.equal(({} as Record<string, unknown>)['fit'], undefined);
  });
  it('remembers the last fit per gif', () => {
    let s = defaultState();
    assert.equal(fitFor(s, ID), 'fill');
    s = recordGifUse(s, ID, 'fit', 10, `https://giphy.com/gifs/x-${ID}`);
    assert.equal(fitFor(s, ID), 'fit');
    s = recordGifUse(s, ID, 'stretch', 20, `https://giphy.com/gifs/x-${ID}`);
    assert.equal(fitFor(s, ID), 'stretch');
    assert.equal(fitFor(s, 'otherId1234'), 'stretch', 'new gifs start with the last fit used');
    s = recordGifUse(s, 'otherId1234', 'fill', 30, '');
    assert.equal(fitFor(s, ID), 'stretch', 'each gif keeps its own fit');
  });
  it('keeps only the most recent gifs', () => {
    let s = defaultState();
    for (let i = 0; i < MAX_STORED_GIFS + 10; i += 1) {
      const id = `id${String(i).padStart(8, '0')}`;
      s = recordGifUse(s, id, 'fit', i, '');
    }
    assert.equal(Object.keys(s.gifs).length, MAX_STORED_GIFS);
    assert.ok(s.gifs[`id${String(MAX_STORED_GIFS + 9).padStart(8, '0')}`]);
    assert.equal(s.gifs['id00000000'], undefined);
  });
});

describe('message validation', () => {
  const b64 = bytesToBase64(new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0]));
  const good = { type: 'start', room: 'abc-defg-hij', gifBase64: b64, fit: 'fill', startHoldMs: 0 };

  it('accepts a well-formed start, status and stop', () => {
    assert.ok(parsePopupRequest(good));
    assert.deepEqual(parsePopupRequest({ type: 'status' }), { type: 'status' });
    assert.deepEqual(parsePopupRequest({ type: 'stop', room: 'abc-defg-hij' }), { type: 'stop', room: 'abc-defg-hij' });
  });
  it('drops anything malformed', () => {
    for (const bad of [
      null,
      'start',
      [],
      { type: 'nope' },
      { ...good, room: 'x' },
      { ...good, room: undefined },
      { ...good, gifBase64: '' },
      { ...good, gifBase64: 'not base64!' },
      { ...good, gifBase64: 5 },
      { ...good, fit: 'cover' },
      { ...good, startHoldMs: -1 },
      { ...good, startHoldMs: 1.5 },
      { ...good, startHoldMs: 99999 },
      { ...good, startHoldMs: '0' },
      { type: 'stop', room: 'bad' },
      { type: 'stop' },
    ]) {
      assert.equal(parsePopupRequest(bad), null, JSON.stringify(bad)?.slice(0, 80));
    }
  });
  it('rejects an oversized payload', () => {
    assert.equal(parsePopupRequest({ ...good, gifBase64: 'A'.repeat(14 * 1024 * 1024) }), null);
  });
  it('validates hook requests', () => {
    const gif = new ArrayBuffer(16);
    assert.ok(parseHookRequest({ id: 1, cmd: 'start', room: 'abc-defg-hij', gif, fit: 'fit', startHoldMs: 100 }));
    assert.ok(parseHookRequest({ id: 2, cmd: 'status' }));
    assert.ok(parseHookRequest({ id: 3, cmd: 'stop', room: 'abc-defg-hij' }));
    for (const bad of [
      { cmd: 'status' },
      { id: 'x', cmd: 'status' },
      { id: 1, cmd: 'eval' },
      { id: 1, cmd: 'start', room: 'abc-defg-hij', gif: 'string', fit: 'fit', startHoldMs: 0 },
      { id: 1, cmd: 'start', room: 'abc-defg-hij', gif: new ArrayBuffer(0), fit: 'fit', startHoldMs: 0 },
      { id: 1, cmd: 'start', room: 'bad', gif, fit: 'fit', startHoldMs: 0 },
      { id: 1, cmd: 'start', room: 'abc-defg-hij', gif, fit: 'x', startHoldMs: 0 },
      null,
      'cmd',
    ]) {
      assert.equal(parseHookRequest(bad), null);
    }
  });
});
