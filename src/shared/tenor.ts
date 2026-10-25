import type { GifParseResult, GifSource, ParseErrorCode } from './gif-source';

const PAGE_HOSTS = new Set(['tenor.com', 'www.tenor.com']);
const MEDIA_HOST_RE = /^(?:media[0-9]?|c)\.tenor\.com$/;

// Matches /m/<hash>/<slug>.<ext> or /<hash>/<slug>.<ext>
const MEDIA_PATH_RE = /^\/(?:(m)\/)?([A-Za-z0-9_\-]+)\/([A-Za-z0-9_\-]+)\.(?:gif|mp4|webm|webp)$/i;

// Allowed media URL must be a direct .gif on a Tenor media CDN
const ALLOWED_MEDIA_PATH_RE = /^\/(?:m\/)?[A-Za-z0-9_\-]+\/[A-Za-z0-9_\-]+\.gif$/;

// Matches /view/<slug>-<id> or /view/<id>
const PAGE_PATH_RE = /^\/view\/((?:[A-Za-z0-9_-]|%(?!2[eEfF]|5[cC])[0-9A-Fa-f]{2})+)\/?$/;

function fail(code: ParseErrorCode, message: string): GifParseResult {
  return { ok: false, code, message };
}

function extractBaseId(hash: string): string {
  const idx = hash.indexOf('AAA');
  if (idx >= 4) {
    return hash.slice(0, idx);
  }
  return hash;
}

export function buildTenorMediaUrls(host: string, mPrefix: string, baseId: string, slug: string): string[] {
  const prefix = mPrefix ? `${mPrefix}/` : '';
  const renditions = ['AAAAM', 'AAAAC', 'AAAAd'];
  const urls = renditions.map((r) => `https://${host}/${prefix}${baseId}${r}/${slug}.gif`);
  const rawUrl = `https://${host}/${prefix}${baseId}/${slug}.gif`;
  if (!urls.includes(rawUrl)) {
    urls.push(rawUrl);
  }
  return urls;
}

export function parseTenorDirectMedia(url: URL): { id: string; mediaUrls: string[] } | null {
  const m = MEDIA_PATH_RE.exec(url.pathname);
  if (!m || m[2] === undefined || m[3] === undefined) return null;
  const mPrefix = m[1] ?? '';
  const hash = m[2];
  const slug = m[3];
  const id = extractBaseId(hash);
  return { id, mediaUrls: buildTenorMediaUrls(url.hostname, mPrefix, id, slug) };
}

export async function resolveTenorPage(pageUrl: string, signal?: AbortSignal): Promise<string[]> {
  const res = await fetch(pageUrl, {
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    signal,
  });
  if (!res.ok) {
    throw new Error(`Tenor page answered with status ${res.status}.`);
  }
  const html = await res.text();
  const og = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i);
  if (og && og[1]) {
    try {
      const parsed = parseTenorDirectMedia(new URL(og[1]));
      if (parsed) return parsed.mediaUrls;
    } catch {
      /* fall through to direct string check */
    }
    return [og[1]];
  }
  const fallback = html.match(/https:\/\/(?:media[0-9]?|c)\.tenor\.com\/(?:m\/)?[A-Za-z0-9_\-]+\/[A-Za-z0-9_\-]+\.gif/i);
  if (fallback && fallback[0]) {
    try {
      const parsed = parseTenorDirectMedia(new URL(fallback[0]));
      if (parsed) return parsed.mediaUrls;
    } catch {
      /* fall through */
    }
    return [fallback[0]];
  }
  throw new Error('Could not find a GIF on that Tenor page.');
}

export class TenorSource implements GifSource {
  readonly name = 'tenor';

  canHandle(url: URL): boolean {
    return PAGE_HOSTS.has(url.hostname) || MEDIA_HOST_RE.test(url.hostname);
  }

  parse(url: URL, rawText: string): GifParseResult {
    const host = url.hostname;
    const path = url.pathname;

    if (MEDIA_HOST_RE.test(host)) {
      const parsed = parseTenorDirectMedia(url);
      if (!parsed) {
        return fail('unsupported-link', 'Paste a Tenor gif page link (tenor.com/view/...) or direct media link.');
      }
      return { ok: true, id: parsed.id, mediaUrls: parsed.mediaUrls };
    }

    if (PAGE_HOSTS.has(host)) {
      const pageMatch = PAGE_PATH_RE.exec(path);
      if (!pageMatch || pageMatch[1] === undefined) {
        return fail('unsupported-link', 'Paste a Tenor gif page link (tenor.com/view/...).');
      }
      const slug = pageMatch[1];
      const id = slug.split('-').pop() ?? slug;
      return {
        ok: true,
        id,
        mediaUrls: [],
        resolve: (signal) => resolveTenorPage(rawText, signal),
      };
    }

    return fail('host-not-allowed', 'Only Tenor links are accepted by this provider.');
  }

  isAllowedMediaUrl(url: URL): boolean {
    if (url.search !== '' || url.hash !== '') return false;
    if (!MEDIA_HOST_RE.test(url.hostname)) return false;
    return ALLOWED_MEDIA_PATH_RE.test(url.pathname);
  }
}
