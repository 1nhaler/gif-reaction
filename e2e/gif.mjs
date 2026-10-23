// A tiny GIF89a encoder, enough to make test gifs made of solid-colour frames.

function lzwEncode(minCodeSize, indices) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;
  let table = new Map();
  const bytes = [];
  let cur = 0;
  let curShift = 0;

  const emit = (code) => {
    cur |= code << curShift;
    curShift += codeSize;
    while (curShift >= 8) {
      bytes.push(cur & 0xff);
      cur >>>= 8;
      curShift -= 8;
    }
  };

  emit(clearCode);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i += 1) {
    const k = indices[i];
    const key = (prefix << 8) | k;
    const found = table.get(key);
    if (found === undefined) {
      emit(prefix);
      if (nextCode === 4096) {
        emit(clearCode);
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
        table = new Map();
      } else {
        if (nextCode >= 1 << codeSize) codeSize += 1;
        table.set(key, nextCode);
        nextCode += 1;
      }
      prefix = k;
    } else {
      prefix = found;
    }
  }
  emit(prefix);
  emit(eoiCode);
  if (curShift > 0) bytes.push(cur & 0xff);
  return bytes;
}

/** frames: [{ color: [r, g, b], delayMs }], at most 4 distinct colours. */
export function encodeGif({ width, height, frames }) {
  const palette = [];
  for (const f of frames) {
    if (!palette.some((c) => c.join() === f.color.join())) palette.push(f.color);
  }
  if (palette.length > 4) throw new Error('At most 4 colours');
  while (palette.length < 4) palette.push([0, 0, 0]);

  const out = [];
  const word = (n) => out.push(n & 0xff, (n >> 8) & 0xff);
  out.push(...Buffer.from('GIF89a'));
  word(width);
  word(height);
  out.push(0x80 | 0x70 | 0x01, 0, 0); // global colour table, 4 entries
  for (const c of palette) out.push(...c);
  out.push(0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0'), 0x03, 0x01, 0x00, 0x00, 0x00); // loop forever

  for (const f of frames) {
    out.push(0x21, 0xf9, 0x04, 0x04); // graphic control, dispose: leave in place
    word(Math.round(f.delayMs / 10));
    out.push(0x00, 0x00);
    out.push(0x2c);
    word(0);
    word(0);
    word(width);
    word(height);
    out.push(0x00);
    const index = palette.findIndex((c) => c.join() === f.color.join());
    const data = lzwEncode(2, new Array(width * height).fill(index));
    out.push(2);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.slice(i, i + 255);
      out.push(block.length, ...block);
    }
    out.push(0x00);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}
