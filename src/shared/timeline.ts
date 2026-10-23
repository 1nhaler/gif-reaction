import { DECODE_BUDGET_BYTES, MAX_DECODED_FRAMES } from './constants';

/**
 * Browsers show gif frames with a delay under ~20 ms at 100 ms, because many
 * gifs in the wild carry a zero delay. We do the same so playback speed matches.
 */
export function normalizeFrameDurationMs(durationMs: number | null | undefined): number {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) return 100;
  return durationMs < 20 ? 100 : durationMs;
}

export interface Timeline {
  /** End time of each frame in ms, measured from the start of the gif. */
  ends: number[];
  totalMs: number;
}

export function buildTimeline(durationsMs: ReadonlyArray<number | null | undefined>): Timeline {
  const ends: number[] = [];
  let total = 0;
  for (const d of durationsMs) {
    total += normalizeFrameDurationMs(d);
    ends.push(total);
  }
  return { ends, totalMs: total };
}

/** Index of the frame that is on screen `elapsedMs` after playback started. */
export function frameIndexAt(timeline: Timeline, elapsedMs: number): number {
  const { ends } = timeline;
  if (ends.length === 0) return 0;
  if (!(elapsedMs > 0)) return 0;
  let lo = 0;
  let hi = ends.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (elapsedMs < ends[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * How many frames are worth decoding: enough to cover `capMs`, never more than
 * the frame limit.
 */
export function framesNeeded(durationsMs: ReadonlyArray<number | null | undefined>, capMs: number): number {
  let total = 0;
  let count = 0;
  for (const d of durationsMs) {
    if (count >= MAX_DECODED_FRAMES) break;
    count += 1;
    total += normalizeFrameDurationMs(d);
    if (total >= capMs) break;
  }
  return count;
}

/** Scale (<= 1) to apply when decoding so the decoded frames fit in the memory budget. */
export function chooseDecodeScale(
  width: number,
  height: number,
  frames: number,
  budgetBytes: number = DECODE_BUDGET_BYTES,
): number {
  if (!(width > 0 && height > 0 && frames > 0)) return 1;
  const needed = width * height * 4 * frames;
  if (needed <= budgetBytes) return 1;
  return Math.sqrt(budgetBytes / needed);
}
