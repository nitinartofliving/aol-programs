// Serves the public survey and forwards /api/* to the backend, so the browser
// sees one origin. Use it for local development and, behind an HTTPS reverse
// proxy (Caddy, nginx, a platform load balancer), for release.
//
// Staff routes (/api/staff/*) are NOT forwarded: staff use the backend directly
// with their own token. This keeps staff records off the public origin.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const publicRoot = resolve(here, 'public');

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

const publicApi = new Set(['GET /api/health', 'GET /api/survey', 'POST /api/responses']);

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "connect-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
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
  if (file !== publicRoot && !file.startsWith(publicRoot + sep)) return sendText(res, 404, 'Not found');
  let info;
  try {
    info = await stat(file);
  } catch {
    return sendText(res, 404, 'Not found');
  }
  if (!info.isFile()) return sendText(res, 404, 'Not found');
  const type = types[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': info.size,
    // HTML always fresh so a questionnaire update is picked up; assets briefly cached.
    'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300',
    ...securityHeaders,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

function proxy(req, res, apiOrigin) {
  const target = new URL(req.url, apiOrigin);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = { ...req.headers, host: target.host };
  delete headers.connection;
  delete headers.authorization; // never forward credentials from the public origin
  const upstream = send(target, { method: req.method, headers, timeout: 15_000 }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '3', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'try_again', message: 'Please try again shortly.' }));
    } else {
      res.destroy();
    }
  });
  req.pipe(upstream);
}

export function createFrontendServer({ apiOrigin = 'http://127.0.0.1:8787' } = {}) {
  return createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      if (!publicApi.has(req.method + ' ' + pathname)) {
        req.resume();
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
  const host = process.env.WEB_HOST || '127.0.0.1';
  const port = Number(process.env.WEB_PORT || 5173);
  const apiOrigin = process.env.AOL_API_ORIGIN || 'http://127.0.0.1:8787';
  createFrontendServer({ apiOrigin }).listen(port, host, () => {
    console.log(`AOL Programs survey on http://${host}:${port}  (API → ${apiOrigin})`);
  });
}
