import { FETCH_TIMEOUT_MS, MAX_GIF_BYTES } from './constants';
import { isAllowedMediaUrl } from './giphy';

export type FetchErrorCode =
  | 'blocked-url'
  | 'redirect-blocked'
  | 'http-error'
  | 'bad-content-type'
  | 'too-large'
  | 'bad-file'
  | 'network'
  | 'timeout';

export class GifFetchError extends Error {
  constructor(
    public readonly code: FetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GifFetchError';
  }
}

export interface FetchedGif {
  bytes: ArrayBuffer;
  url: string;
}

export interface FetchDeps {
  fetch: typeof fetch;
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** GIF87a / GIF89a magic bytes. */
export function looksLikeGif(bytes: Uint8Array): boolean {
  if (bytes.length < 10) return false;
  const sig = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!, bytes[4]!, bytes[5]!);
  return sig === 'GIF87a' || sig === 'GIF89a';
}

async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = res.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) throw new GifFetchError('too-large', 'That gif is too large.');
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new GifFetchError('too-large', 'That gif is too large.');
    return buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new GifFetchError('too-large', 'That gif is too large.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function fetchOne(url: string, deps: FetchDeps): Promise<FetchedGif> {
  const maxBytes = deps.maxBytes ?? MAX_GIF_BYTES;
  if (!isAllowedMediaUrl(url)) throw new GifFetchError('blocked-url', 'That address is not allowed.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? FETCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  deps.signal?.addEventListener('abort', onOuterAbort);

  try {
    let res: Response;
    try {
      res = await deps.fetch(url, {
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      if (controller.signal.aborted) throw new GifFetchError('timeout', 'The download timed out.');
      throw new GifFetchError('network', 'Could not download that gif.');
    }

    // A redirect may have taken us somewhere else: check where we ended up.
    if (res.url && !isAllowedMediaUrl(res.url)) {
      await res.body?.cancel().catch(() => undefined);
      throw new GifFetchError('redirect-blocked', 'The link redirected somewhere that is not allowed.');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new GifFetchError('http-error', `Giphy answered with status ${res.status}.`);
    }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    if (!/^image\/gif(?:;|$)/.test(type)) {
      await res.body?.cancel().catch(() => undefined);
      throw new GifFetchError('bad-content-type', 'That link is not a gif.');
    }

    let body: Uint8Array;
    try {
      body = await readCapped(res, maxBytes);
    } catch (err) {
      if (err instanceof GifFetchError) throw err;
      if (deps.signal?.aborted) throw err;
      if (controller.signal.aborted) throw new GifFetchError('timeout', 'The download timed out.');
      throw new GifFetchError('network', 'Could not download that gif.');
    }
    if (!looksLikeGif(body)) throw new GifFetchError('bad-file', 'The downloaded file is not a valid gif.');

    const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return { bytes, url: res.url || url };
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * Tries each candidate URL in order. A missing rendition or an oversized file
 * moves on to the next one; anything suspicious (blocked URL, bad redirect,
 * wrong file type) stops immediately.
 */
export async function fetchGif(urls: string[], deps: FetchDeps): Promise<FetchedGif> {
  let last: unknown = new GifFetchError('http-error', 'No download address was available.');
  for (const url of urls) {
    try {
      return await fetchOne(url, deps);
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      last = err;
      if (err instanceof GifFetchError && (err.code === 'http-error' || err.code === 'too-large')) continue;
      throw err;
    }
  }
  if (last instanceof GifFetchError && last.code === 'http-error') {
    throw new GifFetchError('http-error', 'Giphy has no downloadable gif for that link.');
  }
  throw last;
}
