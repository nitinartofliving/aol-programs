import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { corePath, demoKnowledge, journeySteps } from './catalog.mjs';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const CLAIM_MS = DAY_MS;
const WINDOW_DAYS = 7;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  phone_digits TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  goal TEXT NOT NULL DEFAULT '',
  consent INTEGER NOT NULL DEFAULT 0,
  consent_source TEXT NOT NULL DEFAULT '',
  do_not_contact INTEGER NOT NULL DEFAULT 0,
  next_follow_up TEXT,
  follow_up_context TEXT NOT NULL DEFAULT '',
  claimed_by TEXT,
  claimed_until INTEGER,
  source_event_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS people_phone ON people (phone_digits);
CREATE TABLE IF NOT EXISTS journey_steps (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  date TEXT NOT NULL,
  teacher TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  event_id TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS steps_person ON journey_steps (person_id);
CREATE UNIQUE INDEX IF NOT EXISTS steps_event_once ON journey_steps (person_id, event_id) WHERE event_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  outcome TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  next_follow_up TEXT,
  volunteer TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS calls_person ON calls (person_id, created_at);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  program TEXT NOT NULL,
  teacher TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  place TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS registrations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  attended INTEGER NOT NULL DEFAULT 0,
  walk_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (event_id, person_id)
) STRICT;
CREATE TABLE IF NOT EXISTS knowledge (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  alternatives TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alternatives)),
  answer TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
