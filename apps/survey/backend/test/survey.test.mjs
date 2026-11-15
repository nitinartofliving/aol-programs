import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { defaultDestinations, surveyVersion, thankYou } from '../catalog.mjs';
import { recommend, validateSubmission } from '../rules.mjs';
import { createSurveyServer } from '../server.mjs';
import { DAY_MS } from '../store.mjs';

const manager = 'm'.repeat(43);
const reporter = 'r'.repeat(43);
const baseTime = Date.parse('2026-11-14T18:00:00.000Z');
const auth = token => ({ Authorization: 'Bearer ' + token });
const response = (values = {}) => ({
  surveyVersion, submissionId: randomUUID(), attendance: 'never',
  barriers: ['none'], priority: 'no_preference', ...values,
});

async function api(env = {}, now = () => baseTime) {
  const server = createSurveyServer({
    env: { AOL_DB_PATH: ':memory:', AOL_MANAGER_TOKEN: manager, AOL_REPORT_TOKEN: reporter, ...env },
    now,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  return {
    get: (path, headers) => fetch(base + path, { headers }),
    send: (data, headers = {}) => fetch(base + '/api/responses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof data === 'string' ? data : JSON.stringify(data),
    }),
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test('validates answer IDs, limits, exclusivity and optional text', () => {
  const answers = validateSubmission(response({ barriers: ['travel', 'day'], comment: '   West End\r\nThanks   ' })).answers;
  assert.deepEqual(answers.barriers, ['day', 'travel']);
  assert.equal(answers.day, null);
  assert.equal(answers.comment, 'West End\nThanks');
  for (const barrierSet of [[], ['day', 'day'], ['day', 'time', 'venue'], ['skip', 'day'], ['none', 'venue'], ['unknown']]) {
    assert.ok(validateSubmission(response({ barriers: barrierSet })).errors.barriers);
  }
  assert.ok(validateSubmission(response({ day: '' })).errors.day);
  assert.ok(validateSubmission(response({ attendance: 'unlisted' })).errors.attendance);
  assert.ok(validateSubmission(response({ email: 'Unexpected field' })).errors.form);
  assert.equal(validateSubmission(response({ name: '  Priya \n S  ' })).answers.name, 'Priya S');
  assert.equal(validateSubmission(response({ name: '   ' })).answers.name, null);
  assert.equal(validateSubmission(response({})).answers.name, null);
  assert.ok(validateSubmission(response({ name: 'x'.repeat(81) })).errors.name);
  assert.ok(validateSubmission(response({ name: 42 })).errors.name);
  assert.ok(validateSubmission(response({ comment: '🌿'.repeat(241) })).errors.comment);
  assert.equal(validateSubmission(response({ comment: '🌿'.repeat(240) })).answers.comment.length, 480);
  assert.equal(validateSubmission(response({ barriers: ['other'] })).answers.comment, null);
});

test('selects one fixed result and applies the promised precedence', () => {
  const cases = [
    [{ barriers: ['day', 'access'], priority: 'guided', format: 'online' }, 'teacher_support', 'access_support'],
    [{ barriers: ['solo'], priority: 'questions' }, 'teacher_support', 'learning_support'],
    [{ priority: 'refresher', barriers: ['travel'] }, 'teacher_support', 'learning_support'],
    [{ barriers: ['details', 'solo'], priority: 'guided' }, 'stay_connected', 'solo_preference'],
    [{ barriers: ['venue', 'time'] }, 'ask_volunteer', 'session_fit'],
    [{ priority: 'shorter' }, 'ask_volunteer', 'session_fit'],
    [{ format: 'online', priority: 'guided' }, 'ask_volunteer', 'online_contact'],
    [{ barriers: ['commitments'] }, 'find_sessions', 'session_planning'],
    [{ barriers: ['details'] }, 'find_sessions', 'session_planning'],
    [{ priority: 'connect', day: 'saturday', time: 'morning' }, 'group_practice', 'group_interest'],
    [{ day: 'saturday' }, 'find_sessions', 'availability'],
    [{ format: 'in_person' }, 'find_sessions', 'availability'],
    [{ barriers: ['other'], comment: 'travel and access' }, 'stay_connected', 'open_invitation'],
    [{ barriers: ['skip'], day: 'any_day', time: 'any_time', format: 'either' }, 'stay_connected', 'open_invitation'],
  ];
  for (const [values, code, rule] of cases) {
    const answers = validateSubmission(response(values)).answers;
    const result = recommend(answers, defaultDestinations);
    assert.equal(result.code, code);
    assert.equal(result.rule, rule);
    assert.ok(result.label.split(' ').length <= 2);
    assert.equal(new URL(result.href).hostname, 'www.artofliving.org');
  }
  const online = 'https://www.artofliving.org/ca-en';
  const result = recommend(validateSubmission(response({ format: 'online' })).answers, { ...defaultDestinations, online });
  assert.equal(result.code, 'online_options');
  assert.equal(result.href, online);
});

test('serves the questionnaire, saves once and replays one receipt for concurrent retries', async t => {
  const app = await api();
  t.after(app.close);

  const health = await app.get('/api/health');
  assert.deepEqual(await health.json(), { status: 'ok' });
  const schema = await app.get('/api/survey');
  assert.equal(schema.status, 200);
  assert.equal(schema.headers.get('cache-control'), 'no-store');
  const catalog = await schema.json();
  assert.equal(catalog.version, surveyVersion);
  assert.equal(catalog.questions.filter(question => question.required).length, 3);
  assert.equal(catalog.questions.find(question => question.id === 'barriers').maxSelections, 2);

  const first = response({ barriers: ['time', 'day'], day: 'sunday', comment: 'North End' });
  const second = { ...first, barriers: ['day', 'time'] };
  const receipts = await Promise.all([app.send(first), app.send(second)]);
  assert.deepEqual(receipts.map(r => r.status).sort(), [200, 201]);
  const [a, b] = await Promise.all(receipts.map(r => r.json()));
  assert.deepEqual(a, b);
  assert.equal(a.thankYou, thankYou);
  assert.equal(a.recommendation.code, 'find_sessions');
  assert.deepEqual(Object.keys(a.recommendation).sort(), ['code', 'href', 'label']);

  assert.equal((await app.send({ ...first, day: 'saturday' })).status, 409);
  assert.equal((await app.get('/api/staff/report')).status, 401);
  assert.equal((await app.get('/api/staff/responses', auth(reporter))).status, 403);
  const staff = await (await app.get('/api/staff/responses', auth(manager))).json();
  assert.equal(staff.records.length, 1);
  assert.equal(staff.records[0].answers.comment, 'North End');
  assert.equal(staff.records[0].recommendation.rule, 'session_planning');
  assert.equal((await app.get('/api/staff/responses?limit=101', auth(manager))).status, 400);

  const report = await (await app.get('/api/staff/report', auth(reporter))).json();
  assert.deepEqual(report.current.all, { status: 'small_sample', total: null });
});

test('returns structured errors for invalid submissions, body limits and origin mismatch', async t => {
  const app = await api({ AOL_PUBLIC_ORIGIN: 'https://survey.example.org' });
  t.after(app.close);
  assert.equal((await app.send('{')).status, 400);
  assert.equal((await app.send('x'.repeat(4200))).status, 413);
  assert.equal((await app.send(response(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await app.send(response(), { Origin: 'https://unrelated.example.org' })).status, 403);
  assert.equal((await app.send(response(), { Origin: 'https://survey.example.org' })).status, 201);
  const invalid = await app.send(response({ barriers: ['none', 'day'] }));
  assert.equal(invalid.status, 422);
  assert.ok((await invalid.json()).fields.barriers);
  const stale = await app.send(response({ surveyVersion: 'aol-programs-v0' }));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error, 'survey_updated');
});

test('reports trends with cohort denominators, excludes skipped answers and keeps comments private', async t => {
  let now = baseTime - 32 * DAY_MS;
  const app = await api({}, () => now);
  t.after(app.close);
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await app.send(response({ attendance: 'lapsed', barriers: ['venue'] }))).status, 201);
  }
  now = baseTime;
  const noRecent = [
    ['day', 'time'], ['day'], ['commitments', 'details'], ['details', 'venue'],
    ['details', 'access'], ['solo'], ['skip'],
  ];
  for (const barriers of noRecent) {
    const result = await app.send(response({
      barriers, day: 'saturday', time: 'morning', format: 'online', priority: 'guided', comment: 'Private feedback',
    }));
    assert.equal(result.status, 201);
  }
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await app.send(response({ attendance: 'two_plus', priority: 'connect' }))).status, 201);
  }

  const report = await (await app.get('/api/staff/report', auth(reporter))).json();
  assert.equal(report.current.all.total, 12);
  assert.equal(report.prior.all.total, 5);
  assert.equal(report.current.noRecent.total, 7);
  assert.equal(report.current.recent.total, 5);
  assert.equal(report.current.noRecent.barriers.denominator, 6);
  const barrierOptions = report.current.noRecent.barriers.options;
  assert.equal(barrierOptions.find(o => o.id === 'details').count, 3);
  assert.equal(barrierOptions.find(o => o.id === 'details').percent, 50);
  assert.equal(barrierOptions.some(o => o.id === 'access' || o.id === 'skip'), false);
  assert.equal(report.current.noRecent.schedulePairs.denominator, 7);
  assert.equal(report.current.noRecent.schedulePairs.options[0].id, 'saturday/morning');
  assert.deepEqual(report.volunteerActions.map(a => a.id), ['schedule', 'details', 'guided', 'online']);
  assert.equal(JSON.stringify(report).includes('Private feedback'), false);

  const fullReport = await (await app.get('/api/staff/report', auth(manager))).json();
  assert.equal(fullReport.current.noRecent.barriers.options.find(o => o.id === 'access').count, 1);
  const firstPage = await (await app.get('/api/staff/responses?limit=3', auth(manager))).json();
  const nextPage = await (await app.get('/api/staff/responses?limit=3&before=' + firstPage.nextBefore, auth(manager))).json();
  assert.equal(firstPage.records.length, 3);
  assert.ok(nextPage.records[0].id < firstPage.records[2].id);
});

