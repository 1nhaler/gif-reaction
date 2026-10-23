import { MAX_DECODED_FRAMES, MAX_REACTION_MS } from '../shared/constants';
import { type FitMode, computeDrawRect } from '../shared/fit';
import { buildTimeline, chooseDecodeScale, frameIndexAt, normalizeFrameDurationMs, type Timeline } from '../shared/timeline';

interface Decoded {
  bitmaps: ImageBitmap[];
  timeline: Timeline;
}

/**
 * Decodes the gif once, up front, with WebCodecs. Working from the bytes means
 * the page never has to load anything from Giphy, so Meet's content security
 * policy cannot get in the way.
 */
export class GifPlayer {
  fit: FitMode = 'fill';
  private decoded: Decoded | null = null;

  static isSupported(): boolean {
    return (
      typeof ImageDecoder !== 'undefined' &&
      typeof createImageBitmap === 'function' &&
      typeof OffscreenCanvas !== 'undefined' &&
      typeof VideoFrame !== 'undefined'
    );
  }

  async prepare(data: ArrayBuffer): Promise<{ durationMs: number }> {
    this.release();
    const decoder = new ImageDecoder({ data, type: 'image/gif' });
    const bitmaps: ImageBitmap[] = [];
    const durations: number[] = [];
    try {
      await decoder.tracks.ready;
      const track = decoder.tracks.selectedTrack;
      const frameCount = track?.frameCount ?? 0;
      if (frameCount < 1) throw new Error('No frames');
      const limit = Math.min(frameCount, MAX_DECODED_FRAMES);

      let total = 0;
      let resize: ImageBitmapOptions | undefined;
      for (let i = 0; i < limit; i += 1) {
        const { image } = await decoder.decode({ frameIndex: i });
        try {
          if (i === 0) {
            const scale = chooseDecodeScale(image.displayWidth, image.displayHeight, limit);
            if (scale < 1) {
              resize = {
                resizeWidth: Math.max(2, Math.round(image.displayWidth * scale)),
                resizeHeight: Math.max(2, Math.round(image.displayHeight * scale)),
                resizeQuality: 'medium',
              };
            }
          }
          const durationMs = image.duration === null ? null : image.duration / 1000;
          durations.push(normalizeFrameDurationMs(durationMs));
          bitmaps.push(await createImageBitmap(image, resize));
          total += normalizeFrameDurationMs(durationMs);
        } finally {
          image.close();
        }
        if (total >= MAX_REACTION_MS) break;
      }
    } catch (err) {
      for (const b of bitmaps) b.close();
      throw err;
    } finally {
      decoder.close();
    }

    const timeline = buildTimeline(durations);
    this.decoded = { bitmaps, timeline };
    return { durationMs: timeline.totalMs };
  }

  /** Draws the frame that is on screen `elapsedMs` into playback. Returns false if no gif is loaded. */
  draw(ctx: OffscreenCanvasRenderingContext2D, width: number, height: number, elapsedMs: number): boolean {
    const d = this.decoded;
    if (!d) return false;
    const bitmap = d.bitmaps[frameIndexAt(d.timeline, elapsedMs)];
    if (!bitmap) return false;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    const r = computeDrawRect(bitmap.width, bitmap.height, width, height, this.fit);
    ctx.drawImage(bitmap, r.dx, r.dy, r.dw, r.dh);
    return true;
  }

  release(): void {
    if (!this.decoded) return;
    for (const b of this.decoded.bitmaps) b.close();
    this.decoded = null;
  }
}
