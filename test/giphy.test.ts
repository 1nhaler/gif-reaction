import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAllowedMediaUrl, isValidGifId, mediaUrlsForId, parseGiphyInput } from '../src/shared/giphy';

const ID = '3o7TKSjRrfIPjeiVyM';

function ok(input: string) {
  const r = parseGiphyInput(input);
  assert.equal(r.ok, true, `expected ${input} to be accepted`);
  return r.ok ? r : (undefined as never);
}

function rejects(input: string, code?: string) {
  const r = parseGiphyInput(input);
  assert.equal(r.ok, false, `expected ${JSON.stringify(input)} to be rejected`);
  if (!r.ok && code) assert.equal(r.code, code);
}

describe('parseGiphyInput: accepted links', () => {
  it('page link with slug', () => {
    assert.equal(ok(`https://giphy.com/gifs/funny-cat-${ID}`).id, ID);
  });
  it('page link with www, trailing slash, query and hash', () => {
    assert.equal(ok(`https://www.giphy.com/gifs/funny-cat-${ID}/?x=1#y`).id, ID);
  });
  it('page link that is just the id', () => {
    assert.equal(ok(`https://giphy.com/gifs/${ID}`).id, ID);
  });
  it('sticker page link', () => {
    assert.equal(ok(`https://giphy.com/stickers/thumbs-up-${ID}`).id, ID);
  });
  it('embed link', () => {
    assert.equal(ok(`https://giphy.com/embed/${ID}`).id, ID);
  });
  it('classic media link', () => {
    assert.equal(ok(`https://media.giphy.com/media/${ID}/giphy.gif`).id, ID);
  });
  it('slugs with percent-encoded non-Latin text', () => {
    assert.equal(ok(`https://giphy.com/gifs/%E3%81%8B%E3%82%8F%E3%81%84%E3%81%84-${ID}`).id, ID);
  });
  it('numbered media host and the newer v1 path', () => {
    const url = `https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExbm=/${ID}/giphy.gif?cid=abc&ep=v1_gifs_search&rid=giphy.gif&ct=g`;
    assert.equal(ok(url).id, ID);
  });
  it('i.giphy.com links', () => {
    assert.equal(ok(`https://i.giphy.com/${ID}.gif`).id, ID);
    assert.equal(ok(`https://i.giphy.com/media/${ID}/giphy.webp`).id, ID);
  });
  it('mp4 media links resolve to the gif id', () => {
    assert.equal(ok(`https://media.giphy.com/media/${ID}/giphy.mp4`).id, ID);
  });
  it('uppercase scheme and host are normalised', () => {
    assert.equal(ok(`HTTPS://GIPHY.COM/gifs/x-${ID}`).id, ID);
  });
  it('explicit default port is accepted', () => {
    assert.equal(ok(`https://giphy.com:443/gifs/x-${ID}`).id, ID);
  });
  it('surrounding whitespace is trimmed', () => {
    assert.equal(ok(`  https://giphy.com/gifs/x-${ID}\n`).id, ID);
  });
});

describe('parseGiphyInput: the fetched URLs are rebuilt, never copied', () => {
  it('only ever produces media.giphy.com URLs built from the id', () => {
    const r = ok(`https://media3.giphy.com/media/v1.Y2lk=/${ID}/giphy.gif?cid=evil&redirect=https://evil.example`);
    for (const url of r.mediaUrls) {
      assert.match(url, new RegExp(`^https://media\\.giphy\\.com/media/${ID}/[a-z-]+\\.gif$`));
      assert.ok(!url.includes('evil'));
      assert.ok(isAllowedMediaUrl(url));
    }
  });
  it('mediaUrlsForId refuses a bad id', () => {
    assert.throws(() => mediaUrlsForId('../../etc/passwd'));
    assert.throws(() => mediaUrlsForId('a b c d e f'));
  });
});

