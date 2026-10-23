import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GifFetchError, fetchGif, looksLikeGif } from '../src/shared/fetch-gif';
import { mediaUrlsForId } from '../src/shared/giphy';

const ID = '3o7TKSjRrfIPjeiVyM';
const URLS = mediaUrlsForId(ID);

function gifBytes(extra = 32): Uint8Array {
  const b = new Uint8Array(10 + extra);
  b.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  return b;
}

/** Builds a Response whose `url` we control (Response.url is read-only). */
function response(body: Uint8Array | string, init: { status?: number; type?: string; url?: string; length?: string } = {}): Response {
  const headers: Record<string, string> = {};
  if (init.type !== undefined) headers['content-type'] = init.type;
  if (init.length !== undefined) headers['content-length'] = init.length;
  const res = new Response(body as BodyInit, { status: init.status ?? 200, headers });
  Object.defineProperty(res, 'url', { value: init.url ?? '' });
  return res;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

describe('fetchGif', () => {
  it('downloads a valid gif without credentials or referrer', async () => {
    let seen: RequestInit | undefined;
    const f = fakeFetch((url, init) => {
      seen = init;
      return response(gifBytes(), { type: 'image/gif', url });
    });
    const out = await fetchGif(URLS, { fetch: f });
    assert.equal(out.bytes.byteLength, 42);
    assert.equal(seen?.credentials, 'omit');
    assert.equal(seen?.referrerPolicy, 'no-referrer');
  });

  it('tries the next rendition when one is missing', async () => {
    const asked: string[] = [];
    const f = fakeFetch((url) => {
      asked.push(url);
      return asked.length === 1 ? response('nope', { status: 404, url }) : response(gifBytes(), { type: 'image/gif', url });
    });
    await fetchGif(URLS, { fetch: f });
    assert.equal(asked.length, 2);
  });

  it('skips a rendition that is too large and takes the next', async () => {
    const f = fakeFetch((url) =>
      url.endsWith('giphy-downsized-medium.gif')
        ? response(gifBytes(2000), { type: 'image/gif', url })
        : response(gifBytes(20), { type: 'image/gif', url }),
    );
    const out = await fetchGif(URLS, { fetch: f, maxBytes: 500 });
    assert.equal(out.bytes.byteLength, 30);
  });

  it('rejects on a declared size that is too large without reading the body', async () => {
    const f = fakeFetch((url) => response(gifBytes(), { type: 'image/gif', url, length: '999999999' }));
    await assert.rejects(fetchGif(URLS, { fetch: f, maxBytes: 1000 }), (e: unknown) => e instanceof GifFetchError && e.code === 'too-large');
  });

  it('rejects a body that outgrows the cap even when the header lies', async () => {
    const f = fakeFetch((url) => response(gifBytes(5000), { type: 'image/gif', url, length: '10' }));
    await assert.rejects(fetchGif([URLS[0]!], { fetch: f, maxBytes: 1000 }), (e: unknown) => e instanceof GifFetchError && e.code === 'too-large');
  });

  it('refuses a redirect that lands off the allowlist', async () => {
    const f = fakeFetch(() => response(gifBytes(), { type: 'image/gif', url: 'https://evil.example/x.gif' }));
    await assert.rejects(fetchGif(URLS, { fetch: f }), (e: unknown) => e instanceof GifFetchError && e.code === 'redirect-blocked');
  });

  it('refuses a redirect to a different path on an allowed host', async () => {
    const f = fakeFetch(() => response(gifBytes(), { type: 'image/gif', url: 'https://media.giphy.com/not-media/x.gif' }));
    await assert.rejects(fetchGif(URLS, { fetch: f }), (e: unknown) => e instanceof GifFetchError && e.code === 'redirect-blocked');
  });

  it('refuses a response that is not a gif by content type', async () => {
    for (const type of ['text/html', 'application/javascript', 'image/svg+xml', 'image/png', '']) {
      const f = fakeFetch((url) => response(gifBytes(), { type, url }));
      await assert.rejects(fetchGif(URLS, { fetch: f }), (e: unknown) => e instanceof GifFetchError && e.code === 'bad-content-type', type);
    }
  });

  it('refuses a file that claims to be a gif but is not', async () => {
    const f = fakeFetch((url) => response('<html><script>alert(1)</script></html>', { type: 'image/gif', url }));
    await assert.rejects(fetchGif(URLS, { fetch: f }), (e: unknown) => e instanceof GifFetchError && e.code === 'bad-file');
  });

  it('never fetches a URL that is not of the allowed shape', async () => {
    let calls = 0;
    const f = fakeFetch(() => {
      calls += 1;
      return response(gifBytes(), { type: 'image/gif' });
    });
    for (const bad of ['http://media.giphy.com/media/abc12345678/giphy.gif', 'https://evil.example/a.gif', 'javascript:alert(1)', `https://media.giphy.com/media/${ID}/giphy.gif?x=1`]) {
      await assert.rejects(fetchGif([bad], { fetch: f }), (e: unknown) => e instanceof GifFetchError && e.code === 'blocked-url');
    }
    assert.equal(calls, 0);
  });

  it('stops at the first suspicious answer instead of trying more renditions', async () => {
    let calls = 0;
    const f = fakeFetch(() => {
      calls += 1;
      return response(gifBytes(), { type: 'text/html' });
    });
    await assert.rejects(fetchGif(URLS, { fetch: f }));
    assert.equal(calls, 1);
  });

  it('reports a friendly error when every rendition is missing', async () => {
    const f = fakeFetch((url) => response('nope', { status: 404, url }));
    await assert.rejects(fetchGif(URLS, { fetch: f }), /no downloadable gif/);
  });

  it('turns a network failure into a clear error', async () => {
    const f = (() => Promise.reject(new TypeError('failed'))) as unknown as typeof fetch;
    await assert.rejects(fetchGif(URLS, { fetch: f }), (e: unknown) => e instanceof GifFetchError && e.code === 'network');
  });

  it('times out', async () => {
    const f = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    await assert.rejects(fetchGif(URLS, { fetch: f, timeoutMs: 20 }), (e: unknown) => e instanceof GifFetchError && e.code === 'timeout');
  });

  it('lets the caller cancel', async () => {
    const controller = new AbortController();
    const f = ((_: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const p = fetchGif(URLS, { fetch: f, signal: controller.signal });
    controller.abort();
    await assert.rejects(p, (e: unknown) => !(e instanceof GifFetchError));
  });
});

describe('looksLikeGif', () => {
  it('checks the magic bytes', () => {
    assert.equal(looksLikeGif(gifBytes()), true);
    assert.equal(looksLikeGif(new TextEncoder().encode('<html>hello world</html>')), false);
    assert.equal(looksLikeGif(new Uint8Array(3)), false);
  });
});
