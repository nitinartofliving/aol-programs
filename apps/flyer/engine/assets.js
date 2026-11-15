'use strict';
const fs = require('fs'), path = require('path');
const { decodePNG, imageInfo } = require('./png');
const ROOT = path.join(__dirname, '..');
const EXT = /\.(png|jpe?g|webp|svg)$/i, FONT = /\.(ttf|otf|woff2?)$/i;

function relFromBuffer(buf, info, name) {
  // Mean luminance of visible pixels (PNG only); otherwise infer from filename hints.
  if (info.type === 'png') {
    try {
      const im = decodePNG(buf); let sum = 0, n = 0; const step = Math.max(1, Math.floor(Math.max(im.width, im.height) / 120));
      for (let y = 0; y < im.height; y += step) for (let x = 0; x < im.width; x += step) { if (im.alpha(x, y) > 128) { const [r, g, b] = im.rgb(x, y); sum += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; n++; } }
      if (n) return { lum: +(sum / n).toFixed(3), method: 'mean luminance of visible pixels' };
    } catch (e) { /* fall through */ }
  }
  if (/white|light|reverse|negative/i.test(name)) return { lum: 1, method: 'filename hint' };
  if (/dark|black|colou?r|primary/i.test(name)) return { lum: 0.2, method: 'filename hint' };
  return { lum: null, method: 'unknown' };
}
function scanDir(cat, dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!EXT.test(f)) continue;
    const fp = path.join(dir, f), buf = fs.readFileSync(fp), info = imageInfo(buf, f);
    const item = { id: cat + ':' + f, category: cat, filename: f, url: 'assets/' + (cat === 'logo' ? 'logos' : 'gurudev') + '/' + encodeURIComponent(f), bytes: buf.length, type: info.type, width: info.width, height: info.height, aspect: info.width && info.height ? +(info.width / info.height).toFixed(3) : null, transparency: info.transparency, usable: !!(info.type && info.width && info.height) };
    if (cat === 'logo') Object.assign(item, relFromBuffer(buf, info, f));
    out.push(item);
  }
  return out;
}
function inventory() {
  const logos = scanDir('logo', path.join(ROOT, 'assets', 'logos')), gurudev = scanDir('gurudev', path.join(ROOT, 'assets', 'gurudev'));
  const fontsDir = path.join(ROOT, 'assets', 'brand', 'fonts');
  const fonts = fs.existsSync(fontsDir) ? fs.readdirSync(fontsDir).filter(f => FONT.test(f)).map(f => ({ id: 'font:' + f, filename: f, url: 'assets/brand/fonts/' + encodeURIComponent(f) })) : [];
  return { logos, gurudev, fonts };
}
function approved(list, ids) { return ids && ids.length ? list.filter(a => ids.includes(a.id)) : list; }
function selectLogo(inv, cfg) {
  const c = approved(inv.logos, cfg.approved_logo_asset_ids).filter(a => a.usable);
  const suitable = c.filter(a => a.lum === null || a.lum < 0.85).sort((a, b) => (b.width * b.height) - (a.width * a.height));
  return { chosen: suitable[0] || null, considered: c.length, rejectedLightOnly: c.length > 0 && suitable.length === 0 };
}
function selectPortrait(inv, cfg) {
  const c = approved(inv.gurudev, cfg.approved_gurudev_asset_ids).filter(a => a.usable);
  const scored = c.map(a => { const long = Math.max(a.width, a.height), ar = a.width / a.height; let s = Math.min(long, 2400) / 24; s += ar >= 0.6 && ar <= 1.0 ? 100 : ar > 1.0 && ar <= 1.4 ? 40 : 0; return { a, s }; }).sort((x, y) => y.s - x.s);
  const chosen = scored[0] ? scored[0].a : null;
  return { chosen, considered: c.length, lowRes: chosen ? Math.max(chosen.width, chosen.height) < 800 : false, tooLow: chosen ? Math.max(chosen.width, chosen.height) < 500 : false };
}
function cityAsset(id) {
  if (!id || !/^city:[\w.-]+$/.test(id)) return null;
  const f = id.slice(5), fp = path.join(ROOT, 'uploads', 'city', f);
  if (!fp.startsWith(path.join(ROOT, 'uploads', 'city')) || !fs.existsSync(fp)) return null;
  const buf = fs.readFileSync(fp), info = imageInfo(buf, f);
  return { id, category: 'city_upload', filename: f, url: 'uploads/city/' + encodeURIComponent(f), bytes: buf.length, type: info.type, width: info.width, height: info.height, usable: !!(info.type && info.width && info.height), user_uploaded: true };
}
module.exports = { inventory, selectLogo, selectPortrait, cityAsset, ROOT };
