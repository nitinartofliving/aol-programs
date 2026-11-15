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
t('local event QR exception is restricted to fictional loopback demo events', () => {
  const good = { enabled: true, remoteAddress: '127.0.0.1', localPort: 3001, host: '127.0.0.1:3001',
    getEvent: slug => slug === 'sample' ? { status: 'open', registration_url: 'https://example.org/course' } : null };
  const link = 'http://127.0.0.1:3001/e/sample';
  assert.ok(U.localDemoEvent(link, good));
  assert.ok(!U.localDemoEvent(link, { ...good, enabled: false }));
  assert.ok(!U.localDemoEvent(link, { ...good, remoteAddress: '192.168.1.2' }));
  assert.ok(!U.localDemoEvent(link, { ...good, localPort: 3002 }));
  assert.ok(!U.localDemoEvent(link, { ...good, host: 'example.org' }));
  assert.ok(!U.localDemoEvent('http://127.0.0.1:3001/e/sample#other', good));
  assert.ok(!U.localDemoEvent(link + '?x=1', good));
  assert.ok(!U.localDemoEvent('http://127.0.0.1:3001/e/missing', good));
  assert.ok(!U.localDemoEvent(link, { ...good, getEvent: () => ({ status: 'open', registration_url: 'https://real.example/course' }) }));
  assert.ok(!U.localDemoEvent(link, { ...good, getEvent: () => ({ status: 'closed', registration_url: 'https://example.org/course' }) }));
});
async function testLocalEventJob() {
  const fs = require('fs'), os = require('os'), path = require('path');
  const cfg = require('../config/admin-config.json');
  if (cfg.execution_profile !== 'demo') {
    console.log('skip  local event job requires the demo profile');
    return;
  }
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aol-flyer-test-'));
  const old = { DATA_DIR: process.env.DATA_DIR, HOST: process.env.HOST, AOL_CARE_DEMO: process.env.AOL_CARE_DEMO };
  try {
    process.env.DATA_DIR = data;
    process.env.HOST = '127.0.0.1';
    process.env.AOL_CARE_DEMO = '0';
    const { createJob } = require('../server');
    const fixture = structuredClone(require('../config/demo-fixture.json'));
    fixture.schedule.sessions = [{ date: `${new Date().getUTCFullYear() + 1}-12-04`, start_time: '19:00', end_time: '21:00' }];
    fixture.action.destination_url = 'http://127.0.0.1:3001/e/sample';
    const req = { socket: { remoteAddress: '127.0.0.1', localPort: 3001 }, headers: { host: '127.0.0.1:3001' },
      demoEventBySlug: slug => slug === 'sample' ? { status: 'open', registration_url: 'https://example.org/course' } : null };
    const job = await createJob(fixture, req);
    assert.strictEqual(job.status, 'PLANNING');
    assert.strictEqual(job.plan.qr.url, fixture.action.destination_url);
    process.env.HOST = '0.0.0.0';
    const blocked = await createJob(fixture, req);
    assert.strictEqual(blocked.status, 'NEEDS_INPUT');
    assert.ok(blocked.plan.questions.some(q => q.field === 'action.destination_url'));
    n++;
    console.log('ok  local event jobs work with regular People storage only on a loopback host');
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(data, { recursive: true, force: true });
  }
}
testLocalEventJob().then(() => console.log(n + ' tests passed')).catch(error => { console.error(error); process.exitCode = 1; });
