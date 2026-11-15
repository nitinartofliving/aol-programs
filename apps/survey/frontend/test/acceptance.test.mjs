// End-to-end acceptance checks from the build brief, run through the
// frontend server (same origin) against a real in-memory backend.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { createSurveyServer } from '../../backend/server.mjs';
import { createFrontendServer } from '../server.mjs';

const manager = 'M'.repeat(43);
const reporter = 'R'.repeat(43);

async function stack(env = {}) {
  const api = createSurveyServer({
    env: { AOL_DB_PATH: ':memory:', AOL_MANAGER_TOKEN: manager, AOL_REPORT_TOKEN: reporter, ...env },
    log: { error() {} },
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const apiOrigin = `http://127.0.0.1:${api.address().port}`;
  const web = createFrontendServer({ apiOrigin });
  web.listen(0, '127.0.0.1');
  await once(web, 'listening');
  const webOrigin = `http://127.0.0.1:${web.address().port}`;
  const close = async () => {
    web.close(); api.close();
    await Promise.all([once(web, 'close'), once(api, 'close')]);
  };
  return { apiOrigin, webOrigin, close };
}

const post = (origin, body) => fetch(origin + '/api/responses', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function survey(origin) {
  const schema = await (await fetch(origin + '/api/survey')).json();
  return schema;
}

function answer(schema, values) {
  return {
    surveyVersion: schema.version, submissionId: randomUUID(),
    attendance: 'never', barriers: ['none'], priority: 'no_preference', ...values,
  };
}

async function managerRecords(apiOrigin) {
  const res = await fetch(apiOrigin + '/api/staff/responses?limit=100', { headers: { Authorization: 'Bearer ' + manager } });
  assert.equal(res.status, 200);
  return (await res.json()).records;
}

test('serves the public page and the schema through one origin', async t => {
  const s = await stack();
  t.after(s.close);
  const page = await fetch(s.webOrigin + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /AOL Programs follow-ups/);
  const schema = await survey(s.webOrigin);
  assert.equal(schema.version, 'aol-programs-v1');
  assert.deepEqual(schema.questions.map(q => q.id), ['attendance', 'barriers', 'priority', 'schedule', 'format', 'comment', 'name']);
  assert.equal((await fetch(s.webOrigin + '/../backend/.env')).status, 404);
});

test('saves with optional fields blank, Other, and a comment at the limit', async t => {
  const s = await stack();
  t.after(s.close);
  const schema = await survey(s.webOrigin);

  const blank = await post(s.webOrigin, answer(schema, {}));
  assert.equal(blank.status, 201);
  assert.equal((await blank.json()).recommendation.code, 'stay_connected');

  const other = await post(s.webOrigin, answer(schema, { barriers: ['other'], comment: 'é'.repeat(240) }));
  assert.equal(other.status, 201);

  const tooLong = await post(s.webOrigin, answer(schema, { comment: 'x'.repeat(241) }));
  assert.equal(tooLong.status, 422);
  assert.ok((await tooLong.json()).fields.comment);

  const three = await post(s.webOrigin, answer(schema, { barriers: ['day', 'time', 'travel'] }));
  assert.equal(three.status, 422);
  const exclusive = await post(s.webOrigin, answer(schema, { barriers: ['none', 'day'] }));
  assert.equal(exclusive.status, 422);
  assert.equal((await exclusive.json()).fields.barriers, 'Choose this answer on its own.');
});

test('receipt matches the manager record for the brief’s routing cases', async t => {
  const s = await stack(); // AOL_ONLINE_URL unset
  t.after(s.close);
  const schema = await survey(s.webOrigin);
  const cases = [
    [{ barriers: ['access', 'day'], day: 'sunday', time: 'evening' }, 'teacher_support', 'access_support'],
    [{ barriers: ['solo'], priority: 'connect' }, 'stay_connected', 'solo_preference'],
    [{ barriers: ['none'], priority: 'guided', format: 'online' }, 'ask_volunteer', 'online_contact'],
    [{ attendance: 'lapsed', barriers: ['day', 'details'], priority: 'guided', day: 'sunday', time: 'morning', format: 'either' }, 'find_sessions', 'session_planning'],
  ];
  const receipts = [];
  for (const [values, code] of cases) {
    const res = await post(s.webOrigin, answer(schema, values));
    assert.equal(res.status, 201);
    const receipt = await res.json();
    assert.equal(receipt.recommendation.code, code);
    assert.equal(receipt.recommendation.rule, undefined, 'rule stays server-side');
    receipts.push(receipt);
  }
  const records = (await managerRecords(s.apiOrigin)).reverse();
  records.forEach((record, i) => {
    assert.equal(record.recommendation.code, receipts[i].recommendation.code);
    assert.equal(record.recommendation.href, receipts[i].recommendation.href);
    assert.equal(record.recommendation.rule, cases[i][2]);
  });
});

test('online with an approved link routes to Online Options', async t => {
  const s = await stack({ AOL_ONLINE_URL: 'https://example.org/online' });
  t.after(s.close);
  const schema = await survey(s.webOrigin);
  const res = await post(s.webOrigin, answer(schema, { format: 'online', priority: 'guided' }));
  assert.deepEqual((await res.json()).recommendation, { code: 'online_options', label: 'Online Options', href: 'https://example.org/online' });
});

test('retrying the same UUID stores one row; a changed payload conflicts', async t => {
  const s = await stack();
  t.after(s.close);
  const schema = await survey(s.webOrigin);
  const body = answer(schema, { barriers: ['travel'] });
  const first = await post(s.webOrigin, body);
  const again = await post(s.webOrigin, body);
  assert.equal(first.status, 201);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), await first.json());
  assert.equal((await managerRecords(s.apiOrigin)).length, 1);
  assert.equal((await post(s.webOrigin, { ...body, priority: 'guided' })).status, 409);
  const stale = await post(s.webOrigin, { ...body, surveyVersion: 'old' });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'survey_updated');
});

