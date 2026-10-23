/** Hard cap on how long a reaction may play, counted from when playback starts. */
export const MAX_REACTION_MS = 5000;

/** Largest gif file we will download, keep in memory, or send to the page. */
export const MAX_GIF_BYTES = 10 * 1024 * 1024;

/** Longest text accepted in the URL box. */
export const MAX_INPUT_LENGTH = 2000;

export const FETCH_TIMEOUT_MS = 15_000;

export const DEFAULT_START_HOLD_MS = 0;
export const MAX_START_HOLD_MS = 3000;

/** How long to wait for Meet to react after we press its camera toggle. */
export const TOGGLE_TIMEOUT_MS = 6000;

/** Memory budget for decoded gif frames (RGBA bytes). */
export const DECODE_BUDGET_BYTES = 192 * 1024 * 1024;

/** Gifs with more frames than this are cut off, whatever their duration. */
export const MAX_DECODED_FRAMES = 400;

/** Most gifs remembered in storage (fit setting per gif). */
export const MAX_STORED_GIFS = 50;
