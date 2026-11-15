// People & Journeys (Care Loop) and SevaAssist.
//
// Three handlers, mounted by the main server:
//   staff  -> /care/  staff app + API (volunteer or manager token)
//   pub    -> /e/     public event sign-up and venue check-in pages (no login)
//   ask    -> /ask/   SevaAssist questions (staff token); managers edit answers

import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eventPrograms, journeySteps, limits, outcomes } from './catalog.mjs';
import { findAnswer } from './match.mjs';
import { normalizePhone, openCareStore } from './store.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const { encodeQR } = createRequire(import.meta.url)('../flyer/engine/qr.js');

const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/;
const digest = t => createHash('sha256').update(t).digest();
const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const dateTimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
};

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }
const bad = (message, field) => new HttpError(400, message, field ? { field } : undefined);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...security, ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new HttpError(415, 'Send JSON.');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 16384) throw new HttpError(413, 'Too much data.'); chunks.push(c); }
  try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch {}
  throw bad('This could not be read.');
}

function text(v, max, name, { required = false } = {}) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw bad(`${name} must be text.`, name);
  v = v.replace(/\r\n?/g, '\n').trim();
  if (required && !v) throw bad(`${name} is required.`, name);
  if (v.length > max) throw bad(`${name} must be ${max} characters or fewer.`, name);
  return v;
}
const optDate = (v, name) => { if (v == null || v === '') return null; if (typeof v !== 'string' || !dateRe.test(v)) throw bad(`${name} must be a date.`, name); return v; };
const oneOf = (v, list, name) => { if (!list.includes(v)) throw bad(`Choose a valid ${name}.`, name); return v; };

async function serveFile(req, res, root, rel, extra = {}) {
  const file = resolve(root, '.' + normalize('/' + rel));
  let info;
  try { if (!file.startsWith(root + sep)) throw 0; info = await stat(file); if (!info.isFile()) throw 0; } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...security }); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Content-Length': info.size, 'Cache-Control': 'no-cache', ...security, ...extra });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