test('persists responses and their original recommendation link across a restart, then expires records', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aol-db-'));
  const dbPath = join(dir, 'survey.sqlite');
  const submission = response({ barriers: ['time'] });
  let running;
  let stored;
  try {
    running = await api({ AOL_DB_PATH: dbPath, AOL_FOLLOWUPS_URL: 'https://www.artofliving.org/ca-en/' });
    stored = await (await running.send(submission)).json();
    await running.close();
    running = await api({ AOL_DB_PATH: dbPath });
    const retry = await running.send(submission);
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), stored);
    await running.close();
    running = await api({ AOL_DB_PATH: dbPath }, () => baseTime + 91 * DAY_MS);
    const page = await (await running.get('/api/staff/responses', auth(manager))).json();
    assert.deepEqual(page.records, []);
  } finally {
    await running?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test('limits submitted requests in each minute without storing visitor addresses', async t => {
  let now = baseTime;
  const app = await api({ AOL_POSTS_PER_MINUTE: '10' }, () => now);
  t.after(app.close);
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await app.send(response())).status, 201);
  }
  const over = await app.send(response());
  assert.equal(over.status, 429);
  assert.equal(over.headers.get('retry-after'), '60');
  now += 60_000;
  assert.equal((await app.send(response())).status, 201);
});
