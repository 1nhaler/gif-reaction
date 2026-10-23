import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ReactionController, type PreparedGif, type ReactionEnv } from '../src/shared/reaction';

/** A fake world: virtual clock, virtual timers, and a log of everything done to the camera. */
class FakeEnv implements ReactionEnv {
  time = 1000;
  cameraOn = false;
  toggles = 0;
  released = 0;
  gifMs = 2000;
  throwOnToggle = false;
  prepareGate: Promise<void> | null = null;
  prepareFails = false;
  private timers: Array<{ at: number; fn: () => void; id: number }> = [];
  private nextId = 1;

  now() {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number) {
    const id = this.nextId++;
    this.timers.push({ at: this.time + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown) {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
  isCameraOn() {
    return this.cameraOn;
  }
  pressCameraToggle() {
    if (this.throwOnToggle) throw new Error('no button');
    this.toggles += 1;
  }
  async prepareGif(): Promise<PreparedGif> {
    if (this.prepareGate) await this.prepareGate;
    if (this.prepareFails) throw new Error('bad gif');
    return { durationMs: this.gifMs };
  }
  releaseGif() {
    this.released += 1;
  }
  advance(ms: number) {
    this.time += ms;
    const due = this.timers.filter((t) => t.at <= this.time).sort((a, b) => a.at - b.at);
    this.timers = this.timers.filter((t) => t.at > this.time);
    for (const t of due) t.fn();
  }
}

const GIF = new ArrayBuffer(8);

describe('camera on: gif replaces the picture, then the camera returns', () => {
  let env: FakeEnv;
  let c: ReactionController;
  beforeEach(() => {
    env = new FakeEnv();
    env.cameraOn = true;
    c = new ReactionController(env);
  });

  it('plays from the first frame and ends by itself, never touching the camera', async () => {
    const r = await c.start({ gif: GIF, startHoldMs: 0 });
    assert.deepEqual(r, { ok: true });
    assert.equal(c.snapshot().phase, 'playing');
    assert.deepEqual(c.frame(), { kind: 'gif', elapsedMs: 0 });
    env.advance(500);
    assert.deepEqual(c.frame(), { kind: 'gif', elapsedMs: 500 });
    env.advance(1500);
    assert.deepEqual(c.frame(), { kind: 'idle' });
    assert.equal(c.snapshot().phase, 'idle');
    assert.equal(env.toggles, 0);
    assert.ok(env.released >= 1);
  });

  it('cuts a long gif off at 5 seconds', async () => {
    env.gifMs = 12_000;
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.advance(4999);
    assert.equal(c.frame().kind, 'gif');
    env.advance(2);
    assert.equal(c.frame().kind, 'idle');
  });

  it('a short gif plays once and ends early', async () => {
    env.gifMs = 800;
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.advance(799);
    assert.equal(c.frame().kind, 'gif');
    env.advance(2);
    assert.equal(c.frame().kind, 'idle');
  });

  it('start hold shows the first frame still, and the 5 second cap counts from playback start', async () => {
    env.gifMs = 9000;
    await c.start({ gif: GIF, startHoldMs: 1000 });
    assert.equal(c.snapshot().phase, 'holding');
    env.advance(900);
    assert.deepEqual(c.frame(), { kind: 'gif', elapsedMs: 0 });
    env.advance(150);
    assert.equal(c.snapshot().phase, 'playing');
    assert.deepEqual(c.frame(), { kind: 'gif', elapsedMs: 50 });
    env.advance(4900);
    assert.equal(c.frame().kind, 'gif');
    env.advance(100);
    assert.equal(c.frame().kind, 'idle');
  });

  it('Stop returns to the camera at once', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.advance(300);
    c.stop();
    assert.equal(c.frame().kind, 'idle');
    assert.equal(c.snapshot().phase, 'idle');
    assert.equal(env.toggles, 0);
  });

  it('a manual camera toggle cancels the reaction and presses nothing', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.advance(300);
    env.cameraOn = false;
    c.onCameraOff();
    assert.equal(c.snapshot().phase, 'idle');
    assert.equal(c.frame().kind, 'idle');
    assert.equal(env.toggles, 0);
  });

  it('refuses a second reaction while one is running', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    const second = await c.start({ gif: GIF, startHoldMs: 0 });
    assert.equal(second.ok, false);
  });

  it('can start again after one ends', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.advance(2500);
    assert.equal(c.snapshot().phase, 'idle');
    assert.deepEqual(await c.start({ gif: GIF, startHoldMs: 0 }), { ok: true });
  });

  it('clamps the start hold', async () => {
    await c.start({ gif: GIF, startHoldMs: 999_999 });
    env.advance(2900);
    assert.equal(c.snapshot().phase, 'holding');
    env.advance(200);
    assert.equal(c.snapshot().phase, 'playing');
  });
});

