import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createSurveyServer } from '../../backend/server.mjs';
import { createDashboardServer } from '../server.mjs';

const manager = 'M'.repeat(43);
const reporter = 'R'.repeat(43);

async function stack() {
  const api = createSurveyServer({
    env: { AOL_DB_PATH: ':memory:', AOL_MANAGER_TOKEN: manager, AOL_REPORT_TOKEN: reporter },
    log: { error() {} },
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  const dash = createDashboardServer({ apiOrigin: `http://127.0.0.1:${api.address().port}` });
  dash.listen(0, '127.0.0.1');
  await once(dash, 'listening');
  const origin = `http://127.0.0.1:${dash.address().port}`;
  return { origin, close: async () => { dash.close(); api.close(); await Promise.all([once(dash, 'close'), once(api, 'close')]); } };
}

const as = token => ({ headers: { Authorization: 'Bearer ' + token } });

test('serves the dashboard page with strict headers', async t => {
  const s = await stack();
  t.after(s.close);
  const res = await fetch(s.origin + '/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await res.text(), /Staff dashboard/);
});

test('forwards the staff token and keeps role separation', async t => {
  const s = await stack();
  t.after(s.close);
  assert.equal((await fetch(s.origin + '/api/staff/report')).status, 401);
  assert.equal((await fetch(s.origin + '/api/staff/report', as(reporter))).status, 200);
  assert.equal((await fetch(s.origin + '/api/staff/responses', as(reporter))).status, 403);
  const page = await fetch(s.origin + '/api/staff/responses?limit=5', as(manager));
  assert.equal(page.status, 200);
  assert.deepEqual(await page.json(), { records: [], nextBefore: null });
});

test('does not accept survey submissions or unknown routes', async t => {
  const s = await stack();
  t.after(s.close);
  const post = await fetch(s.origin + '/api/responses', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(post.status, 404);
  assert.equal((await fetch(s.origin + '/api/health')).status, 404);
  assert.equal((await fetch(s.origin + '/api/survey')).status, 200);
});