`;

// Digits only, with a default country code for 10-digit local numbers.
export function normalizePhone(raw, countryCode = '1') {
  const text = String(raw ?? '').trim();
  let digits = text.replace(/\D/g, '');
  if (!text.startsWith('+') && digits.length === 10 && countryCode) digits = countryCode + digits;
  return { phone: text, digits, valid: digits.length >= 8 && digits.length <= 15 };
}

function slugify(title, startsAt) {
  const [y, m, d] = startsAt.slice(0, 10).split('-').map(Number);
  const month = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${title}-${month}-${d}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'event';
}

export function addDays(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function openCareStore(file) {
  if (file !== ':memory:') {
    file = resolve(file);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    closeSync(openSync(file, 'a', 0o600));
  }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 2500; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
  db.exec(SCHEMA);

  const q = sql => db.prepare(sql);
  const nowIso = () => new Date().toISOString();
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

  // Seed SevaAssist with the demo answers once (staff can edit or delete them).
  if (!q("SELECT 1 FROM meta WHERE key = 'knowledge_seeded'").get()) {
    tx(() => {
      for (const k of demoKnowledge) {
        q('INSERT INTO knowledge (id, question, alternatives, answer, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), k.question, JSON.stringify(k.alternatives), k.answer, k.source, nowIso());
      }
      q("INSERT INTO meta (key, value) VALUES ('knowledge_seeded', '1')").run();
    });
  }

  // ---------- people ----------
  function journeyOf(steps) {
    const done = new Set(steps.map(s => s.step));
    let highest = -1;
    corePath.forEach((step, i) => { if (done.has(step)) highest = i; });
    const anyStep = steps.length > 0;
    return {
      currentStep: highest >= 0 ? corePath[highest] : anyStep ? steps[0].step : 'Potential',
      nextStep: highest + 1 < corePath.length ? corePath[highest + 1] : null,
      status: anyStep ? 'Participant' : 'Potential',
    };
  }

  const personRow = r => r && {
    id: r.id, fullName: r.full_name, phone: r.phone, phoneDigits: r.phone_digits, email: r.email, goal: r.goal,
    consent: !!r.consent, consentSource: r.consent_source, doNotContact: !!r.do_not_contact,
    nextFollowUp: r.next_follow_up, followUpContext: r.follow_up_context,
    claimedBy: r.claimed_by, claimedUntil: r.claimed_until, sourceEventId: r.source_event_id,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
  const stepsFor = id => q('SELECT * FROM journey_steps WHERE person_id = ? ORDER BY date DESC, created_at DESC').all(id)
    .map(s => ({ id: s.id, step: s.step, date: s.date, teacher: s.teacher, note: s.note, eventId: s.event_id }));
  const lastCallFor = id => q('SELECT created_at FROM calls WHERE person_id = ? ORDER BY created_at DESC LIMIT 1').get(id)?.created_at ?? null;

  function summary(r) {
    const p = personRow(r);
    const steps = stepsFor(p.id);
    const j = journeyOf(steps);
    const lastStep = steps.find(s => s.step === j.currentStep);
    return { ...p, ...j, teacher: lastStep?.teacher ?? '', lastCall: lastCallFor(p.id) };
  }

  function listPeople(search = '') {
    const like = '%' + search.trim().toLowerCase() + '%';
    const digits = search.replace(/\D/g, '');
    const rows = q(`SELECT * FROM people WHERE lower(full_name) LIKE ? OR lower(email) LIKE ? OR (? <> '' AND phone_digits LIKE ?)
      ORDER BY (next_follow_up IS NULL), next_follow_up, full_name COLLATE NOCASE LIMIT 500`).all(like, like, digits, '%' + digits + '%');
    return rows.map(summary);
  }

  function getPerson(id) {
    const r = q('SELECT * FROM people WHERE id = ?').get(id);
    if (!r) return null;
    const base = summary(r);
    return {
      ...base,
      steps: stepsFor(id),
      calls: q('SELECT * FROM calls WHERE person_id = ? ORDER BY created_at DESC').all(id)
        .map(c => ({ id: c.id, outcome: c.outcome, note: c.note, nextFollowUp: c.next_follow_up, volunteer: c.volunteer, createdAt: c.created_at })),
      events: q(`SELECT e.id, e.title, e.program, e.starts_at, e.slug, r.attended FROM registrations r JOIN events e ON e.id = r.event_id
        WHERE r.person_id = ? ORDER BY e.starts_at DESC`).all(id)
        .map(e => ({ id: e.id, title: e.title, program: e.program, startsAt: e.starts_at, slug: e.slug, attended: !!e.attended })),
    };
  }

  const findByPhone = digits => digits ? q('SELECT * FROM people WHERE phone_digits = ? ORDER BY created_at LIMIT 1').get(digits) : null;

  function createPerson(p) {
    const id = randomUUID(), at = nowIso();
    q(`INSERT INTO people (id, full_name, phone, phone_digits, email, goal, consent, consent_source, source_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, p.fullName, p.phone ?? '', p.phoneDigits ?? '', p.email ?? '', p.goal ?? '', p.consent ? 1 : 0, p.consentSource ?? '', p.sourceEventId ?? null, at, at);
    return id;
  }

  const editable = {
    fullName: 'full_name', phone: 'phone', phoneDigits: 'phone_digits', email: 'email', goal: 'goal', consent: 'consent',
    consentSource: 'consent_source', doNotContact: 'do_not_contact', nextFollowUp: 'next_follow_up', followUpContext: 'follow_up_context',
  };
  function updatePerson(id, fields) {
    const sets = [], values = [];
    for (const [k, col] of Object.entries(editable)) {
      if (!(k in fields)) continue;
      sets.push(col + ' = ?');
      const v = fields[k];
      values.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
    }
    if (fields.doNotContact) sets.push('claimed_by = NULL', 'claimed_until = NULL');
    if (!sets.length) return;
    q(`UPDATE people SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).run(...values, nowIso(), id);
  }

  const deletePerson = id => q('DELETE FROM people WHERE id = ?').run(id).changes > 0;

  function addStep(personId, s) {
    const id = randomUUID();
    q('INSERT INTO journey_steps (id, person_id, step, date, teacher, note, event_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, personId, s.step, s.date, s.teacher ?? '', s.note ?? '', s.eventId ?? null, nowIso());
    return id;
  }
  const deleteStep = (personId, stepId) => q('DELETE FROM journey_steps WHERE id = ? AND person_id = ?').run(stepId, personId).changes > 0;

  function claim(personId, volunteer, nowMs) {
    const r = q('SELECT claimed_by, claimed_until FROM people WHERE id = ?').get(personId);
    if (!r) return { missing: true };
    if (r.claimed_by && r.claimed_until > nowMs && r.claimed_by !== volunteer) return { takenBy: r.claimed_by };
    q('UPDATE people SET claimed_by = ?, claimed_until = ? WHERE id = ?').run(volunteer, nowMs + CLAIM_MS, personId);
    return { ok: true };
  }
  const release = personId => q('UPDATE people SET claimed_by = NULL, claimed_until = NULL WHERE id = ?').run(personId);

  function logCall(personId, c) {
    return tx(() => {
      const at = nowIso();
      q('INSERT INTO calls (id, person_id, outcome, note, next_follow_up, volunteer, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), personId, c.outcome, c.note ?? '', c.nextFollowUp || null, c.volunteer ?? '', at);
      q(`UPDATE people SET next_follow_up = ?, follow_up_context = ?, claimed_by = NULL, claimed_until = NULL, updated_at = ? WHERE id = ?`)
        .run(c.nextFollowUp || null, c.note ?? '', at, personId);
    });
  }

  // ---------- follow-up queue ----------
  function queue(today, nowMs) {
    const soon = addDays(today, WINDOW_DAYS);
    const freshSince = new Date(nowMs - WINDOW_DAYS * DAY_MS).toISOString();
    const rows = q('SELECT * FROM people WHERE consent = 1 AND do_not_contact = 0').all();
    const items = [];
    for (const r of rows) {
      const lastCall = lastCallFor(r.id);
      let rank, why, kind;
      if (r.next_follow_up && r.next_follow_up < today) { rank = 0; kind = 'overdue'; why = 'Your promised check-in is overdue'; }
      else if (r.next_follow_up === today) { rank = 1; kind = 'today'; why = 'You promised to check in today'; }
      else {
        const upcoming = q(`SELECT e.title, e.starts_at, r.created_at FROM registrations r JOIN events e ON e.id = r.event_id
          WHERE r.person_id = ? AND e.status = 'open' AND substr(e.starts_at, 1, 10) BETWEEN ? AND ? ORDER BY e.starts_at LIMIT 1`).get(r.id, today, soon);
        if (!lastCall && r.created_at >= freshSince) { rank = 2; kind = 'new'; why = upcoming ? `New, and registered for ${upcoming.title}. Say hello` : 'New to the circle. Say hello'; }
        else if (upcoming && (!lastCall || lastCall < upcoming.created_at)) { rank = 3; kind = 'upcoming'; why = `Coming to ${upcoming.title} on ${upcoming.starts_at.slice(0, 10)}. Say hello`; }
      }
      if (rank === undefined) continue;
      const claimedByOther = r.claimed_by && r.claimed_until > nowMs ? r.claimed_by : null;
      items.push({ ...summary(r), why, kind, rank, claimedBy: claimedByOther });
    }
    return items.sort((a, b) => a.rank - b.rank || (a.nextFollowUp ?? '').localeCompare(b.nextFollowUp ?? '') || a.fullName.localeCompare(b.fullName));
  }

  // ---------- events ----------
  const eventRow = e => e && {
    id: e.id, slug: e.slug, title: e.title, program: e.program, teacher: e.teacher, startsAt: e.starts_at,
    place: e.place, description: e.description, status: e.status, createdAt: e.created_at,
  };
  const publicEvent = e => e && { slug: e.slug, title: e.title, program: e.program, teacher: e.teacher, startsAt: e.starts_at, place: e.place, description: e.description, status: e.status };

  function listEvents() {
    return q(`SELECT e.*, (SELECT count(*) FROM registrations r WHERE r.event_id = e.id) AS registered,
      (SELECT count(*) FROM registrations r WHERE r.event_id = e.id AND r.attended = 1) AS attended FROM events e ORDER BY e.starts_at DESC`).all()
      .map(e => ({ ...eventRow(e), registered: e.registered, attended: e.attended }));
  }

  function getEvent(id) {
    const e = eventRow(q('SELECT * FROM events WHERE id = ?').get(id));
    if (!e) return null;
    e.registrations = q(`SELECT r.attended, r.walk_in, r.created_at, p.id, p.full_name, p.phone, p.consent, p.do_not_contact,
      (SELECT 1 FROM journey_steps s WHERE s.person_id = p.id AND s.event_id = r.event_id) AS completed
      FROM registrations r JOIN people p ON p.id = r.person_id WHERE r.event_id = ? ORDER BY p.full_name COLLATE NOCASE`).all(id)
      .map(r => ({ personId: r.id, fullName: r.full_name, phone: r.phone, consent: !!r.consent, doNotContact: !!r.do_not_contact,
        attended: !!r.attended, walkIn: !!r.walk_in, completed: !!r.completed, registeredAt: r.created_at }));
    return e;
  }

  const getEventBySlug = slug => q('SELECT * FROM events WHERE slug = ?').get(slug);

  function createEvent(e) {
    const base = slugify(e.title, e.startsAt);
    let slug = base;
    for (let n = 2; getEventBySlug(slug); n++) slug = `${base}-${n}`;
    const id = randomUUID();
    q('INSERT INTO events (id, slug, title, program, teacher, starts_at, place, description, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, slug, e.title, e.program, e.teacher ?? '', e.startsAt, e.place ?? '', e.description ?? '', e.status === 'closed' ? 'closed' : 'open', nowIso());
    return getEvent(id);
  }

  // The slug never changes, so printed QR codes keep working.
  function updateEvent(id, f) {
    const cols = { title: 'title', program: 'program', teacher: 'teacher', startsAt: 'starts_at', place: 'place', description: 'description', status: 'status' };
    const sets = [], values = [];
    for (const [k, col] of Object.entries(cols)) if (k in f) { sets.push(col + ' = ?'); values.push(f[k]); }
    if (sets.length) q(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
    return getEvent(id);
  }
  const deleteEvent = id => q('DELETE FROM events WHERE id = ?').run(id).changes > 0;

  // Find (by phone) or create the person, never removing consent they gave before.
  function upsertPublicPerson(event, p) {
    const existing = findByPhone(p.phoneDigits);
    if (existing) {
      const fields = {};
      if (p.consent && !existing.consent) { fields.consent = true; fields.consentSource = 'qr_event'; }
      if (p.goal && !existing.goal) fields.goal = p.goal;
      if (p.email && !existing.email) fields.email = p.email;
      updatePerson(existing.id, fields);
      return existing.id;
    }
    return createPerson({ ...p, consentSource: p.consent ? 'qr_event' : '', sourceEventId: event.id });
  }

  function register(event, p) {
    return tx(() => {
      const personId = upsertPublicPerson(event, p);
      const had = q('SELECT 1 FROM registrations WHERE event_id = ? AND person_id = ?').get(event.id, personId);
      if (had) return { alreadyRegistered: true };
      q('INSERT INTO registrations (id, event_id, person_id, created_at) VALUES (?, ?, ?, ?)').run(randomUUID(), event.id, personId, nowIso());
      return { alreadyRegistered: false };
    });
  }

  function checkIn(event, p) {
    return tx(() => {
      const personId = upsertPublicPerson(event, p);
      const had = q('SELECT attended FROM registrations WHERE event_id = ? AND person_id = ?').get(event.id, personId);
      if (had) q('UPDATE registrations SET attended = 1 WHERE event_id = ? AND person_id = ?').run(event.id, personId);
      else q('INSERT INTO registrations (id, event_id, person_id, attended, walk_in, created_at) VALUES (?, ?, ?, 1, 1, ?)').run(randomUUID(), event.id, personId, nowIso());
      if (event.program === 'Intro Talk') completeFor(event, personId);
      return { alreadyCheckedIn: !!had?.attended, walkIn: !had };
    });
  }

  function setAttended(eventId, personId, attended) {
    const ev = q('SELECT * FROM events WHERE id = ?').get(eventId);
    const changed = q('UPDATE registrations SET attended = ? WHERE event_id = ? AND person_id = ?').run(attended ? 1 : 0, eventId, personId).changes > 0;
    if (changed && attended && ev.program === 'Intro Talk') completeFor(ev, personId);
    return changed;
  }

  function completeFor(ev, personId) {
    if (!journeySteps.includes(ev.program)) return false;
    return q(`INSERT OR IGNORE INTO journey_steps (id, person_id, step, date, teacher, note, event_id, created_at) VALUES (?, ?, ?, ?, ?, '', ?, ?)`)
      .run(randomUUID(), personId, ev.program, ev.starts_at.slice(0, 10), ev.teacher, ev.id, nowIso()).changes > 0;
  }

  // Mark a course completed for the given people (or everyone who attended).
  function markCompleted(eventId, personIds) {
    const ev = q('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!ev) return null;
    if (!journeySteps.includes(ev.program)) return { notJourneyStep: true };
    return tx(() => {
      const ids = personIds ?? q('SELECT person_id FROM registrations WHERE event_id = ? AND attended = 1').all(eventId).map(r => r.person_id);
      let added = 0;
      for (const id of ids) {
        if (!q('SELECT 1 FROM registrations WHERE event_id = ? AND person_id = ?').get(eventId, id)) continue;
        q('UPDATE registrations SET attended = 1 WHERE event_id = ? AND person_id = ?').run(eventId, id);
        if (completeFor(ev, id)) added++;
      }
      return { added };
    });
  }

  // ---------- SevaAssist knowledge ----------
  const kbRow = k => ({ id: k.id, question: k.question, alternatives: JSON.parse(k.alternatives), answer: k.answer, source: k.source, updatedAt: k.updated_at });
  const listKnowledge = () => q('SELECT * FROM knowledge ORDER BY question COLLATE NOCASE').all().map(kbRow);
  function saveKnowledge(id, k) {
    const at = nowIso();
    if (id) {
      return q('UPDATE knowledge SET question = ?, alternatives = ?, answer = ?, source = ?, updated_at = ? WHERE id = ?')
        .run(k.question, JSON.stringify(k.alternatives), k.answer, k.source, at, id).changes > 0 ? id : null;
    }
    id = randomUUID();
    q('INSERT INTO knowledge (id, question, alternatives, answer, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, k.question, JSON.stringify(k.alternatives), k.answer, k.source, at);
    return id;
  }
  const deleteKnowledge = id => q('DELETE FROM knowledge WHERE id = ?').run(id).changes > 0;

  return {
    listPeople, getPerson, findByPhone, createPerson, updatePerson, deletePerson, addStep, deleteStep,
    claim, release, logCall, queue,
    listEvents, getEvent, getEventBySlug, publicEvent, createEvent, updateEvent, deleteEvent,
    register, checkIn, setAttended, markCompleted,
    listKnowledge, saveKnowledge, deleteKnowledge,
    close: () => db.close(),
  };
}
