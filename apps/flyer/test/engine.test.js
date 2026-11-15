// Zero-dependency checks for the host engine. Run: npm test
const assert = require('assert');
const { encodeQR, decodeQRFromLuma, qrLayout } = require('../engine/qr');
const U = require('../engine/util');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok  ' + name); };

t('QR round trip for several payload sizes', () => {
  for (const url of ['https://example.org/a', 'https://example.org/register?course=calm-breathing&city=halifax', 'https://example.org/' + 'x'.repeat(120)]) {
    const q = encodeQR(url), L = qrLayout(q.size), W = L.px, tot = q.size + 2 * L.quiet;
    const luma = (x, y) => { const c = Math.floor(x / L.scale) - L.quiet, r = Math.floor(y / L.scale) - L.quiet; return c >= 0 && r >= 0 && c < q.size && r < q.size && q.modules[r][c] ? 0 : 255; };
    const out = decodeQRFromLuma(luma, { x: 0, y: 0, w: W });
    assert.ok(out.ok, out.error); assert.strictEqual(out.text, url);
  }
});
t('contrast ratio of black on white is 21', () => assert.ok(Math.abs(U.contrast([0, 0, 0], [255, 255, 255]) - 21) < 0.01));
t('time range formatting', () => assert.strictEqual(U.fmtRange(U.parseTime('19:00'), U.parseTime('21:00')), '7:00 to 9:00 p.m.'));
console.log(n + ' tests passed');
