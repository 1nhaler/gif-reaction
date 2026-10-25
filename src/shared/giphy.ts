import { MAX_INPUT_LENGTH } from './constants';
import type { GifParseResult, GifSource } from './gif-source';

/**
 * Strict Giphy link handling.
 *
 * The pasted text is never fetched. We parse it, pull out the gif ID with a
 * strict pattern, and rebuild every URL we fetch from a fixed template. That
 * means the fetched URL is always one this extension constructed.
 */

export type ParseErrorCode =
  | 'empty'
  | 'too-long'
  | 'bad-characters'
  | 'invalid-url'
  | 'not-https'
  | 'credentials'
  | 'port'
  | 'host-not-allowed'
  | 'unsupported-link'
  | 'bad-id';

export type GiphyParseResult =
  | { ok: true; id: string; mediaUrls: string[] }
  | { ok: false; code: ParseErrorCode; message: string };

const ID_RE = /^[A-Za-z0-9]{6,32}$/;

/** Renditions tried in order; the first that downloads within the size cap wins. */
export const RENDITIONS = ['giphy-downsized-medium.gif', 'giphy.gif', 'giphy-downsized.gif'] as const;

const PAGE_HOSTS = new Set(['giphy.com', 'www.giphy.com']);
const MEDIA_HOST_RE = /^media[0-9]?\.giphy\.com$/;
const IMAGE_HOST = 'i.giphy.com';

const MEDIA_FILE = String.raw`[A-Za-z0-9_\-]+\.(?:gif|webp|mp4|webm|png|jpg)`;
// /media/<id>/giphy.gif and the newer /media/v1.<token>/<id>/giphy.gif
const MEDIA_PATH_RE = new RegExp(String.raw`^/media/(?:v1\.[A-Za-z0-9_=\-]+/)?([A-Za-z0-9]+)/${MEDIA_FILE}$`);
// i.giphy.com/<id>.gif
const IMAGE_PATH_RE = /^\/([A-Za-z0-9]+)\.(?:gif|webp|mp4|png|jpg)$/;
// /gifs/<slug>-<id>, /gifs/<id>, /stickers/<slug>-<id>. Slugs hold letters, digits,
// hyphens and percent-encoded UTF-8, but never an encoded dot, slash or backslash.
const PAGE_PATH_RE = /^\/(?:gifs|stickers)\/((?:[A-Za-z0-9_-]|%(?!2[eEfF]|5[cC])[0-9A-Fa-f]{2})+)\/?$/;
// /embed/<id>
const EMBED_PATH_RE = /^\/embed\/([A-Za-z0-9]+)\/?$/;

function fail(code: ParseErrorCode, message: string): GiphyParseResult {
  return { ok: false, code, message };
}

type HostCheck = { ok: true; url: URL } | { ok: false; code: ParseErrorCode; message: string };

/** Shared by the parser and the fetcher: https only, no credentials, no port. */
function checkUrlShape(text: string): HostCheck {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return {
      ok: false,
      code: 'invalid-url',
      message: 'That is not a valid link. Paste the full Giphy link, starting with https://',
    };
  }
  if (url.protocol !== 'https:') {
    return { ok: false, code: 'not-https', message: 'Only https:// links are accepted.' };
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: 'credentials', message: 'Links with a username or password are not accepted.' };
  }
  if (url.port !== '') {
    return { ok: false, code: 'port', message: 'Links with a custom port are not accepted.' };
  }
  return { ok: true, url };
}

function idFromSlug(slug: string): string | null {
  const last = slug.split('-').pop() ?? '';
  return ID_RE.test(last) ? last : null;
}

export function mediaUrlsForId(id: string): string[] {
  if (!ID_RE.test(id)) throw new Error('Invalid gif id');
  return RENDITIONS.map((r) => `https://media.giphy.com/media/${id}/${r}`);
}

export function parseGiphyInput(input: string): GiphyParseResult {
  const text = input.trim();
  if (text.length === 0) return fail('empty', 'Paste a Giphy link.');
  if (text.length > MAX_INPUT_LENGTH) return fail('too-long', 'That link is too long.');
  // Printable ASCII only: no whitespace, control characters, bidi tricks or lookalike letters.
  if (/[^\x21-\x7e]/.test(text)) {
    return fail('bad-characters', 'The link contains characters that are not allowed.');
  }

  const shape = checkUrlShape(text);
  if (!shape.ok) return fail(shape.code, shape.message);
  const { url } = shape;
  const host = url.hostname;
  const path = url.pathname;

  let id: string | null = null;

  if (PAGE_HOSTS.has(host)) {
    const page = PAGE_PATH_RE.exec(path);
    const embed = EMBED_PATH_RE.exec(path);
    if (page && page[1] !== undefined) id = idFromSlug(page[1]);
    else if (embed && embed[1] !== undefined) id = embed[1];
  } else if (MEDIA_HOST_RE.test(host)) {
    const m = MEDIA_PATH_RE.exec(path);
    if (m && m[1] !== undefined) id = m[1];
  } else if (host === IMAGE_HOST) {
    const media = MEDIA_PATH_RE.exec(path);
    const img = IMAGE_PATH_RE.exec(path);
    if (media && media[1] !== undefined) id = media[1];
    else if (img && img[1] !== undefined) id = img[1];
  } else {
    return fail('host-not-allowed', 'Only giphy.com links are accepted.');
  }

  if (id === null) {
    return fail(
      'unsupported-link',
      'Paste a Giphy gif page link (giphy.com/gifs/...) or a direct media link (media.giphy.com/media/...).',
    );
  }
  if (!ID_RE.test(id)) return fail('bad-id', 'That link does not contain a valid gif ID.');

  return { ok: true, id, mediaUrls: mediaUrlsForId(id) };
}

/**
 * True only for URLs of the exact shape this extension builds. Used before every
 * fetch, and on the final URL after redirects.
 */
export function isAllowedMediaUrl(text: string): boolean {
  const shape = checkUrlShape(text);
  if (!shape.ok) return false;
  const { url } = shape;
  if (url.search !== '' || url.hash !== '') return false;
  if (!(MEDIA_HOST_RE.test(url.hostname) || url.hostname === IMAGE_HOST)) return false;
  return MEDIA_PATH_RE.test(url.pathname) || (url.hostname === IMAGE_HOST && IMAGE_PATH_RE.test(url.pathname));
}

/** Validates an ID read back from storage or a message. */
export function isValidGifId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

export class GiphySource implements GifSource {
  readonly name = 'giphy';

  canHandle(url: URL): boolean {
    return PAGE_HOSTS.has(url.hostname) || MEDIA_HOST_RE.test(url.hostname) || url.hostname === IMAGE_HOST;
  }

  parse(_url: URL, rawText: string): GifParseResult {
    return parseGiphyInput(rawText);
  }

  isAllowedMediaUrl(url: URL): boolean {
    if (url.search !== '' || url.hash !== '') return false;
    if (!(MEDIA_HOST_RE.test(url.hostname) || url.hostname === IMAGE_HOST)) return false;
    return MEDIA_PATH_RE.test(url.pathname) || (url.hostname === IMAGE_HOST && IMAGE_PATH_RE.test(url.pathname));
  }
}