test('staff routes need a token, reporters cannot read rows, and the public origin hides staff routes', async t => {
  const s = await stack();
  t.after(s.close);
  assert.equal((await fetch(s.apiOrigin + '/api/staff/report')).status, 401);
  assert.equal((await fetch(s.apiOrigin + '/api/staff/responses')).status, 401);
  const asReporter = { headers: { Authorization: 'Bearer ' + reporter } };
  assert.equal((await fetch(s.apiOrigin + '/api/staff/report', asReporter)).status, 200);
  assert.equal((await fetch(s.apiOrigin + '/api/staff/responses', asReporter)).status, 403);
  // Through the public frontend, staff routes are not exposed at all – even with a token.
  const viaPublic = await fetch(s.webOrigin + '/api/staff/report', { headers: { Authorization: 'Bearer ' + manager } });
  assert.equal(viaPublic.status, 404);
});

test('an optional name is visible to the manager only, never in reports', async t => {
  const s = await stack();
  t.after(s.close);
  const schema = await survey(s.webOrigin);
  for (let i = 0; i < 5; i += 1) {
    const res = await post(s.webOrigin, answer(schema, { name: i === 0 ? '  Priya   S ' : null, comment: 'secret note' }));
    assert.equal(res.status, 201);
  }
  const records = await managerRecords(s.apiOrigin);
  assert.deepEqual(records.map(r => r.answers.name).filter(Boolean), ['Priya S']);
  for (const token of [manager, reporter]) {
    const report = await (await fetch(s.apiOrigin + '/api/staff/report', { headers: { Authorization: 'Bearer ' + token } })).text();
    assert.ok(!report.includes('Priya') && !report.includes('secret note'));
  }
  assert.equal((await post(s.webOrigin, answer(schema, { name: 'x'.repeat(81) }))).status, 422);
});
