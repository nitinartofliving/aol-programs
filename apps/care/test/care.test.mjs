import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { findAnswer, similarity } from '../match.mjs';
import { createCareApp, qrSvg } from '../server.mjs';
import { addDays, normalizePhone } from '../store.mjs';
import { demoKnowledge } from '../catalog.mjs';

const manager = 'm'.repeat(40);
const volunteer = 'v'.repeat(40);

async function start(env = {}, now = () => Date.parse('2026-11-15T18:00:00Z')) {
  const app = createCareApp({ env: { AOL_CARE_DB_PATH: ':memory:', AOL_MANAGER_TOKEN: manager, AOL_VOLUNTEER_TOKEN: volunteer, AOL_TIME_ZONE: 'America/Edmonton', ...env }, now, log: { error() {} } });
  const server = createServer((req, res) => {
    const [, first, ...rest] = new URL(req.url, 'http://x').pathname.split('/');
    req.url = '/' + rest.join('/') + new URL(req.url, 'http://x').search;
    ({ care: app.staff, e: app.pub, ask: app.ask })[first](req, res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token = volunteer, name = 'Asha') => {
    const headers = { 'x-volunteer-name': encodeURIComponent(name) };
    if (token) headers.authorization = 'Bearer ' + token;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = r.headers.get('content-type') ?? '';
    return { status: r.status, body: type.includes('json') ? await r.json() : await r.text(), headers: r.headers };
  };
  return { call, base, close: () => { server.close(); app.close(); } };
}

test('similarity matches Python difflib ratios', () => {
  assert.equal(similarity('abcd', 'bcde'), 0.75);
  assert.equal(similarity('how do i volunteer?', 'how do i volunteer?'), 1);
  assert.ok(Math.abs(similarity('how can i become a volunter?', 'how can i become a volunteer?') - 0.9824) < 0.001);
});

test('SevaAssist matches alternatives, typos and declines off-topic or teacher questions', () => {
  const kb = demoKnowledge;
  assert.equal(findAnswer('How do I volunteer?', kb).entry.source, 'DEMO-002: Sample Volunteer Onboarding Guide');
  assert.equal(findAnswer('what do volunteers do', kb).entry.source, 'DEMO-004: Fictional Volunteer Responsibilities Guide');
  assert.equal(findAnswer('Where can I find trainng materials', kb).found, true);
  // Like the Python original, a misspelled subject word fails the volunteer/teacher check.
  assert.equal(findAnswer('How can I become a volunter?', kb).found, false);
  assert.equal(findAnswer('What is expected of a teacher?', kb).found, false);
  assert.equal(findAnswer('What is the office Wi-Fi password?', kb).found, false);
});

test('phone numbers are normalized with a default country code', () => {
  assert.deepEqual(normalizePhone('(403) 555-0143'), { phone: '(403) 555-0143', digits: '14035550143', valid: true });
  assert.equal(normalizePhone('+44 20 7946 0958').digits, '442079460958');
  assert.equal(normalizePhone('123').valid, false);
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
});

test('QR SVG encodes the link and decodes back', () => {
  const { decodeQRFromLuma, encodeQR } = createRequire(import.meta.url)('../../flyer/engine/qr.js');
  const link = 'https://example.org/e/sunday-satsang-nov-22';
  const svg = qrSvg(link, 'Scan to register');
  assert.match(svg, /^<svg/);
  // Rasterize the module grid and decode it with the flyer engine's decoder.
  const { modules, size } = encodeQR(link), scale = 4, quiet = 4, px = (size + quiet * 2) * scale;
  const grid = new Uint8Array(px * px).fill(255);
  modules.forEach((row, y) => row.forEach((on, x) => { if (on) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) grid[((y + quiet) * scale + dy) * px + (x + quiet) * scale + dx] = 0; }));
  const decoded = decodeQRFromLuma((x, y) => grid[y * px + x], { x: 0, y: 0, w: px });
  assert.deepEqual([decoded.ok, decoded.text], [true, link]);
});

test('staff API needs a token; managers alone can delete', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('GET', '/care/api/people', undefined, null)).status, 401);
    assert.equal((await s.call('GET', '/care/api/people', undefined, 'x'.repeat(40))).status, 401);
    const me = await s.call('GET', '/care/api/me');
    assert.equal(me.body.role, 'volunteer');
    assert.equal(me.body.today, '2026-11-15');
    const p = await s.call('POST', '/care/api/people', { fullName: 'Kiran Patel', phone: '403 555 0146', goal: 'A calmer routine', consent: true });
    assert.equal(p.status, 201);
    assert.equal(p.body.status, 'Potential');
    assert.equal((await s.call('POST', '/care/api/people', { fullName: 'Someone Else', phone: '+1 (403) 555-0146' })).status, 409);
    assert.equal((await s.call('DELETE', '/care/api/people/' + p.body.id)).status, 403);
    assert.equal((await s.call('DELETE', '/care/api/people/' + p.body.id, undefined, manager)).status, 200);
    assert.equal((await s.call('GET', '/care/api/people/' + p.body.id)).status, 404);
  } finally { s.close(); }
});

