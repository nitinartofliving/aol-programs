'use strict';
// Minimal PNG decoder (8-bit, non-interlaced, color types 0/2/4/6) using Node's zlib.
const zlib = require('zlib');
function decodePNG(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 33 || sig.some((b, i) => buf[i] !== b)) throw new Error('not a PNG file');
  let p = 8, ihdr = null; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], ctype: data[9], interlace: data[12] };
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (!ihdr) throw new Error('missing IHDR');
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) throw new Error('unsupported PNG variant (need 8-bit, non-interlaced)');
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.ctype]; if (!ch) throw new Error('unsupported colour type');
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = ihdr.w * ch, out = Buffer.alloc(stride * ihdr.h);
  for (let y = 0; y < ihdr.h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[dst + x - ch] : 0, b = y > 0 ? out[dst - stride + x] : 0, c = x >= ch && y > 0 ? out[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[dst + x] = v & 255;
    }
  }
  const rgb = (x, y) => { const i = y * stride + x * ch; if (ch === 1 || ch === 2) return [out[i], out[i], out[i]]; return [out[i], out[i + 1], out[i + 2]]; };
  const alpha = (x, y) => (ch === 4 ? out[y * stride + x * 4 + 3] : ch === 2 ? out[y * stride + x * 2 + 1] : 255);
  return { width: ihdr.w, height: ihdr.h, rgb, alpha, luma: (x, y) => { const [r, g, b] = rgb(x, y); return 0.2126 * r + 0.7152 * g + 0.0722 * b; } };
}
// Dimensions from file headers (PNG, JPEG, SVG, WebP basic) for inventory.
function imageInfo(buf, name) {
  try {
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), transparency: [4, 6].includes(buf[25]) };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let p = 2; while (p < buf.length) { if (buf[p] !== 0xff) { p++; continue; } const m = buf[p + 1]; if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { type: 'jpeg', height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7), transparency: false }; p += 2 + buf.readUInt16BE(p + 2); }
    }
    const head = buf.toString('utf8', 0, Math.min(buf.length, 2000));
    if (/<svg/i.test(head)) { const vb = head.match(/viewBox="[\s,]*([\d.\-]+)[\s,]+([\d.\-]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/); const w = head.match(/\swidth="([\d.]+)/), h = head.match(/\sheight="([\d.]+)/); return { type: 'svg', width: vb ? +vb[3] : w ? +w[1] : null, height: vb ? +vb[4] : h ? +h[1] : null, transparency: true }; }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') { if (buf.toString('ascii', 12, 16) === 'VP8X') return { type: 'webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3), transparency: true }; return { type: 'webp', width: null, height: null, transparency: null }; }
  } catch (e) { /* fall through */ }
  return { type: null, width: null, height: null, transparency: null };
}
module.exports = { decodePNG, imageInfo };
