import { MAX_REACTION_MS, MAX_START_HOLD_MS, TOGGLE_TIMEOUT_MS } from './constants';
import type { Phase } from './protocol';

/**
 * The reaction state machine. It knows nothing about the DOM: everything it
 * needs from the outside world comes through `ReactionEnv`, which is what makes
 * the camera on/off rules testable.
 *
 * Camera rules it enforces:
 * - Camera on:  the gif replaces the camera picture, then the camera returns.
 * - Camera off: Meet's camera is switched on, but the next camera request is
 *   answered with a gif-only stream, so the real camera is never opened. When
 *   the reaction ends the camera is switched off again.
 * - If the user toggles the camera by hand mid-reaction, the reaction is
 *   cancelled and nothing else touches the camera: the user's choice wins.
 */

export interface PreparedGif {
  /** Total length of one pass of the gif. */
  durationMs: number;
}

export interface ReactionEnv {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Meet currently holds a live video track that came from us. */
  isCameraOn(): boolean;
  /** Presses Meet's camera on/off toggle. */
  pressCameraToggle(): void;
  /** Decodes the gif and keeps its frames ready for drawing. */
  prepareGif(data: ArrayBuffer): Promise<PreparedGif>;
  /** Frees whatever `prepareGif` kept. */
  releaseGif(): void;
}

export type Directive = { kind: 'idle' } | { kind: 'gif'; elapsedMs: number };

export interface StartRequest {
  gif: ArrayBuffer;
  startHoldMs: number;
}

export type StartResult = { ok: true } | { ok: false; error: string };

export interface ReactionSnapshot {
  phase: Phase;
  origin: 'on' | 'off' | null;
  error: string | null;
}

export interface ReactionOptions {
  capMs?: number;
  toggleTimeoutMs?: number;
}

type Internal = 'idle' | 'preparing' | 'toggling-on' | 'holding' | 'playing' | 'toggling-off';

export class ReactionController {
  private phase: Internal = 'idle';
  private origin: 'on' | 'off' | null = null;
  private error: string | null = null;
  private runId = 0;
  private playMs = 0;
  private startHoldMs = 0;
  private holdStart = 0;
  private playStart = 0;
  private abortOnGrant = false;
  private timer: unknown = null;
  private readonly capMs: number;
  private readonly toggleTimeoutMs: number;

  constructor(
    private readonly env: ReactionEnv,
    options: ReactionOptions = {},
  ) {
    this.capMs = options.capMs ?? MAX_REACTION_MS;
    this.toggleTimeoutMs = options.toggleTimeoutMs ?? TOGGLE_TIMEOUT_MS;
  }

  // ---- queries ----------------------------------------------------------

  snapshot(): ReactionSnapshot {
    this.advance(this.env.now());
    let phase: Phase;
    switch (this.phase) {
      case 'idle':
        phase = 'idle';
        break;
      case 'preparing':
      case 'toggling-on':
        phase = 'starting';
        break;
      case 'holding':
        phase = 'holding';
        break;
      case 'playing':
        phase = 'playing';
        break;
      case 'toggling-off':
        phase = 'ending';
        break;
    }
    return { phase, origin: this.origin, error: this.error };
  }

  /** The next camera request must be answered without opening the real camera. */
  shouldSynthesizeNextGrant(): boolean {
    return this.phase === 'toggling-on';
  }

  /** What every output frame should show right now. Call once per frame. */
  frame(): Directive {
    const now = this.env.now();
    this.advance(now);
    switch (this.phase) {
      case 'holding':
        return { kind: 'gif', elapsedMs: 0 };
      case 'playing':
        return { kind: 'gif', elapsedMs: Math.min(this.playMs, Math.max(0, now - this.playStart)) };
      case 'toggling-off':
        return this.origin === 'off' && this.playMs > 0 ? { kind: 'gif', elapsedMs: Math.max(0, this.playMs - 1) } : { kind: 'idle' };
      default:
        return { kind: 'idle' };
    }
  }

  // ---- commands -----------------------------------------------------------

