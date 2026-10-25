import { MAX_INPUT_LENGTH } from './constants';
import { GiphySource } from './giphy';
import { TenorSource } from './tenor';

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

export type GifParseResult =
  | { ok: true; id: string; mediaUrls: string[]; resolve?: (signal?: AbortSignal) => Promise<string[]> }
  | { ok: false; code: ParseErrorCode; message: string };

export interface GifSource {
  readonly name: string;
  canHandle(url: URL): boolean;
  parse(url: URL, rawText: string): GifParseResult;
  isAllowedMediaUrl(url: URL): boolean;
}

export class GifSourceRegistry {
  private sources: GifSource[] = [];

  register(source: GifSource): void {
    this.sources.push(source);
  }

  getSources(): readonly GifSource[] {
    return this.sources;
  }

  isAllowedMediaUrl(text: string): boolean {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return false;
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
      return false;
    }
    return this.sources.some((s) => s.isAllowedMediaUrl(url));
  }

  parse(input: string): GifParseResult {
    const text = input.trim();
    if (text.length === 0) return { ok: false, code: 'empty', message: 'Paste a GIF link.' };
    if (text.length > MAX_INPUT_LENGTH) return { ok: false, code: 'too-long', message: 'That link is too long.' };
    if (/[^\x21-\x7e]/.test(text)) {
      return { ok: false, code: 'bad-characters', message: 'The link contains characters that are not allowed.' };
    }

    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return {
        ok: false,
        code: 'invalid-url',
        message: 'That is not a valid link. Paste the full link, starting with https://',
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

    for (const source of this.sources) {
      if (source.canHandle(url)) {
        return source.parse(url, text);
      }
    }

    return { ok: false, code: 'host-not-allowed', message: 'Only Tenor and Giphy links are accepted.' };
  }
}

const ID_RE = /^[A-Za-z0-9_\-]{6,64}$/;

export function isValidGifId(value: unknown): value is string {
  return typeof value === 'string' && ID_RE.test(value);
}

/** Default registry: Tenor is tried first, then Giphy. */
export const defaultRegistry = new GifSourceRegistry();
defaultRegistry.register(new TenorSource());
defaultRegistry.register(new GiphySource());

export function parseGifInput(input: string): GifParseResult {
  return defaultRegistry.parse(input);
}

export function isAllowedMediaUrl(text: string): boolean {
  return defaultRegistry.isAllowedMediaUrl(text);
}
