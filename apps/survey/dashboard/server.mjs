// Staff dashboard server. Serves the dashboard page and forwards only the
// staff report/response routes (plus the public questionnaire, for labels)
// to the backend. The staff member's own token travels in the Authorization
// header from their browser; this server never stores it.
//
// By default it listens on 127.0.0.1 only. Do not put it on the public
// survey's domain; if it must be reachable remotely, put it behind HTTPS
// and your organisation's sign-in (e.g. a VPN or an access proxy).

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const publicRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), 'public');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const allowed = new Set(['GET /api/survey', 'GET /api/staff/report', 'GET /api/staff/responses']);

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': [
    "default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'",
    "img-src 'self' data:", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'self'",
  ].join('; '),
};

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...securityHeaders });
  res.end(text);
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = resolve(publicRoot, '.' + normalize(rel));
  if (!file.startsWith(publicRoot + sep)) return sendText(res, 404, 'Not found');
  let info;
  try { info = await stat(file); } catch { return sendText(res, 404, 'Not found'); }
  if (!info.isFile()) return sendText(res, 404, 'Not found');
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, ...securityHeaders });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function proxy(req, res, apiOrigin) {
  const target = new URL(req.url, apiOrigin);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = { accept: 'application/json', host: target.host };
  if (req.headers.authorization) headers.authorization = req.headers.authorization;
  const upstream = send(target, { method: 'GET', headers, timeout: 15_000 }, up => {
    res.writeHead(up.statusCode ?? 502, { ...up.headers, 'cache-control': 'no-store' });
    up.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'backend_unavailable', message: 'The survey backend is not reachable. Is it running?' }));
  });
  upstream.end();
}

export function createDashboardServer({ apiOrigin = 'http://127.0.0.1:8787' } = {}) {
  return createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      req.resume();
      if (!allowed.has(req.method + ' ' + pathname)) {
        res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify({ error: 'route', message: 'This page is unavailable.' }));
      }
      return proxy(req, res, apiOrigin);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed');
    serveStatic(req, res, pathname).catch(() => sendText(res, 500, 'Server error'));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.DASHBOARD_HOST || '127.0.0.1';
  const port = Number(process.env.DASHBOARD_PORT || 5174);
  const apiOrigin = process.env.AOL_API_ORIGIN || 'http://127.0.0.1:8787';
  createDashboardServer({ apiOrigin }).listen(port, host, () => {
    console.log(`Staff dashboard on http://${host}:${port}  (API → ${apiOrigin})`);
  });
}
