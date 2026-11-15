import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { defaultDestinations, survey } from './catalog.mjs';
import { buildReport } from './report.mjs';
import { recommend, validateSubmission } from './rules.mjs';
import { DAY_MS, openStore } from './store.mjs';

const limitBytes = 4096;
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const digest = text => createHash('sha256').update(text).digest();

function integer(value, fallback, min, max, name) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(name + ' must be a whole number from ' + min + ' to ' + max + '.');
  }
  return number;
}

function destination(value, fallback, name) {
  if (!value) return fallback;
  const url = URL.parse(value);
  if (url?.protocol !== 'https:' || url.username || url.password) {
    throw new Error(name + ' must be a valid HTTPS URL.');
  }
  return url.href;
}

function token(value, name) {
  if (!value) return null;
  if (!tokenPattern.test(value)) {
    throw new Error(name + ' must have 32 to 128 URL-safe characters.');
  }
  return digest(value);
}

function readConfig(env) {
  const manager = token(env.AOL_MANAGER_TOKEN, 'AOL_MANAGER_TOKEN');
  const reporter = token(env.AOL_REPORT_TOKEN, 'AOL_REPORT_TOKEN');
  if (manager && reporter && timingSafeEqual(manager, reporter)) {
    throw new Error('Use different staff tokens.');
  }
  const volunteer = destination(env.AOL_VOLUNTEER_URL, defaultDestinations.volunteer, 'AOL_VOLUNTEER_URL');
  const origin = env.AOL_PUBLIC_ORIGIN?.trim();
  if (origin && URL.parse(origin)?.origin !== origin) {
    throw new Error('AOL_PUBLIC_ORIGIN must be an origin with no trailing slash or path.');
  }
  return {
    manager,
    reporter,
    origin,
    retentionDays: integer(env.AOL_RETENTION_DAYS, 90, 60, 365, 'AOL_RETENTION_DAYS'),
    postsPerMinute: integer(env.AOL_POSTS_PER_MINUTE, 120, 10, 1000, 'AOL_POSTS_PER_MINUTE'),
    destinations: {
      volunteer,
      teacher: destination(env.AOL_TEACHER_URL, volunteer, 'AOL_TEACHER_URL'),
      followups: destination(env.AOL_FOLLOWUPS_URL, defaultDestinations.followups, 'AOL_FOLLOWUPS_URL'),
      online: destination(env.AOL_ONLINE_URL, null, 'AOL_ONLINE_URL'),
    },
  };
}

function roleFor(header, config) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(header ?? '');
  if (!match) return null;
  const supplied = digest(match[1]);
  if (config.manager && timingSafeEqual(supplied, config.manager)) return 'manager';
  if (config.reporter && timingSafeEqual(supplied, config.reporter)) return 'reporter';
  return null;
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function error(response, status, code, message, extra, headers) {
  send(response, status, { error: code, message, ...extra }, headers);
}

async function readJson(request) {
  const type = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
  if (type !== 'application/json') return { status: 415, code: 'json_required', message: 'Send JSON.' };
  if (Number(request.headers['content-length']) > limitBytes) {
    return { status: 413, code: 'body_too_large', message: 'This response is too long.' };
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > limitBytes) {
      return { status: 413, code: 'body_too_large', message: 'This response is too long.' };
    }
    chunks.push(chunk);
  }
  try {
    return { body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) };
  } catch {
    return { status: 400, code: 'invalid_json', message: 'This response could not be read.' };
  }
}