describe('camera off: switch it on for the gif, then off again, never the real camera', () => {
  let env: FakeEnv;
  let c: ReactionController;
  beforeEach(() => {
    env = new FakeEnv();
    env.cameraOn = false;
    c = new ReactionController(env);
  });

  it('presses the toggle once, asks for a gif-only stream, plays, then presses it back', async () => {
    assert.equal(c.shouldSynthesizeNextGrant(), false);
    const r = await c.start({ gif: GIF, startHoldMs: 0 });
    assert.deepEqual(r, { ok: true });
    assert.equal(env.toggles, 1);
    assert.equal(c.snapshot().phase, 'starting');
    assert.equal(c.shouldSynthesizeNextGrant(), true);

    // Meet answers by requesting the camera; the hook gives it a gif-only stream.
    env.cameraOn = true;
    c.onCameraOn();
    assert.equal(c.shouldSynthesizeNextGrant(), false);
    assert.equal(c.snapshot().phase, 'playing');
    assert.equal(c.frame().kind, 'gif');

    env.advance(2100);
    assert.equal(c.snapshot().phase, 'ending');
    assert.equal(env.toggles, 2, 'camera is switched off again when the gif ends');
    // While the camera shuts off, the last frame stays up rather than a flash of anything else.
    assert.deepEqual(c.frame(), { kind: 'gif', elapsedMs: 2000 });

    env.cameraOn = false;
    c.onCameraOff();
    assert.equal(c.snapshot().phase, 'idle');
    assert.equal(env.toggles, 2);
  });

  it('only the camera request during a reaction is synthetic', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.cameraOn = true;
    c.onCameraOn();
    // Once the stream is granted, a later request (e.g. the user turns the camera on themselves) is real.
    assert.equal(c.shouldSynthesizeNextGrant(), false);
  });

  it('honours the start hold before playing', async () => {
    await c.start({ gif: GIF, startHoldMs: 500 });
    env.cameraOn = true;
    c.onCameraOn();
    assert.equal(c.snapshot().phase, 'holding');
    assert.deepEqual(c.frame(), { kind: 'gif', elapsedMs: 0 });
    env.advance(500);
    assert.equal(c.snapshot().phase, 'playing');
  });

  it('Stop mid-reaction switches the camera off again', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.cameraOn = true;
    c.onCameraOn();
    env.advance(300);
    c.stop();
    assert.equal(c.snapshot().phase, 'ending');
    assert.equal(env.toggles, 2);
    env.cameraOn = false;
    c.onCameraOff();
    assert.equal(c.snapshot().phase, 'idle');
  });

  it('Stop before Meet answers: the camera is switched back off as soon as it arrives', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    c.stop();
    assert.equal(env.toggles, 1);
    assert.equal(c.shouldSynthesizeNextGrant(), true, 'the late camera request must still be synthetic');
    env.cameraOn = true;
    c.onCameraOn();
    assert.equal(env.toggles, 2);
    assert.deepEqual(c.frame(), { kind: 'idle' }, 'nothing is played');
    env.cameraOn = false;
    c.onCameraOff();
    assert.equal(c.snapshot().phase, 'idle');
  });

  it('a manual toggle mid-reaction cancels it and presses nothing more', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.cameraOn = true;
    c.onCameraOn();
    env.advance(300);
    // The user presses Meet's camera button: Meet stops our track.
    env.cameraOn = false;
    c.onCameraOff();
    assert.equal(c.snapshot().phase, 'idle');
    assert.equal(env.toggles, 1, 'the extension does not fight the user');
    env.advance(10_000);
    assert.equal(env.toggles, 1);
  });

  it('reports an error if Meet never turns the camera on', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.advance(6100);
    const s = c.snapshot();
    assert.equal(s.phase, 'idle');
    assert.match(s.error ?? '', /did not turn the camera on/);
    assert.equal(c.shouldSynthesizeNextGrant(), false);
    assert.equal(env.toggles, 1);
  });

  it('reports an error if the camera will not switch off, and does not keep pressing', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.cameraOn = true;
    c.onCameraOn();
    env.advance(2100);
    assert.equal(c.snapshot().phase, 'ending');
    env.advance(6100);
    const s = c.snapshot();
    assert.equal(s.phase, 'idle');
    assert.match(s.error ?? '', /could not be turned off/);
    assert.equal(env.toggles, 2);
  });

  it('fails cleanly when the camera button cannot be pressed', async () => {
    env.throwOnToggle = true;
    const r = await c.start({ gif: GIF, startHoldMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(c.snapshot().phase, 'idle');
    assert.equal(c.shouldSynthesizeNextGrant(), false);
  });

  it('failStart ends the reaction with an error and plays nothing', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    c.failStart('Could not build the gif stream.');
    const s = c.snapshot();
    assert.equal(s.phase, 'idle');
    assert.equal(s.error, 'Could not build the gif stream.');
    assert.equal(c.shouldSynthesizeNextGrant(), false);
    assert.equal(env.toggles, 1);
  });

  it('failStart is ignored outside the waiting phase', async () => {
    env.cameraOn = true;
    await c.start({ gif: GIF, startHoldMs: 0 });
    c.failStart('late');
    assert.equal(c.snapshot().phase, 'playing');
    assert.equal(c.snapshot().error, null);
  });

  it('a new start clears the previous error', async () => {
    await c.start({ gif: GIF, startHoldMs: 0 });
    env.advance(6100);
    assert.ok(c.snapshot().error);
    env.cameraOn = true;
    await c.start({ gif: GIF, startHoldMs: 0 });
    assert.equal(c.snapshot().error, null);
  });
});

describe('preparing the gif', () => {
  it('a gif that fails to decode never touches the camera', async () => {
    const env = new FakeEnv();
    env.prepareFails = true;
    const c = new ReactionController(env);
    const r = await c.start({ gif: GIF, startHoldMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(env.toggles, 0);
    assert.equal(c.snapshot().phase, 'idle');
  });

  it('Stop during decoding cancels without touching the camera', async () => {
    const env = new FakeEnv();
    let open!: () => void;
    env.prepareGate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const c = new ReactionController(env);
    const started = c.start({ gif: GIF, startHoldMs: 0 });
    assert.equal(c.snapshot().phase, 'starting');
    c.stop();
    open();
    const r = await started;
    assert.equal(r.ok, false);
    assert.equal(env.toggles, 0);
    assert.equal(c.snapshot().phase, 'idle');
    assert.ok(env.released >= 1);
  });

  it('a gif with no duration is rejected', async () => {
    const env = new FakeEnv();
    env.gifMs = 0;
    const c = new ReactionController(env);
    const r = await c.start({ gif: GIF, startHoldMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(env.toggles, 0);
  });
});
