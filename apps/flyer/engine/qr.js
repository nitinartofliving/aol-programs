'use strict';
// Genuine QR Code encoder (byte mode, versions 1-10, error correction M) and a
// pixel-sampling decoder used to verify the EXPORTED flyer, not the encoder's own matrix.

// ---- Galois field GF(256), primitive polynomial 0x11D ----
const EXP = new Array(512), LOG = new Array(256);
(function () { let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; })();
const gmul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
function rsGenerator(deg) { let g = [1]; for (let i = 0; i < deg; i++) { const n = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { n[j] ^= g[j]; n[j + 1] ^= gmul(g[j], EXP[i]); } g = n; } return g; }
function rsRemainder(data, deg) { const g = rsGenerator(deg), r = new Array(deg).fill(0); for (const b of data) { const f = b ^ r.shift(); r.push(0); if (f) for (let i = 0; i < deg; i++) r[i] ^= gmul(g[i + 1], f); } return r; }

// Level M block structure: [ecc per block, [blocks, data per block], [blocks, data per block]]
const BLOCKS = { 1: [10, [1, 16], [0, 0]], 2: [16, [1, 28], [0, 0]], 3: [26, [1, 44], [0, 0]], 4: [18, [2, 32], [0, 0]], 5: [24, [2, 43], [0, 0]], 6: [16, [4, 27], [0, 0]], 7: [18, [4, 31], [0, 0]], 8: [22, [2, 38], [2, 39]], 9: [22, [3, 36], [2, 37]], 10: [26, [4, 43], [1, 44]] };
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const dataCodewords = v => BLOCKS[v][1][0] * BLOCKS[v][1][1] + BLOCKS[v][2][0] * BLOCKS[v][2][1];
const byteCapacity = v => Math.floor((dataCodewords(v) * 8 - 4 - (v < 10 ? 8 : 16)) / 8);
const MAX_BYTES = byteCapacity(10);
const bit = (x, i) => ((x >>> i) & 1) === 1;

function functionMap(version) {
  const size = 17 + 4 * version, fn = Array.from({ length: size }, () => new Array(size).fill(false)), mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, d) => { if (x >= 0 && y >= 0 && x < size && y < size) { mod[y][x] = d; fn[y][x] = true; } };
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = ALIGN[version];
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // reserve format areas (values written later)
  for (let i = 0; i < 9; i++) { if (i !== 6) { set(8, i, false); set(i, 8, false); } }
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, false); set(8, size - 1 - i, false); }
  set(8, size - 8, true);
  if (version >= 7) { for (let i = 0; i < 18; i++) { const a = size - 11 + (i % 3), b = Math.floor(i / 3); set(a, b, false); set(b, a, false); } }
  return { size, fn, mod };
}
function writeFormat(mod, fn, size, mask) {
  const data = (0 << 3) | mask; // level M = 00
  let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const s = (x, y, d) => { mod[y][x] = d; fn[y][x] = true; };
  for (let i = 0; i <= 5; i++) s(8, i, bit(bits, i));
  s(8, 7, bit(bits, 6)); s(8, 8, bit(bits, 7)); s(7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i++) s(14 - i, 8, bit(bits, i));
  for (let i = 0; i < 8; i++) s(size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i++) s(8, size - 15 + i, bit(bits, i));
  s(8, size - 8, true);
}
function writeVersion(mod, size, version) {
  if (version < 7) return;
  let rem = version; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) { const c = bit(bits, i), a = size - 11 + (i % 3), b = Math.floor(i / 3); mod[b][a] = c; mod[a][b] = c; }
}
const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0, (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];

function penalty(m) {
  const n = m.length; let p = 0;
  const runs = line => { let s = 0, run = 1; for (let i = 1; i < n; i++) { if (line[i] === line[i - 1]) run++; else { if (run >= 5) s += 3 + run - 5; run = 1; } } if (run >= 5) s += 3 + run - 5; return s; };
  const pat = line => { const str = line.map(b => (b ? 1 : 0)).join(''); let s = 0; for (const re of ['10111010000', '00001011101']) { let i = -1; while ((i = str.indexOf(re, i + 1)) !== -1) s += 40; } return s; };
  for (let y = 0; y < n; y++) { p += runs(m[y]) + pat(m[y]); }
  for (let x = 0; x < n; x++) { const col = m.map(r => r[x]); p += runs(col) + pat(col); }
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
  let dark = 0; for (const r of m) for (const c of r) if (c) dark++;
  p += Math.floor(Math.abs((dark * 20) / (n * n) - 10)) * 10;
  return p;
}

function encodeQR(text, forceMask) {
  const bytes = Buffer.from(String(text), 'utf8');
  let version = 0; for (let v = 1; v <= 10; v++) if (bytes.length <= byteCapacity(v)) { version = v; break; }
  if (!version) throw new Error('Content too long for the supported QR range (' + bytes.length + ' bytes, max ' + MAX_BYTES + ')');
  const cap = dataCodewords(version) * 8, bits = [];
  const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  push(0b0100, 4); push(bytes.length, version < 10 ? 8 : 16); for (const b of bytes) push(b, 8);
  push(0, Math.min(4, cap - bits.length)); while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; data.push(b); }
  const [ecc, g1, g2] = BLOCKS[version], blocks = []; let off = 0;
  for (const [cnt, len] of [g1, g2]) for (let i = 0; i < cnt; i++) { const d = data.slice(off, off + len); off += len; blocks.push({ d, e: rsRemainder(d, ecc) }); }
  const out = []; const maxLen = Math.max(...blocks.map(b => b.d.length));
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecc; i++) for (const b of blocks) out.push(b.e[i]);
  const { size, fn, mod } = functionMap(version);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (!fn[y][x] && i < out.length * 8) { mod[y][x] = bit(out[i >>> 3], 7 - (i & 7)); i++; }
    }
  }
  let best = null, bestP = Infinity, bestMask = 0;
  for (let mask = 0; mask < 8; mask++) {
    if (forceMask !== undefined && mask !== forceMask) continue;
    const m = mod.map(r => r.slice()), f = fn.map(r => r.slice());
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!f[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
    writeFormat(m, f, size, mask); writeVersion(m, size, version);
    const p = penalty(m); if (p < bestP) { bestP = p; best = m; bestMask = mask; }
  }
  return { version, size, mask: bestMask, bytes: bytes.length, modules: best.map(r => r.map(c => (c ? 1 : 0))) };
}