export function createSurveyServer({ env = process.env, now = Date.now, log = console } = {}) {
  const config = readConfig(env);
  const store = openStore(env.AOL_DB_PATH || 'data/aol-programs.sqlite');
  const cutoff = () => new Date(now() - config.retentionDays * DAY_MS).toISOString();
  store.pruneBefore(cutoff());
  const cleanup = setInterval(() => {
    try {
      store.pruneBefore(cutoff());
    } catch {
      log.error('AOL Programs response retention cleanup failed.');
    }
  }, 60 * 60 * 1000);
  cleanup.unref();

  let bucket = -1;
  let posts = 0;
  const server = createServer({
    maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000, keepAliveTimeout: 5000,
  }, async (request, response) => {
    const at = now();
    let route;
    try {
      const url = new URL(request.url, 'http://localhost');
      route = request.method + ' ' + url.pathname;
      if (route === 'GET /api/health') return send(response, 200, { status: 'ok' });
      if (route === 'GET /api/survey') return send(response, 200, survey);

      if (route === 'POST /api/responses') {
        if (config.origin && request.headers.origin && request.headers.origin !== config.origin) {
          request.resume();
          return error(response, 403, 'origin', 'Open the survey from the shared link.');
        }
        const minute = Math.floor(at / 60_000);
        if (minute !== bucket) {
          bucket = minute;
          posts = 0;
        }
        posts += 1;
        if (posts > config.postsPerMinute) {
          request.resume();
          const retryAfter = String(Math.ceil((60_000 - (at % 60_000)) / 1000));
          return error(response, 429, 'try_again', 'Please try again shortly.', {}, { 'Retry-After': retryAfter });
        }
        const json = await readJson(request);
        if (json.status) {
          request.resume();
          const headers = json.status === 413 ? { Connection: 'close' } : {};
          return error(response, json.status, json.code, json.message, {}, headers);
        }
        const validated = validateSubmission(json.body);
        if (validated.versionMismatch) {
          return error(response, 409, 'survey_updated', 'Reload the survey to use the latest questions.');
        }
        if (validated.errors) {
          return error(response, 422, 'invalid_answers', 'Please check the highlighted answers.', { fields: validated.errors });
        }
        const recommendation = recommend(validated.answers, config.destinations);
        const saved = store.save(validated.submissionId, validated.answers, recommendation, new Date(now()).toISOString());
        if (saved.conflict) {
          return error(response, 409, 'submission_conflict', 'This submission already has different answers.');
        }
        return send(response, saved.created ? 201 : 200, saved.receipt);
      }

      if (route === 'GET /api/staff/report' || route === 'GET /api/staff/responses') {
        const role = roleFor(request.headers.authorization, config);
        if (!role) return error(response, 401, 'staff_auth', 'Staff access is required.', {}, { 'WWW-Authenticate': 'Bearer' });
        if (route === 'GET /api/staff/report') {
          return send(response, 200, buildReport(store, at, role === 'manager', config.retentionDays));
        }
        if (role !== 'manager') return error(response, 403, 'manager_auth', 'Manager access is required.');
        let limit;
        let before;
        try {
          limit = integer(url.searchParams.get('limit'), 50, 1, 100, 'limit');
          before = integer(url.searchParams.get('before'), null, 1, Number.MAX_SAFE_INTEGER, 'before');
        } catch {
          return error(response, 400, 'invalid_page', 'Use a limit from 1 to 100 and a valid before cursor.');
        }
        return send(response, 200, store.managerPage(before, limit, cutoff()));
      }

      return error(response, 404, 'route', 'This page is unavailable.');
    } catch (cause) {
      if (request.destroyed && !request.complete) return;
      const busy = cause.code === 'ERR_SQLITE_ERROR' && [5, 6].includes(cause.errcode & 255);
      if (!busy) log.error('AOL Programs survey request failed.', route ?? 'unknown route');
      const headers = busy ? { 'Retry-After': '3' } : {};
      if (!response.headersSent) {
        error(response, busy ? 503 : 500, 'try_again', 'Please try again shortly.', {}, headers);
      } else {
        response.end();
      }
    }
  });
  server.on('close', () => {
    clearInterval(cleanup);
    store.close();
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.AOL_HOST || '127.0.0.1';
  const port = integer(process.env.AOL_PORT, 8787, 1, 65535, 'AOL_PORT');
  const server = createSurveyServer();
  server.listen(port, host, () => console.log('AOL Programs survey API listening on http://' + host + ':' + port));
  process.once('SIGTERM', () => server.close());
  process.once('SIGINT', () => server.close());
}