describe('parseGiphyInput: rejected input', () => {
  it('empty and oversized', () => {
    rejects('', 'empty');
    rejects('   ', 'empty');
    rejects(`https://giphy.com/gifs/${'a'.repeat(2100)}`, 'too-long');
  });
  it('wrong schemes', () => {
    rejects(`http://giphy.com/gifs/x-${ID}`, 'not-https');
    rejects('javascript:alert(1)', 'not-https');
    rejects('data:text/html,<script>alert(1)</script>', 'not-https');
    rejects('data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'not-https');
    rejects('blob:https://giphy.com/1234', 'not-https');
    rejects('file:///etc/passwd', 'not-https');
    rejects('ftp://giphy.com/x', 'not-https');
  });
  it('missing scheme', () => {
    rejects(`giphy.com/gifs/x-${ID}`, 'invalid-url');
    rejects(`//giphy.com/gifs/x-${ID}`, 'invalid-url');
  });
  it('embedded credentials', () => {
    rejects(`https://user:pass@giphy.com/gifs/x-${ID}`, 'credentials');
    rejects(`https://giphy.com@evil.example/gifs/x-${ID}`, 'credentials');
    rejects(`https://giphy.com:pass@evil.example/gifs/x-${ID}`, 'credentials');
  });
  it('custom ports', () => {
    rejects(`https://giphy.com:8443/gifs/x-${ID}`, 'port');
    rejects(`https://media.giphy.com:444/media/${ID}/giphy.gif`, 'port');
  });
  it('lookalike and foreign hosts', () => {
    rejects(`https://giphy.com.evil.example/gifs/x-${ID}`, 'host-not-allowed');
    rejects(`https://evilgiphy.com/gifs/x-${ID}`, 'host-not-allowed');
    rejects(`https://giphy.co/gifs/x-${ID}`, 'host-not-allowed');
    rejects(`https://notgiphy.com/gifs/x-${ID}`, 'host-not-allowed');
    rejects(`https://giphy.com./gifs/x-${ID}`, 'host-not-allowed');
    rejects(`https://sub.giphy.com/gifs/x-${ID}`, 'host-not-allowed');
    rejects(`https://media.giphy.com.evil.example/media/${ID}/giphy.gif`, 'host-not-allowed');
    rejects(`https://media12.giphy.com/media/${ID}/giphy.gif`, 'host-not-allowed');
    rejects('https://tenor.com/view/x-123456', 'host-not-allowed');
    rejects('https://gph.is/abc123', 'host-not-allowed');
  });
  it('IP address hosts', () => {
    rejects(`https://127.0.0.1/gifs/x-${ID}`, 'host-not-allowed');
    rejects(`https://[::1]/gifs/x-${ID}`, 'host-not-allowed');
    rejects(`https://2130706433/gifs/x-${ID}`, 'host-not-allowed');
  });
  it('non-ASCII lookalikes and invisible characters', () => {
    rejects(`https://giphy.cоm/gifs/x-${ID}`, 'bad-characters');
    rejects(`https://giphy․com/gifs/x-${ID}`, 'bad-characters');
    rejects(`https://giphy.com/gifs/x-${ID}‮`, 'bad-characters');
    rejects(`https://giphy.com/gifs/x-${ID}​`, 'bad-characters');
    rejects(`https://giphy.com/gifs/x-${ID}\u0000`, 'bad-characters');
  });
  it('whitespace inside the link', () => {
    rejects(`https://giphy.com/gifs/x ${ID}`, 'bad-characters');
    rejects(`https://giphy.com/gifs/x\n${ID}`, 'bad-characters');
    rejects(`https://giphy.com/gifs/x-${ID} https://evil.example`, 'bad-characters');
  });
  it('markup and script injection in the id or slug', () => {
    rejects(`https://giphy.com/gifs/x-<script>alert(1)</script>`);
    rejects(`https://giphy.com/gifs/x-"onerror="alert(1)`);
    rejects(`https://giphy.com/gifs/x-';DROP`);
    rejects(`https://giphy.com/gifs/x-${ID}'"><img src=x onerror=alert(1)>`);
    rejects(`https://media.giphy.com/media/${ID}"><svg/onload=alert(1)>/giphy.gif`);
    rejects(`https://giphy.com/gifs/x-$(whoami)`);
  });
  it('path traversal and encoded tricks', () => {
    rejects(`https://giphy.com/gifs/../../x-${ID}`);
    rejects(`https://media.giphy.com/media/../${ID}/giphy.gif`);
    rejects(`https://media.giphy.com/media/${ID}/../../evil.gif`);
    rejects(`https://media.giphy.com/media/%2e%2e/${ID}/giphy.gif`);
    rejects(`https://media.giphy.com/media/${ID}%2f..%2f..%2fx/giphy.gif`);
    rejects(`https://giphy.com/gifs/..%2f..%2fx-${ID}`);
    rejects(`https://giphy.com/gifs/%2e%2e%2fx-${ID}`);
    rejects(`https://giphy.com/gifs/x%5cy-${ID}`);
    rejects(`https://media.giphy.com/media/${ID}/..gif`);
  });
  it('wrong paths on allowed hosts', () => {
    rejects('https://giphy.com/', 'unsupported-link');
    rejects('https://giphy.com/search/cats', 'unsupported-link');
    rejects(`https://giphy.com/clips/x-${ID}`, 'unsupported-link');
    rejects(`https://media.giphy.com/${ID}.gif`, 'unsupported-link');
    rejects(`https://giphy.com/gifs/x-${ID}/extra/segments`, 'unsupported-link');
  });
  it('ids that are too short or too long', () => {
    rejects('https://giphy.com/gifs/cat-abc12', 'unsupported-link');
    rejects(`https://giphy.com/gifs/cat-${'a'.repeat(40)}`, 'unsupported-link');
    rejects(`https://media.giphy.com/media/${'a'.repeat(40)}/giphy.gif`, 'bad-id');
  });
  it('a redirect parameter cannot smuggle another host', () => {
    const r = ok(`https://giphy.com/gifs/x-${ID}?url=https://evil.example/payload.gif`);
    for (const u of r.mediaUrls) assert.ok(!u.includes('evil'));
  });
});

describe('isAllowedMediaUrl', () => {
  const good = `https://media.giphy.com/media/${ID}/giphy.gif`;
  it('accepts the shapes we build', () => {
    assert.equal(isAllowedMediaUrl(good), true);
    assert.equal(isAllowedMediaUrl(`https://media2.giphy.com/media/${ID}/giphy-downsized.gif`), true);
    assert.equal(isAllowedMediaUrl(`https://i.giphy.com/${ID}.gif`), true);
  });
  it('rejects everything else', () => {
    assert.equal(isAllowedMediaUrl(`http://media.giphy.com/media/${ID}/giphy.gif`), false);
    assert.equal(isAllowedMediaUrl(`${good}?x=1`), false);
    assert.equal(isAllowedMediaUrl(`${good}#x`), false);
    assert.equal(isAllowedMediaUrl(`https://giphy.com/gifs/x-${ID}`), false);
    assert.equal(isAllowedMediaUrl(`https://evil.example/media/${ID}/giphy.gif`), false);
    assert.equal(isAllowedMediaUrl(`https://user@media.giphy.com/media/${ID}/giphy.gif`), false);
    assert.equal(isAllowedMediaUrl(`https://media.giphy.com:8443/media/${ID}/giphy.gif`), false);
    assert.equal(isAllowedMediaUrl('not a url'), false);
    assert.equal(isAllowedMediaUrl(''), false);
  });
});

describe('isValidGifId', () => {
  it('validates ids read from storage or messages', () => {
    assert.equal(isValidGifId(ID), true);
    assert.equal(isValidGifId('short'), false);
    assert.equal(isValidGifId('has-dash-abcdefgh'), false);
    assert.equal(isValidGifId(123456789), false);
    assert.equal(isValidGifId(undefined), false);
    assert.equal(isValidGifId('__proto__'), false);
  });
});