test('journey: steps set the current and next step', async () => {
  const s = await start();
  try {
    const p = (await s.call('POST', '/care/api/people', { fullName: 'Asha Kulkarni', phone: '4035550143', consent: true })).body;
    let r = await s.call('POST', `/care/api/people/${p.id}/steps`, { step: 'Part 1', date: '2026-10-01', teacher: 'Ravi Sharma' });
    assert.equal(r.status, 201);
    assert.equal(r.body.currentStep, 'Part 1');
    assert.equal(r.body.nextStep, 'Sahaj');
    assert.equal(r.body.teacher, 'Ravi Sharma');
    assert.equal(r.body.status, 'Participant');
    r = await s.call('POST', `/care/api/people/${p.id}/steps`, { step: 'Not a step', date: '2026-10-01' });
    assert.equal(r.status, 400);
  } finally { s.close(); }
});

test('queue: consent, do-not-contact, promises, claims and outcomes', async () => {
  const s = await start();
  try {
    const add = async (body) => (await s.call('POST', '/care/api/people', body)).body;
    const a = await add({ fullName: 'Due Today', phone: '4035550001', consent: true });
    const b = await add({ fullName: 'Overdue', phone: '4035550002', consent: true });
    const c = await add({ fullName: 'No Consent', phone: '4035550003', consent: false });
    const d = await add({ fullName: 'Do Not Contact', phone: '4035550004', consent: true });
    await s.call('PATCH', '/care/api/people/' + a.id, { nextFollowUp: '2026-11-15' });
    await s.call('PATCH', '/care/api/people/' + b.id, { nextFollowUp: '2026-11-10' });
    await s.call('PATCH', '/care/api/people/' + c.id, { nextFollowUp: '2026-11-10' });
    await s.call('PATCH', '/care/api/people/' + d.id, { nextFollowUp: '2026-11-10', doNotContact: true });
    let q = (await s.call('GET', '/care/api/queue')).body.items;
    assert.deepEqual(q.map(i => i.fullName), ['Overdue', 'Due Today']);
    assert.equal(q[0].kind, 'overdue');
    assert.equal((await s.call('POST', `/care/api/people/${c.id}/claim`)).status, 409);
    assert.equal((await s.call('POST', `/care/api/people/${a.id}/claim`)).status, 200);
    const taken = await s.call('POST', `/care/api/people/${a.id}/claim`, undefined, volunteer, 'Ben');
    assert.equal(taken.status, 409);
    assert.match(taken.body.error, /Asha is already contacting/);
    q = (await s.call('GET', '/care/api/queue', undefined, volunteer, 'Ben')).body.items;
    assert.equal(q.find(i => i.id === a.id).claimedBy, 'Asha');
    const logged = await s.call('POST', `/care/api/people/${a.id}/calls`, { outcome: 'Messaged', note: 'Sent the Satsang details', nextFollowUp: '2026-11-29' });
    assert.equal(logged.status, 201);
    assert.equal(logged.body.calls[0].volunteer, 'Asha');
    assert.equal(logged.body.nextFollowUp, '2026-11-29');
    q = (await s.call('GET', '/care/api/queue')).body.items;
    assert.deepEqual(q.map(i => i.fullName), ['Overdue']);
  } finally { s.close(); }
});

