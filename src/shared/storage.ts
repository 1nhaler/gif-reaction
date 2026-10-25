import { DEFAULT_START_HOLD_MS, MAX_START_HOLD_MS, MAX_STORED_GIFS } from './constants';
import { type FitMode, isFitMode } from './fit';
import { isValidGifId, parseGifInput } from './gif-source';

/**
 * Everything lives in chrome.storage.local, so it never leaves this browser.
 * `favorites` is reserved for the later favorites feature; v1 does not write it.
 */
export interface StoredState {
  version: 1;
  settings: { startHoldMs: number; defaultFit: FitMode };
  lastUrl: string;
  /** Fit chosen the last time each gif was used. */
  gifs: Record<string, { fit: FitMode; usedAt: number }>;
  favorites: string[];
}

export const STORAGE_KEY = 'mgr_state';

export function defaultState(): StoredState {
  return {
    version: 1,
    settings: { startHoldMs: DEFAULT_START_HOLD_MS, defaultFit: 'fill' },
    lastUrl: '',
    gifs: {},
    favorites: [],
  };
}

export function clampStartHold(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_START_HOLD_MS;
  return Math.min(MAX_START_HOLD_MS, Math.max(0, Math.round(n)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Anything read from storage is treated as untrusted and rebuilt field by field. */
export function sanitizeStoredState(raw: unknown): StoredState {
  const out = defaultState();
  if (!isRecord(raw)) return out;

  const settings = raw['settings'];
  if (isRecord(settings)) {
    out.settings.startHoldMs = clampStartHold(settings['startHoldMs']);
    if (isFitMode(settings['defaultFit'])) out.settings.defaultFit = settings['defaultFit'];
  }

  const lastUrl = raw['lastUrl'];
  if (typeof lastUrl === 'string' && parseGifInput(lastUrl).ok) out.lastUrl = lastUrl.trim();

  const gifs = raw['gifs'];
  if (isRecord(gifs)) {
    const entries: Array<[string, { fit: FitMode; usedAt: number }]> = [];
    for (const [id, entry] of Object.entries(gifs)) {
      if (!isValidGifId(id) || !isRecord(entry)) continue;
      const fit = entry['fit'];
      const usedAt = entry['usedAt'];
      if (!isFitMode(fit)) continue;
      entries.push([id, { fit, usedAt: typeof usedAt === 'number' && Number.isFinite(usedAt) ? usedAt : 0 }]);
    }
    entries.sort((a, b) => b[1].usedAt - a[1].usedAt);
    for (const [id, entry] of entries.slice(0, MAX_STORED_GIFS)) out.gifs[id] = entry;
  }

  const favorites = raw['favorites'];
  if (Array.isArray(favorites)) {
    out.favorites = favorites.filter(isValidGifId).slice(0, MAX_STORED_GIFS);
  }

  return out;
}

export function fitFor(state: StoredState, id: string): FitMode {
  return state.gifs[id]?.fit ?? state.settings.defaultFit;
}

/**
 * Records that a gif was used with a given fit. The newest fit wins, and it also
 * becomes the starting fit for gifs seen for the first time.
 */
export function recordGifUse(state: StoredState, id: string, fit: FitMode, now: number, url: string): StoredState {
  return sanitizeStoredState({
    ...state,
    settings: { ...state.settings, defaultFit: fit },
    lastUrl: url,
    gifs: { ...state.gifs, [id]: { fit, usedAt: now } },
  });
}