export function qrSvg(textValue, caption = '') {
  const { modules, size } = encodeQR(textValue);
  const quiet = 4, full = size + quiet * 2, capH = caption ? 6 : 0;
  let path = '';
  modules.forEach((row, y) => row.forEach((on, x) => { if (on) path += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
  const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${full} ${full + capH}" width="${(full) * 10}" height="${(full + capH) * 10}" shape-rendering="crispEdges">` +
    `<rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${path}"/>` +
    (caption ? `<text x="${full / 2}" y="${full + 2.5}" text-anchor="middle" font-family="Arial, sans-serif" font-size="3.2" fill="#000">${esc(caption)}</text>` : '') +
    '</svg>';
}

export function todayIn(timeZone, ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

export function createCareApp({ env = process.env, now = Date.now, log = console } = {}) {
  const tokens = [];
  for (const [name, role] of [['AOL_MANAGER_TOKEN', 'manager'], ['AOL_VOLUNTEER_TOKEN', 'volunteer']]) {
    const v = env[name];
    if (!v) continue;
    if (!tokenPattern.test(v)) throw new Error(name + ' must have 32 to 128 URL-safe characters.');
    tokens.push({ role, hash: digest(v) });
  }
  const timeZone = env.AOL_TIME_ZONE || 'America/Edmonton';
  const countryCode = (env.AOL_PHONE_COUNTRY_CODE ?? '1').replace(/\D/g, '');
  const store = openCareStore(env.AOL_CARE_DB_PATH || 'data/care.sqlite');
  const staffRoot = resolve(here, 'public', 'staff');
  const eventRoot = resolve(here, 'public', 'event');
  const askRoot = resolve(here, 'public', 'ask');
  const sharedRoot = resolve(here, 'public', 'shared');
  const postsPerMinute = Number(env.AOL_POSTS_PER_MINUTE) || 120;
  let bucket = -1, posts = 0;

  function auth(req, minimum = 'volunteer') {
    const m = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(req.headers.authorization ?? '');
    const supplied = m && digest(m[1]);
    const found = supplied && tokens.find(t => timingSafeEqual(t.hash, supplied));
    if (!found) throw new HttpError(401, 'Sign in with your staff token.');
    if (minimum === 'manager' && found.role !== 'manager') throw new HttpError(403, 'Only a manager can do this.');
    let name = '';
    try { name = decodeURIComponent(req.headers['x-volunteer-name'] ?? ''); } catch {}
    name = name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40) || (found.role === 'manager' ? 'Manager' : 'Volunteer');
    return { role: found.role, name };
  }

  const personInput = (b, partial) => {
    const out = {};
    if (!partial || 'fullName' in b) out.fullName = text(b.fullName, limits.name, 'Name', { required: true });
    if (!partial || 'phone' in b) {
      const phone = text(b.phone, limits.phone, 'Phone');
      const n = normalizePhone(phone, countryCode);
      if (phone && !n.valid) throw bad('Enter a phone number with 8 to 15 digits.', 'phone');
      out.phone = phone; out.phoneDigits = phone ? n.digits : '';
    }
    if (!partial || 'email' in b) out.email = text(b.email, limits.email, 'Email');
    if (!partial || 'goal' in b) out.goal = text(b.goal, limits.goal, 'Goal');
    if (!partial || 'consent' in b) out.consent = b.consent === true;
    if ('doNotContact' in b) out.doNotContact = b.doNotContact === true;
    if ('nextFollowUp' in b) out.nextFollowUp = optDate(b.nextFollowUp, 'nextFollowUp');
    if ('followUpContext' in b) out.followUpContext = text(b.followUpContext, limits.note, 'Note');
    return out;
  };

  const eventInput = (b, partial) => {
    const out = {};
    if (!partial || 'program' in b) out.program = oneOf(b.program, eventPrograms, 'program');
    if (!partial || 'title' in b) out.title = text(b.title, limits.title, 'Title', { required: true });
    if (!partial || 'startsAt' in b) { if (typeof b.startsAt !== 'string' || !dateTimeRe.test(b.startsAt)) throw bad('Choose a date and time.', 'startsAt'); out.startsAt = b.startsAt; }
    if (!partial || 'teacher' in b) out.teacher = text(b.teacher, limits.teacher, 'Teacher');
    if (!partial || 'place' in b) out.place = text(b.place, limits.place, 'Place');
    if (!partial || 'description' in b) out.description = text(b.description, limits.description, 'Description');
    if ('status' in b) out.status = oneOf(b.status, ['open', 'closed'], 'status');
    return out;
  };

  function wrap(handler) {
    return async (req, res) => {
      try { await handler(req, res); } catch (e) {
        if (e instanceof HttpError) { req.resume(); return send(res, e.status, { error: e.message, ...e.extra }); }
        log.error('Care request failed:', e);
        if (!res.headersSent) send(res, 500, { error: 'Something went wrong. Please try again.' }); else res.end();
      }
    };
  }

  // ---------- staff app ----------
  const staff = wrap(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname, method = req.method;
    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      if (path.startsWith('/shared/')) return serveFile(req, res, sharedRoot, path.slice(8));
      return serveFile(req, res, staffRoot, path === '/' ? 'index.html' : path);
    }
    const me = auth(req);
    const today = todayIn(timeZone, now());
    const route = method + ' ' + path;
    let m;

    if (route === 'GET /api/me') return send(res, 200, { role: me.role, name: me.name, today, timeZone, journeySteps, eventPrograms, outcomes });
    if (route === 'GET /api/queue') return send(res, 200, { today, items: store.queue(today, now()) });
    if (route === 'GET /api/people') return send(res, 200, store.listPeople(url.searchParams.get('q') ?? ''));
    if (route === 'POST /api/people') {
      const p = personInput(await readJson(req), false);
      const dup = p.phoneDigits && store.findByPhone(p.phoneDigits);
      if (dup) throw new HttpError(409, `${dup.full_name} already has this phone number.`, { personId: dup.id });
      const id = store.createPerson({ ...p, consentSource: p.consent ? 'staff_added' : '' });
      return send(res, 201, store.getPerson(id));
    }
    if ((m = path.match(/^\/api\/people\/([\w-]{1,64})$/))) {
      const id = m[1];
      if (!store.getPerson(id)) throw new HttpError(404, 'This person was not found.');
      if (method === 'GET') return send(res, 200, store.getPerson(id));
      if (method === 'PATCH') {
        const p = personInput(await readJson(req), true);
        if (p.phoneDigits) { const dup = store.findByPhone(p.phoneDigits); if (dup && dup.id !== id) throw new HttpError(409, `${dup.full_name} already has this phone number.`); }
        if ('consent' in p) p.consentSource = p.consent ? 'staff_confirmed' : '';
        store.updatePerson(id, p);
        return send(res, 200, store.getPerson(id));
      }
      if (method === 'DELETE') { auth(req, 'manager'); store.deletePerson(id); return send(res, 200, { ok: true }); }
    }
    if ((m = path.match(/^\/api\/people\/([\w-]{1,64})\/(steps|claim|calls)(?:\/([\w-]{1,64}))?$/))) {
      const [, id, what, sub] = m;
      const person = store.getPerson(id);
      if (!person) throw new HttpError(404, 'This person was not found.');
      if (what === 'steps' && method === 'POST' && !sub) {
        const b = await readJson(req);
        const step = oneOf(b.step, journeySteps, 'step');
        const date = optDate(b.date, 'date');
        if (!date) throw bad('Choose the date.', 'date');
        store.addStep(id, { step, date, teacher: text(b.teacher, limits.teacher, 'Teacher'), note: text(b.note, limits.note, 'Note') });
        return send(res, 201, store.getPerson(id));
      }
      if (what === 'steps' && method === 'DELETE' && sub) { store.deleteStep(id, sub); return send(res, 200, store.getPerson(id)); }
      if (what === 'claim' && method === 'POST') {
        if (person.doNotContact || !person.consent) throw new HttpError(409, 'This person has not agreed to be contacted.');
        const r = store.claim(id, me.name, now());
        if (r.takenBy) throw new HttpError(409, `${r.takenBy} is already contacting this person.`);
        return send(res, 200, { ok: true });
      }
      if (what === 'claim' && method === 'DELETE') { store.release(id); return send(res, 200, { ok: true }); }
      if (what === 'calls' && method === 'POST') {
        const b = await readJson(req);
        store.logCall(id, { outcome: oneOf(b.outcome, outcomes, 'outcome'), note: text(b.note, limits.note, 'Note'), nextFollowUp: optDate(b.nextFollowUp, 'nextFollowUp'), volunteer: me.name });
        return send(res, 201, store.getPerson(id));
      }
    }
    if (route === 'GET /api/events') return send(res, 200, store.listEvents());
    if (route === 'POST /api/events') return send(res, 201, store.createEvent(eventInput(await readJson(req), false)));
    if ((m = path.match(/^\/api\/events\/([\w-]{1,64})(?:\/(attendance|complete))?$/))) {
      const [, id, what] = m;
      if (!store.getEvent(id)) throw new HttpError(404, 'This event was not found.');
      if (!what && method === 'GET') return send(res, 200, store.getEvent(id));
      if (!what && method === 'PATCH') return send(res, 200, store.updateEvent(id, eventInput(await readJson(req), true)));
      if (!what && method === 'DELETE') { auth(req, 'manager'); store.deleteEvent(id); return send(res, 200, { ok: true }); }
      if (what === 'attendance' && method === 'POST') {
        const b = await readJson(req);
        store.setAttended(id, String(b.personId ?? ''), b.attended === true);
        return send(res, 200, store.getEvent(id));
      }
      if (what === 'complete' && method === 'POST') {
        const b = await readJson(req);
        const ids = Array.isArray(b.personIds) ? b.personIds.map(String).slice(0, 1000) : null;
        const r = store.markCompleted(id, ids);
        if (r.notJourneyStep) throw bad('This event is not a journey step, so there is nothing to complete.');
        return send(res, 200, { ...store.getEvent(id), added: r.added });
      }
    }
    throw new HttpError(404, 'This page is unavailable.');
  });

  // ---------- public event pages ----------
  const origin = req => {
    if (env.AOL_PUBLIC_ORIGIN) return env.AOL_PUBLIC_ORIGIN.replace(/\/$/, '');
    const proto = (req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' ? 'https' : 'http';
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim().replace(/[^\w.:\-[\]]/g, '');
    return `${proto}://${host}`;
  };

  const pub = wrap(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname, method = req.method;
    let m;
    if ((m = path.match(/^\/api\/events\/([a-z0-9-]{1,80})(?:\/(register|checkin))?$/))) {
      const ev = store.getEventBySlug(m[1]);
      if (!ev) throw new HttpError(404, 'This event link is not valid.');
      if (!m[2] && method === 'GET') return send(res, 200, store.publicEvent(ev));
      if (m[2] && method === 'POST') {
        const minute = Math.floor(now() / 60000);
        if (minute !== bucket) { bucket = minute; posts = 0; }
        if (++posts > postsPerMinute) throw new HttpError(429, 'Please try again in a minute.');
        const b = await readJson(req);
        if (b.website) return send(res, 200, { ok: true }); // honeypot: quietly ignore bots
        if (m[2] === 'register' && ev.status !== 'open') throw new HttpError(409, 'Registration for this event is closed.');
        const fullName = text(b.fullName, limits.name, 'Name', { required: true });
        const phone = text(b.phone, limits.phone, 'Phone', { required: true });
        const n = normalizePhone(phone, countryCode);
        if (!n.valid) throw bad('Enter a phone number with 8 to 15 digits.', 'phone');
        const p = { fullName, phone, phoneDigits: n.digits, email: text(b.email, limits.email, 'Email'), goal: text(b.goal, limits.goal, 'Goal'), consent: b.consent === true };
        const r = m[2] === 'register' ? store.register(ev, p) : store.checkIn(ev, p);
        return send(res, 200, { ok: true, ...r, event: store.publicEvent(ev) });
      }
      throw new HttpError(405, 'Method not allowed.');
    }
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    if (path.startsWith('/assets/')) return serveFile(req, res, eventRoot, path.slice(8));
    if ((m = path.match(/^\/([a-z0-9-]{1,80})(\/in)?\/qr\.svg$/))) {
      const ev = store.getEventBySlug(m[1]);
      if (!ev) throw new HttpError(404, 'This event link is not valid.');
      const link = `${origin(req)}/e/${ev.slug}${m[2] ? '/in' : ''}`;
      const svg = qrSvg(link, m[2] ? 'Scan to check in' : 'Scan to register');
      const file = `${ev.slug}${m[2] ? '-checkin' : '-register'}-qr.svg`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache', ...security,
        ...(url.searchParams.has('download') ? { 'Content-Disposition': `attachment; filename="${file}"` } : {}) });
      return res.end(svg);
    }
    if (/^\/[a-z0-9-]{1,80}(\/in)?\/?$/.test(path)) return serveFile(req, res, eventRoot, 'index.html');
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...security });
    res.end('Not found');
  });

  // ---------- SevaAssist ----------
  const knowledgeInput = b => ({
    question: text(b.question, limits.question, 'Question', { required: true }),
    alternatives: (Array.isArray(b.alternatives) ? b.alternatives : []).map(a => text(a, limits.question, 'Alternative question')).filter(Boolean).slice(0, 20),
    answer: text(b.answer, limits.answer, 'Answer', { required: true }),
    source: text(b.source, limits.source, 'Source', { required: true }),
  });

  const ask = wrap(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname, method = req.method;
    if (!path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
      if (path.startsWith('/shared/')) return serveFile(req, res, sharedRoot, path.slice(8));
      return serveFile(req, res, askRoot, path === '/' ? 'index.html' : path);
    }
    const me = auth(req);
    if (method === 'GET' && path === '/api/me') return send(res, 200, { role: me.role, name: me.name });
    if (method === 'POST' && path === '/api/ask') {
      const question = text((await readJson(req)).question, limits.question, 'Question', { required: true });
      const r = findAnswer(question, store.listKnowledge());
      return send(res, 200, r.found
        ? { found: true, answer: r.entry.answer, source: r.entry.source, matched: r.entry.question }
        : { found: false, answer: "I couldn't find an approved answer to that question.", source: 'No matching source found' });
    }
    if (method === 'GET' && path === '/api/knowledge') return send(res, 200, store.listKnowledge());
    if (method === 'POST' && path === '/api/knowledge') { auth(req, 'manager'); const id = store.saveKnowledge(null, knowledgeInput(await readJson(req))); return send(res, 201, { id }); }
    const m = path.match(/^\/api\/knowledge\/([\w-]{1,64})$/);
    if (m && method === 'PUT') { auth(req, 'manager'); if (!store.saveKnowledge(m[1], knowledgeInput(await readJson(req)))) throw new HttpError(404, 'Not found.'); return send(res, 200, { id: m[1] }); }
    if (m && method === 'DELETE') { auth(req, 'manager'); store.deleteKnowledge(m[1]); return send(res, 200, { ok: true }); }
    throw new HttpError(404, 'This page is unavailable.');
  });

  return { staff, pub, ask, store, close: () => store.close() };
}