test('events: public registration, check-in, QR and course completion', async () => {
  const s = await start();
  try {
    const ev = (await s.call('POST', '/care/api/events', { program: 'Part 1', title: 'Happiness Program', teacher: 'Meera Nair', startsAt: '2026-11-20T18:00', place: 'Community Hall' })).body;
    assert.equal(ev.slug, 'happiness-program-nov-20');
    const ev2 = (await s.call('POST', '/care/api/events', { program: 'Part 1', title: 'Happiness Program', startsAt: '2026-11-20T18:00' })).body;
    assert.equal(ev2.slug, 'happiness-program-nov-20-2');

    const pub = await s.call('GET', '/e/api/events/' + ev.slug, undefined, null);
    assert.deepEqual(Object.keys(pub.body).sort(), ['description', 'place', 'program', 'slug', 'startsAt', 'status', 'teacher', 'title']);
    const reg = { fullName: 'Dev Rao', phone: '(403) 555-0147', goal: 'Meet people', consent: true };
    let r = await s.call('POST', `/e/api/events/${ev.slug}/register`, reg, null);
    assert.deepEqual([r.status, r.body.alreadyRegistered], [200, false]);
    r = await s.call('POST', `/e/api/events/${ev.slug}/register`, { ...reg, phone: '+1 403 555 0147' }, null);
    assert.equal(r.body.alreadyRegistered, true);
    assert.equal((await s.call('POST', `/e/api/events/${ev.slug}/register`, { ...reg, phone: '12' }, null)).status, 400);
    assert.equal((await s.call('POST', `/e/api/events/${ev.slug}/register`, { ...reg, website: 'spam' }, null)).status, 200);

    // New registrant with consent shows in the queue as new.
    const q = (await s.call('GET', '/care/api/queue')).body.items;
    assert.equal(q[0].fullName, 'Dev Rao');
    assert.match(q[0].why, /registered for Happiness Program/);

    // Walk-in at the venue, then mark the course completed for everyone who attended.
    r = await s.call('POST', `/e/api/events/${ev.slug}/checkin`, { fullName: 'Walk In', phone: '4035550199' }, null);
    assert.equal(r.body.walkIn, true);
    r = await s.call('POST', `/e/api/events/${ev.slug}/checkin`, { fullName: 'Dev Rao', phone: '4035550147' }, null);
    assert.equal(r.body.walkIn, false);
    const done = await s.call('POST', `/care/api/events/${ev.id}/complete`, {});
    assert.equal(done.body.added, 2);
    const people = (await s.call('GET', '/care/api/people?q=dev')).body;
    assert.equal(people[0].currentStep, 'Part 1');
    assert.equal(people[0].teacher, 'Meera Nair');
    assert.equal(people[0].nextStep, 'Sahaj');

    // Closing registration blocks sign-ups but not venue check-in.
    await s.call('PATCH', '/care/api/events/' + ev.id, { status: 'closed', title: 'Renamed' });
    assert.equal((await s.call('GET', '/care/api/events/' + ev.id)).body.slug, ev.slug);
    assert.equal((await s.call('POST', `/e/api/events/${ev.slug}/register`, { fullName: 'Late', phone: '4035550111' }, null)).status, 409);
    assert.equal((await s.call('POST', `/e/api/events/${ev.slug}/checkin`, { fullName: 'Late', phone: '4035550111' }, null)).status, 200);

    const qr = await s.call('GET', `/e/${ev.slug}/in/qr.svg`, undefined, null);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /svg/);
    assert.equal((await s.call('GET', '/e/no-such-event/qr.svg', undefined, null)).status, 404);
    assert.equal((await s.call('GET', `/e/${ev.slug}`, undefined, null)).status, 200);
  } finally { s.close(); }
});

test('Intro Talk check-in records the step automatically', async () => {
  const s = await start();
  try {
    const ev = (await s.call('POST', '/care/api/events', { program: 'Intro Talk', title: 'Free Intro', teacher: 'Ravi', startsAt: '2026-11-16T19:00' })).body;
    await s.call('POST', `/e/api/events/${ev.slug}/checkin`, { fullName: 'New Person', phone: '4035550222', consent: true }, null);
    const p = (await s.call('GET', '/care/api/people?q=new')).body[0];
    assert.equal(p.currentStep, 'Intro Talk');
    assert.equal(p.nextStep, 'Part 1');
  } finally { s.close(); }
});

test('SevaAssist API: staff ask, managers edit answers', async () => {
  const s = await start();
  try {
    assert.equal((await s.call('POST', '/ask/api/ask', { question: 'How do I volunteer?' }, null)).status, 401);
    let r = await s.call('POST', '/ask/api/ask', { question: 'How do I volunteer?' });
    assert.equal(r.body.found, true);
    r = await s.call('POST', '/ask/api/ask', { question: 'What is the office Wi-Fi password?' });
    assert.equal(r.body.found, false);
    const entry = { question: 'Where is the Satsang held?', alternatives: ['Where is Satsang?'], answer: 'At the Community Hall.', source: 'Chapter notes' };
    assert.equal((await s.call('POST', '/ask/api/knowledge', entry)).status, 403);
    assert.equal((await s.call('POST', '/ask/api/knowledge', entry, manager)).status, 201);
    r = await s.call('POST', '/ask/api/ask', { question: 'where is satsang' });
    assert.equal(r.body.answer, 'At the Community Hall.');
  } finally { s.close(); }
});
