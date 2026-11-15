'use strict';
// Teams A, B, C, F, G: intake, validation, programme/claims, copy, asset selection, QR planning.
const U = require('./util');
const A = require('./assets');
const { MAX_BYTES, qrLayout } = require('./qr');

const BASE_MOODS = { nature: 'Nature', peace: 'Peace', happy: 'Happy', joy: 'Joy' };
const BANNED = /\b(cures?|cured|guarantee[sd]?|scientifically proven|clinically proven|proven to|heals?|miracle|100%|risk[- ]free|limited seats|last chance|hurry)\b/i;
const INJECTION = /(ignore (all |any )?(previous|prior|above)|system prompt|you are now|administrator|admin mode|developer mode|demo mode|override|disable (the )?(qr|check|gate|review)|skip (the )?(review|qa|gate))/i;
const EXAMPLE_HOST = /(^|\.)example\.(org|com|net)$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const bool = v => v === true || (typeof v === 'string' && ['true', '1', 'on', 'yes'].includes(v.trim().toLowerCase())) || v === 1;
const str = v => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();
const strML = v => (v === null || v === undefined ? '' : String(v)).replace(/\r/g, '').trim();

function normalizeRequest(raw, cfg) {
  raw = raw || {};
  const off = raw.offering || {}, im = raw.imagery || {}, sc = raw.schedule || {}, lo = raw.location || {}, ac = raw.action || {};
  const moods = [], seen = new Set();
  for (const m of (raw.mood && raw.mood.selected) || []) { const t = str(m); if (!t) continue; const k = t.toLowerCase(); if (!seen.has(k)) { seen.add(k); moods.push(BASE_MOODS[k] || t); } }
  const includeCity = bool(im.include_city_photo);
  const dtype = str(ac.destination_type).toLowerCase();
  return {
    request_id: str(raw.request_id) || null,
    mode: raw.mode === 'revise' ? 'revise' : 'create',
    offering: { raw_text: strML(off.raw_text), programme_id: str(off.programme_id) || null, approved_description: strML(off.approved_description) || null },
    mood: { selected: moods.slice(0, 4) },
    imagery: { include_gurudev: bool(im.include_gurudev), include_city_photo: includeCity, city_photo_asset_id: includeCity ? str(im.city_photo_asset_id) || null : null, city_photo_metrics: includeCity && im.city_photo_metrics && typeof im.city_photo_metrics === 'object' ? { sharpness: +im.city_photo_metrics.sharpness || null, source: 'measured in the browser at upload' } : null },
    schedule: { timezone: str(sc.timezone) || null, sessions: (Array.isArray(sc.sessions) ? sc.sessions : []).map(s => ({ date: str(s && s.date), start_time: str(s && s.start_time), end_time: str(s && s.end_time) || null })).filter(s => s.date || s.start_time) },
    location: { delivery_mode: ['in_person', 'online', 'hybrid'].includes(str(lo.delivery_mode)) ? str(lo.delivery_mode) : null, city: str(lo.city) || null, venue: str(lo.venue) || null, address: str(lo.address) || null, on_course_page: bool(lo.on_course_page) },
    contacts: (Array.isArray(raw.contacts) ? raw.contacts : []).map(c => ({ name: str(c && c.name), phone: str(c && c.phone), email: str(c && c.email) })).filter(c => c.name || c.phone || c.email).slice(0, 3),
    action: { include_qr: bool(ac.include_qr), destination_url: str(ac.destination_url) || null, destination_type: ['registration', 'information', 'enquiry'].includes(dtype) ? dtype : null },
    format: str(raw.format) || cfg.default_format,
    extra_notes: strML(raw.extra_notes),
    revision: { base_artifact_id: raw.revision && raw.revision.base_artifact_id ? str(raw.revision.base_artifact_id) : null, requested_changes: Array.isArray(raw.revision && raw.revision.requested_changes) ? raw.revision.requested_changes.map(str) : [], locked_elements: Array.isArray(raw.revision && raw.revision.locked_elements) ? raw.revision.locked_elements.map(str) : [] }
  };
}

