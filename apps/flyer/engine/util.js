'use strict';
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const hexToRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h); const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const chan = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const relLum = ([r, g, b]) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
const contrast = (a, b) => { const l1 = relLum(a), l2 = relLum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '')); if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3], dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return { y, mo, d, weekday: WEEKDAYS[dt.getUTCDay()], month: MONTHS[mo - 1], key: s };
}
function parseTime(s) { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || '')); return m ? { h: +m[1], m: +m[2], mins: +m[1] * 60 + +m[2] } : null; }
function fmtTime(t) { const mer = t.h >= 12 ? 'p.m.' : 'a.m.'; const h12 = t.h % 12 === 0 ? 12 : t.h % 12; return { text: h12 + ':' + String(t.m).padStart(2, '0'), mer }; }
function fmtRange(start, end) {
  const a = fmtTime(start); if (!end) return a.text + ' ' + a.mer;
  const b = fmtTime(end); return a.mer === b.mer ? a.text + ' to ' + b.text + ' ' + b.mer : a.text + ' ' + a.mer + ' to ' + b.text + ' ' + b.mer;
}
function validTimeZone(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
function offsetMin(utcMs, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs) / 60000;
}
// Does this local wall-clock time exist in the zone (not skipped by a clock change)?
function localTimeExists(tz, d, t) {
  const naive = Date.UTC(d.y, d.mo - 1, d.d, t.h, t.m);
  for (const o of new Set([offsetMin(naive - 864e5, tz), offsetMin(naive + 864e5, tz)])) {
    const inst = naive - o * 60000, back = offsetMin(inst, tz);
    if (inst + back * 60000 === naive) return true;
  }
  return false;
}
function tzLabel(tz) { const last = String(tz).split('/').pop().replace(/_/g, ' '); return (last === 'St Johns' ? "St. John's" : last) + ' time'; }

function sha256(obj) { return crypto.createHash('sha256').update(typeof obj === 'string' ? obj : JSON.stringify(sortKeys(obj))).digest('hex'); }
function sortKeys(o) { if (Array.isArray(o)) return o.map(sortKeys); if (o && typeof o === 'object') return Object.keys(o).sort().reduce((a, k) => (a[k] = sortKeys(o[k]), a), {}); return o; }

const PRIVATE = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
function safeUrl(u) {
  let x; try { x = new URL(String(u || '').trim()); } catch { return { ok: false, reason: 'not a complete web address' }; }
  if (!/^https?:$/.test(x.protocol)) return { ok: false, reason: 'only http and https links are accepted' };
  if (x.username || x.password) return { ok: false, reason: 'links with embedded credentials are rejected' };
  const h = x.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return { ok: false, reason: 'local addresses are rejected' };
  if (net.isIP(h) || h.startsWith('[')) return { ok: false, reason: 'raw IP addresses are rejected' };
  if (!h.includes('.')) return { ok: false, reason: 'host name looks incomplete' };
  return { ok: true, url: x.href === String(u).trim() ? x.href : String(u).trim(), host: h };
}
function localDemoEvent(url, { enabled, remoteAddress, localPort, host, getEvent }) {
  if (!enabled || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress) || typeof getEvent !== 'function') return false;
  let link;
  try { link = new URL(url); } catch { return false; }
  const match = /^\/e\/([a-z0-9-]{1,80})$/.exec(link.pathname);
  if (link.protocol !== 'http:' || link.username || link.password || link.search || link.hash ||
      !['localhost', '127.0.0.1', '[::1]'].includes(link.hostname) ||
      link.host !== host || link.port !== String(localPort) || !match) return false;
  const event = getEvent(match[1]);
  const official = safeUrl(event?.registration_url);
  return event?.status === 'open' && official.ok && /^https:/.test(event.registration_url) &&
    /(^|\.)example\.(org|com|net)$/i.test(official.host);
}
async function publicHost(host) {
  try { const r = await dns.lookup(host, { all: true }); return r.length > 0 && r.every(a => !PRIVATE.test(a.address) && a.address !== '::1' && !/^f[cd]/i.test(a.address)); } catch { return null; }
}
async function checkLink(url, timeoutMs = 7000) {
  const s = safeUrl(url); if (!s.ok) return { status: 'failed', detail: s.reason };
  const pub = await publicHost(s.host);
  if (pub === null) return { status: 'unavailable', detail: 'host could not be resolved from this server' };
  if (pub === false) return { status: 'failed', detail: 'host resolves to a private network address' };
  for (const method of ['HEAD', 'GET']) {
    try {
      const r = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'FlyerStudio-LinkCheck/1.2' } });
      if (r.status === 404 || r.status === 410) return { status: 'failed', detail: 'destination returned HTTP ' + r.status };
      if (r.status >= 200 && r.status < 400) return { status: 'verified', detail: 'destination returned HTTP ' + r.status + ' (page existence only; relevance not judged)' };
      if (method === 'HEAD' && r.status === 405) continue;
      return { status: 'unavailable', detail: 'destination returned HTTP ' + r.status + '; automated access may be blocked, which is not the same as broken' };
    } catch (e) { if (method === 'GET') return { status: 'unavailable', detail: 'could not reach destination (' + (e.name || 'error') + ')' }; }
  }
  return { status: 'unavailable', detail: 'no response' };
}
const words = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;
module.exports = { MONTHS, WEEKDAYS, hexToRgb, relLum, contrast, parseDate, parseTime, fmtTime, fmtRange, validTimeZone, localTimeExists, tzLabel, sha256, sortKeys, safeUrl, localDemoEvent, checkLink, words };
