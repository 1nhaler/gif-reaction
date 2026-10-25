import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultRegistry, isAllowedMediaUrl, parseGifInput } from '../src/shared/gif-source';
import { TenorSource } from '../src/shared/tenor';

describe('TenorSource & defaultRegistry', () => {
  it('has Tenor registered first before Giphy', () => {
    const sources = defaultRegistry.getSources();
    assert.equal(sources.length, 2);
    assert.equal(sources[0]?.name, 'tenor');
    assert.equal(sources[1]?.name, 'giphy');
  });

  describe('direct media links', () => {
    it('accepts standard media.tenor.com gif link', () => {
      const url = 'https://media.tenor.com/hWOSRbk_fiQAAAAC/one-two-look-305.gif';
      const r = parseGifInput(url);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.id, 'hWOSRbk_fiQ');
      assert.ok(r.mediaUrls.length >= 2);
      assert.ok(r.mediaUrls.some((u) => u.includes('AAAAM')));
      assert.ok(r.mediaUrls.some((u) => u.includes('AAAAC')));
    });

    it('accepts media.tenor.com mp4 link and maps to gif renditions', () => {
      const url = 'https://media.tenor.com/hWOSRbk_fiQAAAPo/one-two-look-305.mp4';
      const r = parseGifInput(url);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.id, 'hWOSRbk_fiQ');
      assert.ok(r.mediaUrls.every((u) => u.endsWith('.gif')));
    });

    it('accepts media1.tenor.com with /m/ path', () => {
      const url = 'https://media1.tenor.com/m/I6j5DmlTTk0AAAAC/stare.gif';
      const r = parseGifInput(url);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.id, 'I6j5DmlTTk0');
      assert.ok(r.mediaUrls.some((u) => u.includes('/m/I6j5DmlTTk0AAAAM/stare.gif')));
    });

    it('accepts c.tenor.com host', () => {
      const url = 'https://c.tenor.com/I6j5DmlTTk0AAAAC/stare.gif';
      const r = parseGifInput(url);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.id, 'I6j5DmlTTk0');
    });
  });

  describe('tenor.com/view page links', () => {
    it('parses slug and extracts id', () => {
      const url = 'https://tenor.com/view/stare-gif-2569577427706793549';
      const r = parseGifInput(url);
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.id, '2569577427706793549');
      assert.equal(typeof r.resolve, 'function');
    });

    it('resolve extracts media link from og:image', async () => {
      const originalFetch = globalThis.fetch;
      const fakeHtml = `
        <!DOCTYPE html><html><head>
          <meta property="og:image" content="https://media1.tenor.com/m/I6j5DmlTTk0AAAAC/stare.gif">
        </head><body></body></html>
      `;
      globalThis.fetch = (async () => new Response(fakeHtml, { status: 200 })) as typeof fetch;
      try {
        const r = parseGifInput('https://tenor.com/view/stare-gif-2569577427706793549');
        assert.equal(r.ok, true);
        if (!r.ok || !r.resolve) return;
        const urls = await r.resolve();
        assert.ok(urls.length > 0);
        assert.ok(urls.some((u) => u.includes('I6j5DmlTTk0')));
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('Giphy fallback through registry', () => {
    it('still parses Giphy links via the registry', () => {
      const r = parseGifInput('https://giphy.com/gifs/funny-cat-3o7TKSjRrfIPjeiVyM');
      assert.equal(r.ok, true);
      if (!r.ok) return;
      assert.equal(r.id, '3o7TKSjRrfIPjeiVyM');
    });
  });

  describe('isAllowedMediaUrl allowlist', () => {
    it('allows valid Tenor media URLs', () => {
      assert.equal(isAllowedMediaUrl('https://media.tenor.com/hWOSRbk_fiQAAAAC/one-two-look-305.gif'), true);
      assert.equal(isAllowedMediaUrl('https://media1.tenor.com/m/I6j5DmlTTk0AAAAC/stare.gif'), true);
      assert.equal(isAllowedMediaUrl('https://c.tenor.com/I6j5DmlTTk0AAAAC/stare.gif'), true);
    });

    it('allows valid Giphy media URLs', () => {
      assert.equal(isAllowedMediaUrl('https://media.giphy.com/media/3o7TKSjRrfIPjeiVyM/giphy.gif'), true);
    });

    it('rejects URLs with query or hash', () => {
      assert.equal(isAllowedMediaUrl('https://media.tenor.com/hWOSRbk_fiQAAAAC/one-two-look-305.gif?foo=bar'), false);
      assert.equal(isAllowedMediaUrl('https://media.tenor.com/hWOSRbk_fiQAAAAC/one-two-look-305.gif#hash'), false);
    });

    it('rejects unallowed hosts', () => {
      assert.equal(isAllowedMediaUrl('https://evil.example.com/stare.gif'), false);
      assert.equal(isAllowedMediaUrl('https://tenor.com.evil.com/stare.gif'), false);
    });
  });
});