// Choose an integer module scale so the symbol plus quiet zone is roughly 220 px.
function qrLayout(size) { const quiet = 4, scale = Math.max(5, Math.round(220 / (size + 2 * quiet))); return { quiet, scale, px: (size + 2 * quiet) * scale }; }

// ---------------- Decoder (samples pixels of the exported artifact) ----------------
// luma(x,y) -> 0..255. box = {x,y,w} square region including the quiet zone.
function decodeQRFromLuma(luma, box) {
  let version = 0, scale = 0;
  for (let v = 1; v <= 10; v++) { const total = 17 + 4 * v + 8; if (box.w % total === 0) { version = v; scale = box.w / total; break; } }
  if (!version) return { ok: false, error: 'region size does not match any supported symbol size' };
  const size = 17 + 4 * version, quiet = 4;
  const m = Array.from({ length: size }, (_, r) => Array.from({ length: size }, (_, c) => {
    let sum = 0, k = 0; const cx = box.x + (quiet + c) * scale, cy = box.y + (quiet + r) * scale;
    for (let dy = 1; dy < scale - 1 || (scale <= 2 && dy < scale); dy++) for (let dx = 1; dx < scale - 1 || (scale <= 2 && dx < scale); dx++) { sum += luma(cx + dx, cy + dy); k++; }
    return sum / Math.max(1, k) < 128;
  }));
  // quiet zone must be light
  let qzDark = 0, qzN = 0; for (let y = 0; y < box.w; y += 2) for (let x = 0; x < box.w; x += 2) { const inQuiet = x < quiet * scale || y < quiet * scale || x >= (size + quiet) * scale || y >= (size + quiet) * scale; if (inQuiet) { qzN++; if (luma(box.x + x, box.y + y) < 128) qzDark++; } }
  if (qzDark / qzN > 0.002) return { ok: false, error: 'quiet zone is not clear (' + qzDark + ' dark samples)' };
  // format info (first copy), then second copy cross-check
  const readBits = pts => pts.reduce((a, [x, y], i) => a | ((m[y][x] ? 1 : 0) << i), 0);
  const f1 = readBits([[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]]);
  const f2pts = []; for (let i = 0; i < 8; i++) f2pts.push([size - 1 - i, 8]); for (let i = 8; i < 15; i++) f2pts.push([8, size - 15 + i]);
  const f2 = readBits(f2pts);
  const valid = []; for (let d = 0; d < 32; d++) { let rem = d; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); valid.push([(((d << 10) | rem) ^ 0x5412), d]); }
  const pop = x => { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; };
  const pick = f => valid.map(([code, d]) => [pop(code ^ f), d]).sort((a, b) => a[0] - b[0])[0];
  const a = pick(f1), b = pick(f2), chosen = a[0] <= b[0] ? a : b;
  if (chosen[0] > 3) return { ok: false, error: 'format information unreadable' };
  const level = chosen[1] >> 3, mask = chosen[1] & 7;
  if (level !== 0) return { ok: false, error: 'unexpected error correction level bits ' + level };
  const { fn } = functionMap(version);
  const words = []; let cur = 0, nb = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (fn[y][x]) continue;
      let v = m[y][x]; if (MASKS[mask](x, y)) v = !v;
      cur = (cur << 1) | (v ? 1 : 0); nb++; if (nb === 8) { words.push(cur); cur = 0; nb = 0; }
    }
  }
  const [ecc, g1, g2] = BLOCKS[version], lens = []; for (const [cnt, len] of [g1, g2]) for (let i = 0; i < cnt; i++) lens.push(len);
  const nblk = lens.length, blocks = lens.map(() => ({ d: [], e: [] })); let p = 0;
  const maxLen = Math.max(...lens);
  for (let i = 0; i < maxLen; i++) for (let k = 0; k < nblk; k++) if (i < lens[k]) blocks[k].d.push(words[p++]);
  for (let i = 0; i < ecc; i++) for (let k = 0; k < nblk; k++) blocks[k].e.push(words[p++]);
  for (const bl of blocks) { const re = rsRemainder(bl.d, ecc); if (re.some((v, i) => v !== bl.e[i])) return { ok: false, error: 'error correction check failed' }; }
  const data = blocks.flatMap(b => b.d), bits = []; for (const w of data) for (let i = 7; i >= 0; i--) bits.push((w >> i) & 1);
  let q = 0; const take = n => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | bits[q++]; return v; };
  const mode = take(4); if (mode !== 4) return { ok: false, error: 'not byte mode (' + mode + ')' };
  const count = take(version < 10 ? 8 : 16), out = []; for (let i = 0; i < count; i++) out.push(take(8));
  return { ok: true, text: Buffer.from(out).toString('utf8'), version, scale, mask };
}

module.exports = { encodeQR, decodeQRFromLuma, qrLayout, MAX_BYTES, functionMap };