function matchProgramme(text, registry) {
  const t = text.toLowerCase().replace(/\s+/g, ' ');
  for (const p of registry.programmes || []) { const names = [p.display_name, ...(p.aliases || [])].map(x => String(x).toLowerCase()); if (names.some(n => n && (t === n || t.split('\n')[0].trim() === n))) return p; }
  return null;
}
function sentences(text) { return (text.replace(/\s+/g, ' ').match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || []).map(s => s.trim()).filter(Boolean); }

function moodPlan(selected, cfg) {
  const keys = selected.map(m => m.toLowerCase()).filter(m => BASE_MOODS[m]);
  const primary = keys[0] || 'peace', supporting = keys[1] || null;
  const pal = cfg.palette;
  const accent = primary === 'happy' ? pal.accent_stone : pal.accent_sage;
  return { primary, supporting, unknown: selected.filter(m => !BASE_MOODS[m.toLowerCase()]), accent, decor: primary === 'nature' || supporting === 'nature' ? 'sprig' : primary === 'happy' ? 'sun' : primary === 'joy' ? 'light' : 'rule', resolved_direction: `${BASE_MOODS[primary]} expression${supporting ? ' with a ' + BASE_MOODS[supporting].toLowerCase() + ' influence' : ''} on a calm, airy base` };
}

// Chronological, display-ready session lines.
function sessionLines(sessions, tz, currentYear) {
  const parsed = sessions.map(s => ({ s, d: U.parseDate(s.date), t: U.parseTime(s.start_time), e: s.end_time ? U.parseTime(s.end_time) : null }));
  const years = new Set(parsed.map(p => p.d && p.d.y)); const withYear = years.size > 1 || [...years].some(y => y !== currentYear);
  return parsed.map(p => ({ key: p.s.date + 'T' + p.s.start_time, text: `${p.d.weekday}, ${p.d.month} ${p.d.d}${withYear ? ', ' + p.d.y : ''} · ${U.fmtRange(p.t, p.e)}`, date: p.s.date, start: p.s.start_time, end: p.s.end_time }));
}

