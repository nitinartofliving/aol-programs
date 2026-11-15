// AOL Programs: one web server for all three tools.
//
//   /            home page with tabs (public/)
//   /outreach/   Outreach Finder        (apps/outreach)
//   /flyer/      Flyer Studio           (apps/flyer)
//   /survey/     Follow-up survey       (apps/survey/frontend + backend public API)
//   /staff/      Staff dashboard        (apps/survey/dashboard + backend staff API, token required)
//   /care/       People & Journeys      (apps/care, staff token required)
//   /e/<slug>    Public event sign-up and venue check-in pages (opened from QR codes)
//   /ask/        SevaAssist             (apps/care, staff token required)
//
// Every app runs in this one process. Requests are handed to each app's own
// handler with the path prefix removed, so the apps keep their own logic,
// checks and security headers.

import { createReadStream, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { extname, isAbsolute, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);

// Keep the databases next to this app unless a path is given.
const env = { ...process.env };
for (const [key, fallback] of [['AOL_DB_PATH', 'data/aol-programs.sqlite'], ['AOL_CARE_DB_PATH', 'data/care.sqlite']]) {
  const p = env[key] || fallback;
  env[key] = p === ':memory:' || isAbsolute(p) ? p : resolve(root, p);
  if (env[key] !== ':memory:') mkdirSync(resolve(env[key], '..'), { recursive: true });
}

const { createSurveyServer } = await import('./apps/survey/backend/server.mjs');
const { createCareApp } = await import('./apps/care/server.mjs');
const { createFrontendServer } = await import('./apps/survey/frontend/server.mjs');
const { createDashboardServer } = await import('./apps/survey/dashboard/server.mjs');
const outreach = require('./apps/outreach/server.js');
const { server: flyer } = require('./apps/flyer/server.js');

const surveyApi = createSurveyServer({ env });
const surveyPage = createFrontendServer();
const staffPage = createDashboardServer();
const care = createCareApp({ env });

const publicSurveyApi = new Set(['GET /api/health', 'GET /api/survey', 'POST /api/responses']);
const staffApi = new Set(['GET /api/survey', 'GET /api/staff/report', 'GET /api/staff/responses']);

const mounts = {
  outreach: (req, res) => outreach(req, res),
  flyer: (req, res) => flyer.emit('request', req, res),
  survey: (req, res, path) => {
    if (path === '/api' || path.startsWith('/api/')) {
      if (!publicSurveyApi.has(req.method + ' ' + path)) return notFound(req, res);
      delete req.headers.authorization; // staff credentials never travel through the public survey
      return surveyApi.emit('request', req, res);
    }
    return surveyPage.emit('request', req, res);
  },
  staff: (req, res, path) => {
    if (path === '/api' || path.startsWith('/api/')) {
      if (!staffApi.has(req.method + ' ' + path)) return notFound(req, res);
      return surveyApi.emit('request', req, res);
    }
    return staffPage.emit('request', req, res);
  },
  care: (req, res) => care.staff(req, res), // People & Journeys (staff token)
  e: (req, res) => care.pub(req, res),      // public event sign-up and check-in pages
  ask: (req, res) => care.ask(req, res),    // SevaAssist
};

function notFound(req, res) {
  req.resume();
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'route', message: 'This page is unavailable.' }));
}

// ---------- Home page (tab shell) ----------
const shellRoot = resolve(root, 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const shellHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
};

async function serveShell(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  const rel = pathname === '/' ? '/index.html' : decodeURIComponent(pathname);
  const file = resolve(shellRoot, '.' + normalize(rel));
  let info;
  try { if (!file.startsWith(shellRoot + sep)) throw 0; info = await stat(file); if (!info.isFile()) throw 0; } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...shellHeaders });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache', ...shellHeaders });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

// ---------- Router ----------
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const [, first = '', ...rest] = url.pathname.split('/');
    const mount = mounts[first];
    if (!mount) return await serveShell(req, res, url.pathname);
    if (rest.length === 0) { // "/flyer" -> "/flyer/" so the app's relative links resolve
      res.writeHead(301, { Location: '/' + first + '/' + url.search });
      return res.end();
    }
    const path = '/' + rest.join('/');
    req.url = path + url.search;
    return mount(req, res, path);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Server error'); } else res.end();
  }
});

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3000);
server.listen(port, host, () => {
  const shown = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`AOL Programs running at http://${shown}:${port}`);
  console.log('  Staff dashboard: ' + (env.AOL_MANAGER_TOKEN || env.AOL_REPORT_TOKEN ? 'enabled' : 'disabled (set AOL_MANAGER_TOKEN in .env)'));
  console.log('  People & SevaAssist: ' + (env.AOL_MANAGER_TOKEN || env.AOL_VOLUNTEER_TOKEN ? 'enabled' : 'sign-in disabled (set AOL_MANAGER_TOKEN or AOL_VOLUNTEER_TOKEN in .env)'));
});
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { server.close(); surveyApi.emit('close'); care.close(); process.exit(0); });
