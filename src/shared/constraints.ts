export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 720;

type NumberOrRange = number | { exact?: number; ideal?: number; max?: number; min?: number } | undefined;

function pick(value: NumberOrRange): number | undefined {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    return value.exact ?? value.ideal ?? value.max ?? value.min;
  }
  return undefined;
}

function clampDimension(n: number | undefined, fallback: number): number {
  if (n === undefined || !Number.isFinite(n)) return fallback;
  const rounded = Math.round(n);
  if (rounded < 160 || rounded > 1920) return fallback;
  // Video encoders prefer even sizes.
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/** Output size for a camera-less (synthetic) stream, taken from what Meet asked for. */
export function pickSyntheticSize(video: unknown): { width: number; height: number } {
  if (video && typeof video === 'object') {
    const v = video as { width?: NumberOrRange; height?: NumberOrRange };
    const w = pick(v.width);
    const h = pick(v.height);
    if (w !== undefined && h !== undefined) {
      return { width: clampDimension(w, DEFAULT_WIDTH), height: clampDimension(h, DEFAULT_HEIGHT) };
    }
  }
  return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
}

export function wantsVideo(constraints: MediaStreamConstraints | undefined): boolean {
  return Boolean(constraints && constraints.video);
}

export function wantsAudio(constraints: MediaStreamConstraints | undefined): boolean {
  return Boolean(constraints && constraints.audio);
}
