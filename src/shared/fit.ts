export type FitMode = 'fill' | 'fit' | 'stretch';

export const FIT_MODES: readonly FitMode[] = ['fill', 'fit', 'stretch'];

export function isFitMode(value: unknown): value is FitMode {
  return value === 'fill' || value === 'fit' || value === 'stretch';
}

export interface Rect {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/**
 * Where to draw a source image inside a destination frame.
 * fill: cover the whole frame, cropping the overflow.
 * fit: keep the whole image visible, leaving bars on the short side.
 * stretch: ignore the aspect ratio.
 */
export function computeDrawRect(srcW: number, srcH: number, dstW: number, dstH: number, mode: FitMode): Rect {
  if (!(srcW > 0 && srcH > 0 && dstW > 0 && dstH > 0)) return { dx: 0, dy: 0, dw: Math.max(dstW, 0), dh: Math.max(dstH, 0) };
  if (mode === 'stretch') return { dx: 0, dy: 0, dw: dstW, dh: dstH };
  const scale = mode === 'fill' ? Math.max(dstW / srcW, dstH / srcH) : Math.min(dstW / srcW, dstH / srcH);
  const dw = srcW * scale;
  const dh = srcH * scale;
  return { dx: (dstW - dw) / 2, dy: (dstH - dh) / 2, dw, dh };
}