async function plan(raw, ctx) {
  const { cfg, profile, registry, inv, now, llm, uploads } = ctx;
  const demo = profile === 'demo';
  const rq = normalizeRequest(raw, cfg);
  const issues = [], questions = [], assumptions = [], checks = [], ledgerFacts = [];
  const add = (severity, owner, problem, fix, field, question) => { issues.push({ severity, owner, problem, required_fix: fix, verification_status: severity === 'BLOCKER' ? 'OPEN' : 'RESOLVED_OR_RECORDED' }); if (severity === 'BLOCKER' && field) questions.push({ field, question: question || fix, reason: problem }); };
  const check = (id, mandatory, status, observed, method, team) => checks.push({ id, mandatory, status, observed_result: observed, evidence_reference: 'host:plan', method, responsible_team: team });
  const currentYear = now.getUTCFullYear();
  const today = U.parseDate(now.toISOString().slice(0, 10));

  // ---- Team A: offering ----
  const reg = rq.offering.programme_id ? (registry.programmes || []).find(p => p.id === rq.offering.programme_id) : matchProgramme(rq.offering.raw_text, registry);
  let displayName = '', description = rq.offering.approved_description;
  if (reg) { displayName = reg.display_name; description = description || reg.description || null; if (!rq.offering.programme_id) rq.offering.programme_id = reg.id; }
  else {
    const lines = rq.offering.raw_text.split('\n').map(str).filter(Boolean);
    displayName = lines[0] || '';
    if (lines.length > 1 && !description) description = lines.slice(1).join(' ');
  }
  displayName = displayName.replace(/[.:;,\s]+$/, '');
  if (!displayName) add('BLOCKER', 'Brief and Requirements Manager', 'The offering is empty.', 'Describe what the flyer is for.', 'offering.raw_text', 'What is the flyer for? Enter the course or event name.');
  else if (displayName.length > 90 || U.words(displayName) > 14) add('BLOCKER', 'Brief and Requirements Manager', 'The first line is too long to use as an accurate title.', 'Put the exact course name on the first line.', 'offering.raw_text', 'What exact course name should appear as the title? (first line, under 90 characters)');
  if (!reg && displayName) assumptions.push('No approved registry entry matched, so the title is the first line you entered and no programme details were added.');
  rq.offering.display_name = displayName || null;

  // ---- Team A: schedule ----
  const sess = rq.schedule.sessions, goodSessions = [];
  if (!sess.length) add('BLOCKER', 'Schedule and Contact Verifier', 'No session dates were supplied.', 'Add at least one date and start time.', 'schedule.sessions', 'What are the course dates and start times?');
  if (sess.length > 6) add('BLOCKER', 'Schedule and Contact Verifier', 'More than six sessions cannot be shown readably on one flyer.', 'Reduce to six sessions or publish a schedule link.', 'schedule.sessions', 'Which six sessions should appear? Longer schedules fit better on the course page.');
  const tz = rq.schedule.timezone;
  if (tz && !U.validTimeZone(tz)) add('BLOCKER', 'Schedule and Contact Verifier', `"${tz}" is not a recognised time zone.`, 'Choose a listed time zone.', 'schedule.timezone', 'Which time zone applies to these times?');
  const seen = new Set();
  sess.forEach((s, i) => {
    const n = i + 1, d = U.parseDate(s.date), t = U.parseTime(s.start_time), e = s.end_time ? U.parseTime(s.end_time) : null;
    if (!d) return add('BLOCKER', 'Schedule and Contact Verifier', `Session ${n} has an invalid date.`, 'Enter a real calendar date.', `schedule.sessions[${i}].date`, `Session ${n}: what is the correct date?`);
    if (!t) return add('BLOCKER', 'Schedule and Contact Verifier', `Session ${n} has no valid start time.`, 'Enter a start time.', `schedule.sessions[${i}].start_time`, `Session ${n}: what is the start time?`);
    if (s.end_time && !e) return add('BLOCKER', 'Schedule and Contact Verifier', `Session ${n} has an invalid end time.`, 'Fix or clear the end time.', `schedule.sessions[${i}].end_time`, `Session ${n}: what is the end time? (it can be left blank)`);
    if (e && e.mins <= t.mins) return add('BLOCKER', 'Schedule and Contact Verifier', `Session ${n} ends at or before its start time.`, 'Confirm the end time.', `schedule.sessions[${i}].end_time`, `Session ${n}: the end time is not after the start time. Which is correct?`);
    if (d.key < today.key) { if (demo) add('NOTE', 'Schedule and Contact Verifier', `Session ${n} is in the past (accepted for a demo).`, 'None for a sample.'); else return add('BLOCKER', 'Schedule and Contact Verifier', `Session ${n} (${d.key}) is in the past.`, 'Confirm the year and date.', `schedule.sessions[${i}].date`, `Session ${n}: this date has passed. What is the correct date?`); }
    if (tz && U.validTimeZone(tz) && !U.localTimeExists(tz, d, t)) return add('BLOCKER', 'Schedule and Contact Verifier', `Session ${n}: ${s.start_time} does not exist on ${d.key} in ${tz} because of a clock change.`, 'Choose a start time that exists.', `schedule.sessions[${i}].start_time`, `Session ${n}: that local time is skipped by the clock change. What start time is intended?`);
    const k = s.date + s.start_time; if (seen.has(k)) return add('NOTE', 'Schedule and Contact Verifier', `Session ${n} duplicates an earlier session and was removed.`, 'None.'); seen.add(k);
    goodSessions.push(s);
  });
  goodSessions.sort((a, b) => (a.date + a.start_time).localeCompare(b.date + b.start_time));
  rq.schedule.sessions = goodSessions;

  // ---- Team A: location ----
  const L = rq.location;
  if (!L.delivery_mode) add('BLOCKER', 'Brief and Requirements Manager', 'Delivery mode is missing.', 'Choose in person, online or hybrid.', 'location.delivery_mode', 'Is the course in person, online, or both?');
  if (L.delivery_mode && L.delivery_mode !== 'online') {
    if (!L.city) add('BLOCKER', 'Brief and Requirements Manager', 'City is missing for an in-person event.', 'Enter the city.', 'location.city', 'In which city is the course held?');
    if (!L.venue && !L.address && !L.on_course_page) add('BLOCKER', 'Brief and Requirements Manager', 'No venue or address, and the venue is not marked as shown on the course page.', 'Enter a venue or address, or confirm it is on the course page.', 'location.venue', 'Where is the venue? Enter a venue name or address.');
    if (L.on_course_page && !rq.action.destination_url) add('BLOCKER', 'Brief and Requirements Manager', 'The venue is marked as shown on the course page, but no link was supplied.', 'Add the course link.', 'action.destination_url', 'Add the course page link where the venue is listed.');
  }
  if (L.delivery_mode && L.delivery_mode !== 'in_person' && !tz) add('BLOCKER', 'Schedule and Contact Verifier', 'Online times need a time zone.', 'Choose the time zone.', 'schedule.timezone', 'Which time zone are the online times in?');

  // ---- Team A: contacts, action ----
  rq.contacts.forEach((c, i) => {
    const n = i + 1;
    if (c.email && !EMAIL.test(c.email)) add('BLOCKER', 'Schedule and Contact Verifier', `Contact ${n}: the email address looks incomplete.`, 'Correct the email.', `contacts[${i}].email`, `Contact ${n}: what is the correct email address?`);
    if (c.phone) { const digits = c.phone.replace(/\D/g, ''); if (digits.length < 7 || digits.length > 15 || /[^\d\s().+\-x]/i.test(c.phone)) add('BLOCKER', 'Schedule and Contact Verifier', `Contact ${n}: the phone number does not look like a valid number.`, 'Correct the phone number.', `contacts[${i}].phone`, `Contact ${n}: what is the correct phone number?`); }
    if (demo) { if (c.email && EMAIL.test(c.email) && !EXAMPLE_HOST.test(c.email.split('@')[1])) add('BLOCKER', 'Schedule and Contact Verifier', `Contact ${n}: demo mode accepts only fictional example.org addresses.`, 'Use an example.org address.', `contacts[${i}].email`, `Contact ${n}: use a fictional address such as sam@example.org for the demo.`); if (c.phone && !/555/.test(c.phone)) add('NOTE', 'Schedule and Contact Verifier', `Contact ${n}: use a fictional 555 number in demos.`, 'Use a 555 number.'); }
  });
  let url = rq.action.destination_url, urlOk = false;
  if (url) {
    const su = U.safeUrl(url);
    if (demo && ctx.isLocalDemoEvent?.(url)) urlOk = true;
    else if (!su.ok) add('BLOCKER', 'Link and QR Specialist', `The link was rejected: ${su.reason}.`, 'Provide a complete public https link. Local demo event links require a fictional example.org official link.', 'action.destination_url', 'Use a public event link, or a local demo event with an example.org registration link.');
    else if (demo && !EXAMPLE_HOST.test(su.host)) add('BLOCKER', 'Link and QR Specialist', 'Demo mode never mixes real links with fictional events.', 'Use an example.org link.', 'action.destination_url', 'Use a fictional link such as https://example.org/sample-course for the demo.');
    else urlOk = true;
  }
  if (rq.action.include_qr) {
    if (!url) add('BLOCKER', 'Link and QR Specialist', 'A QR code was requested without a link.', 'Add the destination link or turn the QR off.', 'action.destination_url', 'What link should the QR code open?');
    else if (urlOk && Buffer.byteLength(url) > MAX_BYTES) add('BLOCKER', 'Link and QR Specialist', `The link is ${Buffer.byteLength(url)} bytes; the largest supported QR holds ${MAX_BYTES}. Links are never shortened or altered.`, 'Provide a shorter official link.', 'action.destination_url', 'Is there a shorter official link? (no link shorteners are added automatically)');
    else if (urlOk && Buffer.byteLength(url) > 152) add('NOTE', 'Link and QR Specialist', 'This is a long link, so the QR is dense and will take more space.', 'None.');
  }
  const hasContact = rq.contacts.some(c => c.phone || c.email);
  if (!hasContact && !(url && urlOk)) add('BLOCKER', 'Brief and Requirements Manager', 'There is no way for a reader to act: no contact and no link.', 'Add a contact or a link.', 'contacts', 'How should people register or get in touch? Add a phone, email or link.');
  if (rq.action.include_qr && !rq.action.destination_type) add('NOTE', 'Marketing and Editorial Director', 'The destination type was not confirmed, so a neutral call to action is used.', 'None.');

  // ---- Notes (data only) ----
  if (rq.extra_notes) add('NOTE', 'Brief and Requirements Manager', INJECTION.test(rq.extra_notes) ? 'The notes contain text that looks like an instruction to change system rules. Notes are treated as information only and cannot change any rule.' : 'Notes were recorded as information only. They are not printed and cannot change event facts or production rules.', 'None.');
  if (INJECTION.test(rq.offering.raw_text + ' ' + (rq.offering.approved_description || ''))) add('BLOCKER', 'Values and Claims Reviewer', 'The offering text contains instruction-like wording that cannot be used as flyer content.', 'Rewrite the offering as plain event wording.', 'offering.raw_text', 'Please rewrite the offering text as plain course wording.');

  // ---- Team B: claims ----
  if (description && BANNED.test(description)) { if (demo) { add('NOTE', 'Values and Claims Reviewer', 'The description contains an outcome claim and was left off the flyer.', 'None.'); description = null; } else add('BLOCKER', 'Values and Claims Reviewer', `The description contains wording that needs approved substantiation ("${description.match(BANNED)[0]}").`, 'Replace it with approved, limited wording.', 'offering.approved_description', 'Please supply approved wording for the description without outcome or guarantee claims.'); }
  if (BANNED.test(displayName)) add('BLOCKER', 'Values and Claims Reviewer', 'The title contains an outcome claim.', 'Use the approved programme name.', 'offering.raw_text', 'Please use the approved programme name as the title.');
  check('A05', true, issues.some(i => i.owner === 'Values and Claims Reviewer' && i.severity === 'BLOCKER') ? 'FAIL' : 'PASS', 'Claims and instruction-wording scan of title and description.', 'Pattern scan for outcome, guarantee and urgency claims; registry lookup.', 'Team B');

  // ---- Format ----
  if (!cfg.allowed_formats.includes(rq.format)) add('BLOCKER', 'Visual Standards Manager', `Format "${rq.format}" is not allowed.`, 'Choose an allowed format.', 'format', 'Which format? ' + cfg.allowed_formats.join(' or '));

  // ---- Team F: assets ----
  const manifest = [], sel = { logo: null, portrait: null, city: null };
  const logoSel = A.selectLogo(inv, cfg);
  const policy = cfg.logo_policy;
  if (policy === 'include_required') {
    if (logoSel.chosen) { sel.logo = logoSel.chosen; }
    else if (demo && (cfg.demo_omissions_authorised || []).includes('logo')) { add('NOTE', 'Brand Asset and Photography Manager', 'No logo file is available. The operator authorised omitting it for this demo sample. A production job would be blocked.', 'None for a demo.'); assumptions.push('Demo only: logo omitted by operator authorisation; the real logo path was not exercised.'); }
    else add('BLOCKER', 'Logo Integrity Specialist', logoSel.rejectedLightOnly ? 'Only light-on-dark logo variants were found, and this design uses a light background.' : 'The official logo is required but no usable logo file is in the approved asset package.', 'Add the official logo to assets/logos (Operator panel, Asset package).', 'assets.logo', 'Add the official logo file for a light background in the Operator panel under Asset package.');
  } else if (policy === 'reserve_space') assumptions.push('Logo policy is reserve_space: a clean area is left for the logo.');
  if (rq.imagery.include_gurudev) {
    const ps = A.selectPortrait(inv, cfg);
    if (ps.chosen && !ps.tooLow) { sel.portrait = ps.chosen; if (ps.lowRes) add('NOTE', 'Gurudev Portrait Specialist', 'The selected portrait is under 800 px on its long edge, so it is shown small.', 'None.'); }
    else if (demo && (cfg.demo_omissions_authorised || []).includes('gurudev')) { add('NOTE', 'Gurudev Portrait Specialist', 'You asked for the portrait, but no approved original is available. The operator authorised omitting it for this demo sample. It is not replaced by any generated likeness.', 'None for a demo.'); assumptions.push('Demo only: portrait omitted by operator authorisation; the portrait path was not exercised.'); }
    else add('BLOCKER', 'Gurudev Portrait Specialist', ps.tooLow ? 'The only approved portrait is too small to use.' : 'The portrait option is on, but no approved original is in the asset package. The option is not silently switched off.', 'Add an approved portrait to assets/gurudev, or turn the option off yourself.', 'imagery.include_gurudev', 'No approved portrait is available. Add one in the Operator panel under Asset package, or turn the Gurudev photo option off.');
  }
  if (rq.imagery.include_city_photo) {
    const ca = A.cityAsset(rq.imagery.city_photo_asset_id);
    if (!ca || !ca.usable) add('BLOCKER', 'City Photography Specialist', 'The city photo option is on but no readable photo was uploaded.', 'Upload a photo or turn the option off.', 'imagery.city_photo_asset_id', 'Upload the city photo, or turn the city photo option off.');
    else if (ca.width < 900) add('BLOCKER', 'City Photography Specialist', `The city photo is only ${ca.width} px wide and would look soft.`, 'Upload a larger photo.', 'imagery.city_photo_asset_id', 'Please upload a sharper, larger city photo (at least 900 px wide).');
    else if (rq.imagery.city_photo_metrics && rq.imagery.city_photo_metrics.sharpness !== null && rq.imagery.city_photo_metrics.sharpness < 12) add('BLOCKER', 'City Photography Specialist', 'The city photo measured as very blurry in the browser. Blur is not repaired.', 'Upload a sharper photo.', 'imagery.city_photo_asset_id', 'The photo looks very blurry. Please upload a sharper one.');
    else { sel.city = ca; if (rq.imagery.city_photo_metrics && rq.imagery.city_photo_metrics.sharpness < 25) add('NOTE', 'City Photography Specialist', 'The city photo is on the soft side; it will be used as supplied.', 'None.'); }
  }
  for (const [role, a] of Object.entries(sel)) if (a) manifest.push({ asset_id: a.id, role, filename: a.filename, category: a.category, type: a.type, width_px: a.width, height_px: a.height, aspect_ratio: a.aspect || +(a.width / a.height).toFixed(3), transparency: a.transparency ?? null, user_uploaded: !!a.user_uploaded, selection_reason: role === 'logo' ? `variant for a light background (${a.method || 'inferred'})` : role === 'portrait' ? 'best orientation and resolution among approved originals' : 'user upload for this job', permitted_transformations: role === 'city' ? ['proportional crop', 'proportional resize'] : role === 'portrait' ? ['proportional crop (head and hands protected)', 'proportional resize'] : ['proportional resize'] });
  check('A07', true, issues.some(i => ['Logo Integrity Specialist', 'Gurudev Portrait Specialist', 'City Photography Specialist'].includes(i.owner) && i.severity === 'BLOCKER') ? 'FAIL' : 'PASS', manifest.length ? `${manifest.length} original asset(s) selected and readable.` : 'No assets required or available for this job.', 'File inventory with header-measured dimensions.', 'Team F');

  // ---- Mood, palette ----
  const mood = moodPlan(rq.mood.selected, cfg);
  if (mood.unknown.length) add('NOTE', 'Visual Concept Designer', `Unrecognised mood "${mood.unknown.join(', ')}" was treated as a light influence only.`, 'None.');

  // ---- Blockers stop here ----
  const blockers = issues.filter(i => i.severity === 'BLOCKER');
  const brief = { offering: { ...rq.offering, programme_matched: reg ? reg.id : null, source: reg ? 'approved registry' : 'survey' }, mood: { selected: rq.mood.selected, resolved_direction: mood.resolved_direction }, imagery: rq.imagery, schedule: rq.schedule, location: L, contacts: rq.contacts, action: rq.action, format: rq.format, execution_profile: profile };
  if (blockers.length) return { rq, brief, issues, questions, assumptions, checks, manifest, sel, mood, status: 'NEEDS_INPUT', copy: null };

  // ---- Team C: copy ledger ----
  const blocks = [];
  const push = (id, role, text, optional = false) => blocks.push({ id, role, text, optional });
  if (demo) push('demo_label', 'label', 'DESIGN SAMPLE · FICTIONAL EVENT');
  const city = L.city;
  const eyebrow = L.delivery_mode === 'online' ? 'Online' : city ? (L.delivery_mode === 'hybrid' ? `In ${city} and online` : `In ${city}`) : null;
  if (eyebrow) push('eyebrow', 'label', eyebrow, true);
  push('title', 'title', displayName);
  let invitation = reg && (reg.allowed_benefit_language || [])[0] ? reg.allowed_benefit_language[0] : null, invSource = invitation ? 'approved registry benefit language' : 'host template';
  if (!invitation) invitation = L.delivery_mode === 'online' ? 'Join us online and find out what the program involves.' : L.delivery_mode === 'hybrid' ? `Join us in ${city} or online and find out what the program involves.` : city ? `Join us in ${city} and find out what the program involves.` : 'Join us and find out what the program involves.';
  if (llm && llm.enabled) {
    try { const r = await llm.invitation({ title: displayName, description, city, delivery_mode: L.delivery_mode, mood: mood.resolved_direction }, { avoid: [displayName], limits: { minWords: 8, maxWords: 16 } }); if (r) { invitation = r; invSource = 'language model, validated by host rules'; } }
    catch (e) { add('NOTE', 'Copywriter', 'The language model was unavailable or its draft failed validation, so the host template was used (' + e.message + ').', 'None.'); }
  }
  push('invitation', 'invitation', invitation);
  if (description) {
    const ss = sentences(description); let out = [], w = 0;
    for (const s of ss) { const n = U.words(s); if (w + n <= 30) { out.push(s); w += n; } else break; }
    if (out.length) push('description', 'body', out.join(' '), true);
    else add('NOTE', 'Copy Editor', 'The supplied description is too long for the flyer. Supply a shorter approved sentence to include it.', 'None.');
  }
  (reg && reg.allowed_benefit_language ? reg.allowed_benefit_language.slice(1, 4) : []).forEach((b, i) => push('benefit_' + (i + 1), 'body', b, true));
  if (reg && reg.display_conditions) push('conditions', 'body', reg.display_conditions);
  const lines = sessionLines(rq.schedule.sessions, tz, currentYear);
  lines.forEach((l, i) => push('sched_' + (i + 1), 'schedule', l.text));
  if (tz && L.delivery_mode !== 'in_person') push('tznote', 'note', 'All times in ' + U.tzLabel(tz));
  if (L.delivery_mode === 'online') push('loc_1', 'location', 'Online');
  else if (!L.on_course_page || L.venue || L.address) {
    if (L.delivery_mode === 'hybrid') push('loc_0', 'location', 'In person and online');
    if (L.venue) push('loc_1', 'location', L.venue);
    if (L.address) push('loc_2', 'location', city && !L.address.toLowerCase().includes(city.toLowerCase()) ? `${L.address}, ${city}` : L.address); else if (city && !L.venue) push('loc_2', 'location', city);
  }
  const qrOn = rq.action.include_qr && urlOk, t = rq.action.destination_type;
  let cta;
  if (qrOn) cta = t === 'registration' ? 'Scan to register' : t === 'enquiry' ? 'Scan to get in touch' : 'Scan to learn more';
  else if (urlOk) cta = t === 'registration' ? 'Register for the course' : t === 'enquiry' ? 'Contact us to learn more' : 'Explore the course';
  else cta = 'Contact us to learn more';
  push('cta', 'cta', cta);
  if (urlOk && !qrOn) push('url', 'body', url.replace(/^https?:\/\//i, '').replace(/\/$/, ''));
  rq.contacts.forEach((c, i) => { const first = [c.name, c.phone].filter(Boolean).join(' · '); if (first) push('contact_' + (i + 1), 'contact', first); if (c.email) push('contact_' + (i + 1) + '_email', 'contact', c.email); });

  // copy rules
  const bad = blocks.filter(b => /!|—|\bTBA\b|\[|\]|\{|\}|lorem|xxx/i.test(b.text) && !['url', 'title'].includes(b.id) && !b.id.includes('email'));
  bad.forEach(b => add('REVISION', 'Copy Editor', `Block ${b.id} contains a character or placeholder the copy rules avoid.`, 'Rewrite the text.'));
  const budget = (id, min, max) => { const b = blocks.find(x => x.id === id); if (b) { const n = U.words(b.text); if (n < min || n > max) add('NOTE', 'Copy Editor', `${id} is ${n} words (target ${min} to ${max}); kept for accuracy.`, 'None.'); } };
  budget('eyebrow', 2, 4); budget('invitation', 8, 16); budget('description', 15, 30); budget('cta', 2, 5);
  check('A06', true, bad.length ? 'FAIL' : 'PASS', `${blocks.length} text blocks; placeholder, exclamation, em dash and claim scan clean.`, 'Pattern scan of the frozen text ledger.', 'Team C');
  check('A02', true, 'PASS', `${lines.length} session(s) validated: real dates, weekday computed, time order and clock changes checked.`, 'Calendar and IANA time-zone arithmetic.', 'Team A');
  check('A04', true, 'PASS', `Action route: ${qrOn ? 'QR to link' : urlOk ? 'printed link' : 'contact'}; destination type ${t || 'not confirmed'}.`, 'Field validation.', 'Team A');

  // ---- Team G: QR plan ----
  let qr = null;
  if (qrOn) { const bytes = Buffer.byteLength(url); let v = 1; const cap = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213]; while (cap[v - 1] < bytes) v++; const size = 17 + 4 * v, lay = qrLayout(size); qr = { url, bytes, version: v, size, module_px: lay.scale, quiet_modules: lay.quiet, region_px: lay.px, ecc: 'M' }; }
  const bucketLinks = { requested: qrOn || urlOk, url: urlOk ? url : null };

  const palette = { background: cfg.palette.background, text: cfg.palette.text, accent: mood.accent, sage: cfg.palette.accent_sage, stone: cfg.palette.accent_stone };
  const textPairs = [['text on background', palette.text, palette.background]];
  const ratios = textPairs.map(([n, fg, bg]) => ({ pair: n, ratio: +U.contrast(U.hexToRgb(fg), U.hexToRgb(bg)).toFixed(2) }));
  check('A09', true, ratios.every(r => r.ratio >= 4.5) ? 'PASS' : 'FAIL', `Palette text pair computed from hex values: ${ratios.map(r => r.pair + ' ' + r.ratio + ':1').join('; ')}. Sage and stone are used for shapes only, never for informational text.`, 'WCAG relative luminance formula on declared hex colours (final contrast is measured separately on the exported pixels).', 'Team E');
  const hiss = issues.filter(i => i.severity === 'REVISION');
  return { rq, brief, issues, questions, assumptions, checks, manifest, sel, mood, palette, status: 'PLANNING', copy: { blocks, source: { invitation: invSource, description: description ? 'survey' : null } }, qr, links: bucketLinks, sessions: lines, hasRevisions: hiss.length > 0 };
}
module.exports = { plan, normalizeRequest, bool };
