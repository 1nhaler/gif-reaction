import type { ReactionController } from '../shared/reaction';
import type { GifPlayer } from './gif-player';
import type { LiveTracks } from './tracks';

export interface PipelineDeps {
  controller: ReactionController;
  player: GifPlayer;
  tracks: LiveTracks;
}

/** Draws gif frames (or black) onto a reusable canvas and wraps them as VideoFrames. */
class FrameComposer {
  private canvas: OffscreenCanvas | null = null;
  private ctx: OffscreenCanvasRenderingContext2D | null = null;

  constructor(private readonly player: GifPlayer) {}

  private prepare(width: number, height: number): OffscreenCanvasRenderingContext2D | null {
    if (!this.canvas || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas = new OffscreenCanvas(width, height);
      this.ctx = this.canvas.getContext('2d', { alpha: false });
    }
    return this.ctx;
  }

  gif(width: number, height: number, elapsedMs: number, timestamp: number, duration: number | null): VideoFrame | null {
    const ctx = this.prepare(width, height);
    if (!ctx || !this.canvas) return null;
    if (!this.player.draw(ctx, width, height, elapsedMs)) return null;
    return new VideoFrame(this.canvas, { timestamp, duration: duration ?? undefined });
  }

  blank(width: number, height: number, timestamp: number): VideoFrame | null {
    const ctx = this.prepare(width, height);
    if (!ctx || !this.canvas) return null;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    return new VideoFrame(this.canvas, { timestamp });
  }
}

/**
 * Camera is on: the real camera feeds a processor, and every frame goes through
 * the reaction controller before reaching the generator Meet receives. Audio
 * tracks are passed through untouched.
 */
export function wrapCameraStream(real: MediaStream, deps: PipelineDeps): MediaStream {
  const camera = real.getVideoTracks()[0];
  if (!camera) return real;

  const processor = new MediaStreamTrackProcessor({ track: camera });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();
  const composer = new FrameComposer(deps.player);
  let stopped = false;

  const teardown = () => {
    if (stopped) return;
    stopped = true;
    reader.cancel().catch(() => undefined);
    writer.close().catch(() => undefined);
    camera.stop(); // releases the hardware, so the camera light goes off
  };

  deps.tracks.add(generator, teardown);

  void (async () => {
    try {
      for (;;) {
        const { value: frame, done } = await reader.read();
        if (done || !frame) break;
        if (stopped) {
          frame.close();
          break;
        }
        let out: VideoFrame = frame;
        try {
          const directive = deps.controller.frame();
          if (directive.kind === 'gif') {
            const composed = composer.gif(frame.displayWidth, frame.displayHeight, directive.elapsedMs, frame.timestamp, frame.duration);
            if (composed) {
              frame.close();
              out = composed;
            }
          }
        } catch {
          // Whatever went wrong, the camera frame still goes out.
        }
        try {
          await writer.write(out);
        } catch {
          out.close();
          break;
        }
      }
    } catch {
      /* the camera went away */
    } finally {
      // Camera ended on its own, or we were torn down: make sure Meet's track ends too.
      generator.stop();
    }
  })();

  return new MediaStream([generator, ...real.getAudioTracks()]);
}

/**
 * Camera is off and a reaction is starting: build a stream that never touches the
 * camera hardware. It shows black until the controller says to show the gif.
 */
export function makeSyntheticStream(
  size: { width: number; height: number },
  audio: MediaStreamTrack[],
  deps: PipelineDeps,
): MediaStream {
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const writer = generator.writable.getWriter();
  const composer = new FrameComposer(deps.player);
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;

  const tick = () => {
    if (stopped) return;
    if (writer.desiredSize !== null && writer.desiredSize <= 0) return;
    const timestamp = Math.round(performance.now() * 1000);
    let frame: VideoFrame | null = null;
    try {
      const directive = deps.controller.frame();
      if (directive.kind === 'gif') frame = composer.gif(size.width, size.height, directive.elapsedMs, timestamp, null);
      if (!frame) frame = composer.blank(size.width, size.height, timestamp);
    } catch {
      frame = null;
    }
    if (!frame) return;
    const f = frame;
    writer.write(f).catch(() => f.close());
  };

  const teardown = () => {
    if (stopped) return;
    stopped = true;
    if (interval !== undefined) clearInterval(interval);
    writer.close().catch(() => undefined);
  };

  interval = setInterval(tick, 1000 / 30);
  deps.tracks.add(generator, teardown);
  tick();

  return new MediaStream([generator, ...audio]);
}