  async start(req: StartRequest): Promise<StartResult> {
    if (this.phase !== 'idle') return { ok: false, error: 'A reaction is already running.' };
    this.error = null;
    const run = ++this.runId;
    this.phase = 'preparing';

    let prepared: PreparedGif;
    try {
      prepared = await this.env.prepareGif(req.gif);
    } catch {
      if (run === this.runId && this.phase === 'preparing') this.phase = 'idle';
      this.env.releaseGif();
      return { ok: false, error: 'That gif could not be decoded.' };
    }
    if (run !== this.runId || this.phase !== 'preparing') {
      this.env.releaseGif();
      return { ok: false, error: 'Cancelled.' };
    }
    if (!(prepared.durationMs > 0)) {
      this.phase = 'idle';
      this.env.releaseGif();
      return { ok: false, error: 'That gif has no frames.' };
    }

    this.playMs = this.capMs;
    this.startHoldMs = Math.max(0, Math.min(MAX_START_HOLD_MS, Math.round(req.startHoldMs)));

    if (this.env.isCameraOn()) {
      this.origin = 'on';
      this.beginHold();
      return { ok: true };
    }

    this.origin = 'off';
    this.phase = 'toggling-on';
    this.abortOnGrant = false;
    this.setTimer(this.toggleTimeoutMs, () => {
      if (this.phase === 'toggling-on') {
        this.fail('Meet did not turn the camera on. Make sure the Meet tab is in a call, then try again.');
      }
    });
    try {
      this.env.pressCameraToggle();
    } catch {
      const message = 'Could not press the camera button in Meet.';
      this.fail(message);
      return { ok: false, error: message };
    }
    return { ok: true };
  }

  stop(): void {
    switch (this.phase) {
      case 'idle':
      case 'toggling-off':
        return;
      case 'preparing':
        this.runId += 1;
        this.phase = 'idle';
        return;
      case 'toggling-on':
        // The camera request is already on its way; undo it as soon as it lands.
        this.abortOnGrant = true;
        return;
      case 'holding':
      case 'playing':
        this.endPlayback();
        return;
    }
  }

  /**
   * The hook could not build the gif-only stream Meet asked for. The real camera
   * is never used as a fallback, so the reaction simply ends with an error.
   */
  failStart(message: string): void {
    if (this.phase === 'toggling-on') this.fail(message);
  }

  // ---- events from the page ----------------------------------------------

  /** A video track from us became live (Meet turned the camera on). */
  onCameraOn(): void {
    if (this.phase !== 'toggling-on') return;
    this.clearTimer();
    if (this.abortOnGrant) {
      this.abortOnGrant = false;
      this.playMs = 0;
      this.beginToggleOff();
    } else {
      this.beginHold();
    }
  }

  /** The last live video track from us ended (camera turned off, by us or by hand). */
  onCameraOff(): void {
    switch (this.phase) {
      case 'toggling-off':
        this.toIdle();
        return;
      case 'holding':
      case 'playing':
        // Toggled by hand (or the device went away): cancel, touch nothing else.
        this.toIdle();
        return;
      default:
        return;
    }
  }

  // ---- internals ---------------------------------------------------------

  private beginHold(): void {
    this.phase = 'holding';
    this.holdStart = this.env.now();
    this.advance(this.holdStart);
  }

  private advance(now: number): void {
    if (this.phase === 'holding' && now - this.holdStart >= this.startHoldMs) {
      this.phase = 'playing';
      this.playStart = this.holdStart + this.startHoldMs;
    }
    if (this.phase === 'playing' && now - this.playStart >= this.playMs) {
      this.endPlayback();
    }
  }

  private endPlayback(): void {
    if (this.origin === 'on') this.toIdle();
    else this.beginToggleOff();
  }

  private beginToggleOff(): void {
    this.phase = 'toggling-off';
    this.setTimer(this.toggleTimeoutMs, () => {
      if (this.phase === 'toggling-off') {
        this.fail('The camera could not be turned off automatically. Turn it off in Meet.');
      }
    });
    try {
      this.env.pressCameraToggle();
    } catch {
      this.fail('The camera could not be turned off automatically. Turn it off in Meet.');
    }
  }

  private toIdle(): void {
    this.clearTimer();
    this.phase = 'idle';
    this.origin = null;
    this.abortOnGrant = false;
    this.env.releaseGif();
  }

  private fail(message: string): void {
    this.toIdle();
    this.error = message;
  }

  private setTimer(ms: number, fn: () => void): void {
    this.clearTimer();
    this.timer = this.env.setTimeout(fn, ms);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      this.env.clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
