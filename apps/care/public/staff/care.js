import { api, formatDate, formatDateTime, formatWhen, h, setupSignIn, toast } from './shared/kit.js';

let me = null;
const view = document.getElementById('view');
const dialog = document.getElementById('dialog');

// ---------- helpers ----------
const firstName = p => p.fullName.split(/\s+/)[0];
const canContact = p => p.consent && !p.doNotContact && !!p.phoneDigits;

function messageFor(p) {
  const hi = `Hi ${firstName(p)}, it's ${me.name} from the Art of Living.`;
  if (p.kind === 'upcoming' && p.why) return `${hi} Looking forward to seeing you soon! Is there anything you'd like to know before you come?`;
  if (p.status === 'Potential') return `${hi} You recently connected with us and I wanted to say hello. How are you doing?`;
  const goal = p.goal ? ` You mentioned "${p.goal}".` : '';
  return `${hi} You joined us for ${p.currentStep}.${goal} How has it been going for you?`;
}

// Call, WhatsApp and SMS open the volunteer's own phone apps. Nothing is sent by this app.
function contactButtons(p, getMessage) {
  if (!canContact(p)) {
    const why = p.doNotContact ? 'Marked do not contact' : !p.consent ? 'No permission to contact yet' : 'No phone number';
    return h('p', { class: 'muted small' }, why + '.');
  }
  const digits = p.phoneDigits;
  const open = (url) => window.open(url, '_blank', 'noopener');
  return h('div', { class: 'row' },
    h('a', { class: 'btn', href: 'tel:+' + digits }, '📞 Call'),
    h('button', { class: 'btn wa', type: 'button', onclick: () => open(`https://wa.me/${digits}?text=${encodeURIComponent(getMessage())}`) }, '💬 WhatsApp'),
    h('button', { class: 'btn', type: 'button', onclick: () => { location.href = `sms:+${digits}?&body=${encodeURIComponent(getMessage())}`; } }, '✉️ SMS'),
  );
}

function outcomeForm(p, onDone) {
  const note = h('textarea', { rows: 2, maxlength: 500, placeholder: 'What did they share? Anything to remember next time?' });
  const next = h('input', { type: 'date', min: me.today, 'aria-label': 'Next check-in date' });
  const err = h('p', { class: 'error', role: 'alert' });
  const log = async (outcome) => {
    err.textContent = '';
    try {
      await api(`api/people/${p.id}/calls`, { method: 'POST', body: { outcome, note: note.value, nextFollowUp: next.value || null } });
      toast(`Saved: ${outcome} for ${firstName(p)}.`);
      onDone();
    } catch (e) { err.textContent = e.message; }
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'log' },
      h('label', null, 'Note ', h('span', { class: 'optional' }, '(optional)'), note),
      h('label', null, 'Next check-in ', h('span', { class: 'optional' }, '(optional)'), next)),
    h('div', { class: 'outcomes', role: 'group', 'aria-label': 'Log the outcome' },
      me.outcomes.map(o => h('button', { class: 'btn small', type: 'button', onclick: () => log(o) }, o))),
    err);
}

function showDialog(build) {
  dialog.replaceChildren(build(() => dialog.close()));
  dialog.showModal();
  dialog.querySelector('input, select, textarea')?.focus();
}

function fieldError(form, e) {
  form.querySelector('.error').textContent = e.message;
  if (e.body?.field) form.querySelector(`[name="${e.body.field}"]`)?.focus();
}

// ---------- Today ----------
async function renderToday() {
  const { items } = await api('api/queue');
  view.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', null, 'Today'), h('p', { class: 'muted' }, 'People to reconnect with, most urgent first. Only people who agreed to be contacted appear here.')),
    items.length ? h('div', { class: 'stack' }, items.map(queueCard)) :
      h('div', { class: 'panel empty' }, h('h2', null, "You're up to date."), h('p', null, 'No promised check-ins or new people right now.')),
  );
}

function queueCard(p) {
  const msg = h('textarea', { rows: 3, maxlength: 1000, 'aria-label': `Message to ${p.fullName}` });
  msg.value = messageFor(p);
  const takenByOther = p.claimedBy && p.claimedBy !== me.name;
  const claimBtn = h('button', { class: 'btn primary', type: 'button', onclick: async () => {
    try { await api(`api/people/${p.id}/claim`, { method: 'POST' }); toast(`${firstName(p)} is yours for the next 24 hours.`); renderToday(); } catch (e) { toast(e.message); renderToday(); }
  } }, "I'll contact them");
  return h('article', { class: `card ${p.kind}` },
    h('div', { class: 'spread' },
      h('div', null, h('h2', null, h('a', { href: '#person/' + p.id }, p.fullName)), h('p', { class: 'why' }, p.why)),
      takenByOther ? h('span', { class: 'badge warn' }, `${p.claimedBy} is contacting`) : p.claimedBy ? h('span', { class: 'badge accent' }, 'You are contacting') : claimBtn),
    h('div', { class: 'facts' },
      h('span', null, 'Journey: ', h('strong', null, p.currentStep), p.nextStep ? ` → next ${p.nextStep}` : ''),
      p.teacher && h('span', null, 'Teacher: ', h('strong', null, p.teacher)),
      h('span', null, 'Last contact: ', h('strong', null, p.lastCall ? formatWhen(p.lastCall) : 'Never')),
      p.nextFollowUp && h('span', null, 'Promised: ', h('strong', null, formatDate(p.nextFollowUp)))),
    p.goal && h('p', { class: 'quote' }, `“${p.goal}”`),
    p.followUpContext && h('p', { class: 'small' }, h('strong', null, 'Last note: '), p.followUpContext),
    takenByOther ? null : [
      h('label', null, 'Message ', h('span', { class: 'optional' }, '(edit before sending)'), msg),
      contactButtons(p, () => msg.value),
      outcomeForm(p, renderToday),
    ]);
}

// ---------- People ----------
async function renderPeople() {
  const search = h('input', { type: 'search', placeholder: 'Search by name, phone or email', 'aria-label': 'Search people' });
  const list = h('div', { class: 'people-list' });
  const load = async () => {
    const people = await api('api/people?q=' + encodeURIComponent(search.value));
    list.replaceChildren(...(people.length ? people.map(personRow) : [h('p', { class: 'empty' }, search.value ? 'No one matches that search.' : 'No one here yet. Add someone, or share an event QR code.')]));
  };
  let t; search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 200); });
  view.replaceChildren(
    h('div', { class: 'page-head spread' },
      h('div', null, h('h1', null, 'People'), h('p', { class: 'muted' }, 'Everyone in your circle, sorted by the next promised check-in.')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => showDialog(personForm()) }, '+ Add a person')),
    h('div', { class: 'panel stack' }, search, list));
  await load();
}

function personRow(p) {
  const today = me.today;
  const due = p.nextFollowUp && p.nextFollowUp <= today;
  return h('a', { class: 'person-row', href: '#person/' + p.id },
    h('div', null, h('div', { class: 'name' }, p.fullName), h('div', { class: 'muted small' }, p.phone || 'No phone')),
    h('div', { class: 'hide-sm' }, h('span', { class: p.status === 'Participant' ? 'badge ok' : 'badge' }, p.status), ' ', h('span', { class: 'small' }, p.currentStep)),
    h('div', { class: 'hide-sm small' }, p.nextFollowUp ? h('span', { class: due ? 'badge danger' : 'badge' }, (due ? 'Due ' : 'Check in ') + formatDate(p.nextFollowUp)) : h('span', { class: 'muted' }, 'No check-in set')),
    h('div', null, p.doNotContact ? h('span', { class: 'badge danger' }, 'Do not contact') : !p.consent ? h('span', { class: 'badge warn' }, 'No consent') : null));
}

function personForm(p) {
  return close => {
    const form = h('form', { method: 'dialog', novalidate: true },
      h('h2', null, p ? 'Edit details' : 'Add someone to your circle'),
      h('label', null, 'Name', h('input', { name: 'fullName', required: true, maxlength: 80, autocomplete: 'off', value: p?.fullName ?? '' })),
      h('div', { class: 'fields' },
        h('label', null, 'Phone', h('input', { name: 'phone', type: 'tel', inputmode: 'tel', maxlength: 30, placeholder: 'Include country code if outside Canada/US', value: p?.phone ?? '' })),
        h('label', null, 'Email ', h('input', { name: 'email', type: 'email', maxlength: 120, value: p?.email ?? '' }))),
      h('label', null, 'What matters to them? ', h('span', { class: 'optional' }, '(their own words)'), h('textarea', { name: 'goal', rows: 2, maxlength: 200, value: p?.goal ?? '' })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'consent', checked: p ? p.consent : false }),
        h('span', null, 'They agreed to be contacted by our volunteers (call, WhatsApp or SMS).')),
      h('p', { class: 'error', role: 'alert' }),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, p ? 'Save' : 'Add person'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = form.elements;
      const body = { fullName: f.fullName.value, phone: f.phone.value, email: f.email.value, goal: f.goal.value, consent: f.consent.checked };
      try {
        const saved = await api(p ? 'api/people/' + p.id : 'api/people', { method: p ? 'PATCH' : 'POST', body });
        close();
        if (p) route(); else location.hash = '#person/' + saved.id;
      } catch (e) {
        fieldError(form, e);
        if (e.body?.personId) form.querySelector('.error').append(' ', h('a', { href: '#person/' + e.body.personId, onclick: close }, 'Open their profile'));
      }
    });
    return form;
  };
}

// ---------- Person profile ----------
async function renderPerson(id) {
  let p;
  try { p = await api('api/people/' + id); } catch (e) {
    if (e.status === 404) return view.replaceChildren(h('div', { class: 'panel empty' }, h('h2', null, 'This person was not found.'), h('a', { href: '#people' }, 'Back to People')));
    throw e;
  }
  const msg = h('textarea', { rows: 3, maxlength: 1000, 'aria-label': 'Message' });
  msg.value = messageFor(p);

  const toggle = async (fields, text) => { await api('api/people/' + p.id, { method: 'PATCH', body: fields }); toast(text); renderPerson(id); };

  const followDate = h('input', { type: 'date', value: p.nextFollowUp ?? '', 'aria-label': 'Next check-in date' });
  const followNote = h('textarea', { rows: 2, maxlength: 500, value: p.followUpContext, placeholder: 'Keep their words and wishes in view.' });

  view.replaceChildren(
    h('p', null, h('a', { href: '#people' }, '← People')),
    h('div', { class: 'page-head spread' },
      h('div', null,
        h('h1', null, p.fullName),
        h('div', { class: 'row', style: 'margin-top:6px' },
          h('span', { class: p.status === 'Participant' ? 'badge ok' : 'badge' }, p.status),
          p.doNotContact && h('span', { class: 'badge danger' }, 'Do not contact'),
          !p.consent && h('span', { class: 'badge warn' }, 'No consent to contact'),
          p.claimedBy && p.claimedUntil > Date.now() && h('span', { class: 'badge accent' }, `${p.claimedBy} is contacting`))),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => showDialog(personForm(p)) }, 'Edit details'),
        me.role === 'manager' && h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (!confirm(`Delete ${p.fullName} and all their history? This cannot be undone.`)) return;
          await api('api/people/' + p.id, { method: 'DELETE' }); toast('Deleted.'); location.hash = '#people';
        } }, 'Delete'))),
    h('div', { class: 'grid2' },
      h('div', null,
        journeyPanel(p),
        h('section', { class: 'panel stack' },
          h('span', { class: 'eyebrow' }, 'Conversations'),
          h('h2', null, `Care history (${p.calls.length})`),
          canContact(p) ? outcomeForm(p, () => renderPerson(id)) : null,
          p.calls.length ? h('ul', { class: 'history' }, p.calls.map(c => h('li', null,
            h('div', { class: 'spread' }, h('strong', null, c.outcome), h('span', { class: 'muted small' }, `${formatWhen(c.createdAt)} · ${c.volunteer}`)),
            c.note && h('p', null, c.note),
            c.nextFollowUp && h('p', { class: 'muted small' }, 'Next check-in: ' + formatDate(c.nextFollowUp)))))
            : h('p', { class: 'muted' }, 'No conversations logged yet.'))),
      h('aside', null,
        h('section', { class: 'panel stack' },
          h('span', { class: 'eyebrow' }, 'Contact'),
          h('div', { class: 'small' },
            h('div', null, p.phone || h('span', { class: 'muted' }, 'No phone')),
            p.email && h('div', null, h('a', { href: 'mailto:' + p.email }, p.email))),
          p.goal && h('p', { class: 'quote' }, `“${p.goal}”`),
          canContact(p) && h('label', null, 'Message ', h('span', { class: 'optional' }, '(edit before sending)'), msg),
          contactButtons(p, () => msg.value),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.consent, onchange: e => toggle({ consent: e.target.checked }, e.target.checked ? 'Marked as agreed to be contacted.' : 'Consent removed.') }), h('span', null, 'Agreed to be contacted')),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.doNotContact, onchange: e => toggle({ doNotContact: e.target.checked }, e.target.checked ? 'Marked do not contact.' : 'Do not contact removed.') }), h('span', null, 'Do not contact (hides them from every queue)'))),
        h('section', { class: 'panel stack' },
          h('span', { class: 'eyebrow' }, 'Keep the thread'),
          h('h2', null, 'Next check-in'),
          followDate,
          h('label', null, 'Context', followNote),
          h('div', { class: 'row' },
            h('button', { class: 'btn primary', type: 'button', onclick: () => toggle({ nextFollowUp: followDate.value || null, followUpContext: followNote.value }, 'Check-in saved.') }, 'Save check-in'),
            p.nextFollowUp && h('button', { class: 'btn', type: 'button', onclick: () => toggle({ nextFollowUp: null }, 'Check-in cleared.') }, 'Clear'))),
        p.events.length ? h('section', { class: 'panel stack' },
          h('span', { class: 'eyebrow' }, 'Events'),
          h('ul', { class: 'steps' }, p.events.map(e => h('li', null,
            h('div', null, h('a', { href: '#event/' + e.id }, e.title), h('div', { class: 'muted small' }, formatDateTime(e.startsAt))),
            h('span', { class: e.attended ? 'badge ok' : 'badge' }, e.attended ? 'Attended' : 'Registered'))))) : null)));
}

function journeyPanel(p) {
  const done = new Set(p.steps.map(s => s.step));
  const core = me.journeySteps.slice(0, 6), extra = me.journeySteps.slice(6);
  const node = s => h('span', { class: 'node' + (done.has(s) ? ' done' : s === p.nextStep ? ' next' : '') }, done.has(s) ? '✓ ' : s === p.nextStep ? '→ ' : '', s);
  const step = h('select', { name: 'step', 'aria-label': 'Step' }, me.journeySteps.map(s => h('option', { value: s, selected: s === p.nextStep }, s)));
  const date = h('input', { type: 'date', name: 'date', value: me.today, max: me.today, 'aria-label': 'Date' });
  const teacher = h('input', { name: 'teacher', maxlength: 80, placeholder: 'Teacher', 'aria-label': 'Teacher' });
  const err = h('p', { class: 'error', role: 'alert' });
  const addForm = h('form', { class: 'stack', hidden: true },
    h('div', { class: 'fields' }, h('label', null, 'Step', step), h('label', null, 'Date', date), h('label', null, 'Teacher', teacher)),
    err, h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Add step')));
  addForm.addEventListener('submit', async ev => {
    ev.preventDefault();
    try { await api(`api/people/${p.id}/steps`, { method: 'POST', body: { step: step.value, date: date.value, teacher: teacher.value } }); toast('Journey step added.'); renderPerson(p.id); }
    catch (e) { err.textContent = e.message; }
  });
  return h('section', { class: 'panel stack' },
    h('span', { class: 'eyebrow' }, 'Their path'),
    h('div', { class: 'spread' },
      h('h2', null, 'Journey'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { addForm.hidden = !addForm.hidden; } }, '+ Add a step')),
    h('div', { class: 'path', 'aria-label': 'Core path' }, core.flatMap((s, i) => i ? [h('span', { class: 'arrow', 'aria-hidden': 'true' }, '›'), node(s)] : [node(s)])),
    h('div', { class: 'path', 'aria-label': 'Additional programs' }, extra.map(node)),
    p.nextStep && h('p', { class: 'small' }, 'Next suggested step: ', h('strong', null, p.nextStep)),
    addForm,
    p.steps.length ? h('ul', { class: 'steps' }, p.steps.map(s => h('li', null,
      h('div', null, h('strong', null, s.step), h('div', { class: 'muted small' }, formatDate(s.date, { year: 'numeric', month: 'short', day: 'numeric' }), s.teacher ? ` · with ${s.teacher}` : '', s.eventId ? ' · from event' : '')),
      h('button', { class: 'linkbtn small', type: 'button', 'aria-label': `Remove ${s.step}`, onclick: async () => {
        if (!confirm(`Remove ${s.step} from ${p.fullName}'s journey?`)) return;
        await api(`api/people/${p.id}/steps/${s.id}`, { method: 'DELETE' }); renderPerson(p.id);
      } }, 'Remove')))) : h('p', { class: 'muted' }, 'No completed steps yet.'));
}

// ---------- Events ----------
async function renderEvents() {
  const events = await api('api/events');
  const upcoming = events.filter(e => e.startsAt.slice(0, 10) >= me.today).reverse();
  const past = events.filter(e => e.startsAt.slice(0, 10) < me.today);
  const card = e => h('a', { class: 'event-card', href: '#event/' + e.id },
    h('div', { class: 'row' }, h('span', { class: 'badge accent' }, e.program), e.status === 'closed' && h('span', { class: 'badge' }, 'Closed')),
    h('h3', null, e.title),
    h('p', { class: 'muted small' }, formatDateTime(e.startsAt), e.place ? ` · ${e.place}` : ''),
    h('p', { class: 'small' }, `${e.registered} registered · ${e.attended} attended`));
  view.replaceChildren(
    h('div', { class: 'page-head spread' },
      h('div', null, h('h1', null, 'Events'), h('p', { class: 'muted' }, 'Each event gets a sign-up QR code and a venue check-in QR code.')),
      h('button', { class: 'btn primary', type: 'button', onclick: () => showDialog(eventForm()) }, '+ Create an event')),
    h('h2', { style: 'margin-bottom:12px' }, `Upcoming (${upcoming.length})`),
    upcoming.length ? h('div', { class: 'event-list' }, upcoming.map(card)) : h('p', { class: 'panel empty' }, 'No upcoming events. Create one to get its QR code.'),
    past.length ? [h('h2', { style: 'margin:28px 0 12px' }, `Past (${past.length})`), h('div', { class: 'event-list' }, past.map(card))] : null);
}

function eventForm(e) {
  return close => {
    const program = h('select', { name: 'program' }, me.eventPrograms.map(p => h('option', { value: p, selected: e ? e.program === p : p === 'Intro Talk' }, p)));
    const title = h('input', { name: 'title', required: true, maxlength: 100, value: e?.title ?? 'Intro Talk' });
    let titleTouched = !!e;
    title.addEventListener('input', () => { titleTouched = true; });
    program.addEventListener('change', () => { if (!titleTouched) title.value = program.value; });
    const form = h('form', { method: 'dialog', novalidate: true },
      h('h2', null, e ? 'Edit event' : 'Create an event'),
      h('div', { class: 'fields' }, h('label', null, 'Program', program), h('label', null, 'Date and time', h('input', { name: 'startsAt', type: 'datetime-local', required: true, value: e?.startsAt ?? '' }))),
      h('label', null, 'Title', title),
      h('div', { class: 'fields' },
        h('label', null, 'Teacher', h('input', { name: 'teacher', maxlength: 80, value: e?.teacher ?? '' })),
        h('label', null, 'Place', h('input', { name: 'place', maxlength: 150, value: e?.place ?? '' }))),
      h('label', null, 'Description ', h('span', { class: 'optional' }, '(shown on the sign-up page)'), h('textarea', { name: 'description', rows: 3, maxlength: 600, value: e?.description ?? '' })),
      e && h('p', { class: 'muted small' }, 'The event link and QR codes never change, so printed codes keep working.'),
      h('p', { class: 'error', role: 'alert' }),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, e ? 'Save' : 'Create and get QR codes'), h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancel')));
    form.addEventListener('submit', async ev => {
      ev.preventDefault();
      const f = form.elements;
      const body = { program: f.program.value, title: f.title.value, startsAt: f.startsAt.value, teacher: f.teacher.value, place: f.place.value, description: f.description.value };
      try {
        const saved = await api(e ? 'api/events/' + e.id : 'api/events', { method: e ? 'PATCH' : 'POST', body });
        close();
        if (e) route(); else location.hash = '#event/' + saved.id;
      } catch (err) { fieldError(form, err); }
    });
    return form;
  };
}

async function downloadPng(svgUrl, filename) {
  const img = new Image();
  img.src = svgUrl;
  await img.decode();
  const scale = 1200 / img.naturalWidth;
  const canvas = Object.assign(document.createElement('canvas'), { width: 1200, height: Math.round(img.naturalHeight * scale) });
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  canvas.toBlob(blob => {
    const a = h('a', { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, 'image/png');
}

function qrBox(e, kind) {
  const suffix = kind === 'checkin' ? '/in' : '';
  const link = `${location.origin}/e/${e.slug}${suffix}`;
  const svg = `/e/${e.slug}${suffix}/qr.svg`;
  const base = `${e.slug}-${kind === 'checkin' ? 'checkin' : 'register'}-qr`;
  const share = kind === 'checkin'
    ? `Check in for ${e.title}: ${link}`
    : `Join us for ${e.title} on ${formatDateTime(e.startsAt)}${e.place ? ` at ${e.place}` : ''}. Register here: ${link}`;
  return h('div', { class: 'qr-box' },
    h('h3', null, kind === 'checkin' ? 'Check-in at the venue' : 'Register'),
    h('img', { src: svg, alt: `QR code for ${link}`, width: 200 }),
    h('code', null, link),
    h('div', { class: 'row', style: 'justify-content:center' },
      h('button', { class: 'btn small', type: 'button', onclick: () => downloadPng(svg, base + '.png').catch(() => toast('Could not make the PNG.')) }, 'Download PNG'),
      h('a', { class: 'btn small', href: svg + '?download=1', download: base + '.svg' }, 'SVG'),
      h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('Link copied.'); } catch { prompt('Copy this link:', link); } } }, 'Copy link'),
      h('a', { class: 'btn small wa', href: 'https://wa.me/?text=' + encodeURIComponent(share), target: '_blank', rel: 'noopener' }, 'Share on WhatsApp')));
}

async function renderEvent(id) {
  let e;
  try { e = await api('api/events/' + id); } catch (err) {
    if (err.status === 404) return view.replaceChildren(h('div', { class: 'panel empty' }, h('h2', null, 'This event was not found.'), h('a', { href: '#events' }, 'Back to Events')));
    throw err;
  }
  const isStep = me.journeySteps.includes(e.program);
  const attendedCount = e.registrations.filter(r => r.attended).length;
  const patch = async body => { await api('api/events/' + e.id, { method: 'PATCH', body }); renderEvent(id); };
  view.replaceChildren(
    h('p', null, h('a', { href: '#events' }, '← Events')),
    h('div', { class: 'page-head spread' },
      h('div', null,
        h('div', { class: 'row' }, h('span', { class: 'badge accent' }, e.program), h('span', { class: e.status === 'open' ? 'badge ok' : 'badge' }, e.status === 'open' ? 'Registration open' : 'Registration closed')),
        h('h1', { style: 'margin-top:6px' }, e.title),
        h('p', { class: 'muted' }, formatDateTime(e.startsAt), e.place ? ` · ${e.place}` : '', e.teacher ? ` · with ${e.teacher}` : '')),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => showDialog(eventForm(e)) }, 'Edit'),
        h('button', { class: 'btn', type: 'button', onclick: () => patch({ status: e.status === 'open' ? 'closed' : 'open' }) }, e.status === 'open' ? 'Close registration' : 'Reopen registration'),
        h('a', { class: 'btn', href: `/e/${e.slug}`, target: '_blank', rel: 'noopener' }, 'Open sign-up page ↗'),
        me.role === 'manager' && h('button', { class: 'btn danger', type: 'button', onclick: async () => {
          if (!confirm(`Delete "${e.title}"? Its QR codes will stop working. People stay in your circle.`)) return;
          await api('api/events/' + e.id, { method: 'DELETE' }); location.hash = '#events';
        } }, 'Delete'))),
    h('section', { class: 'panel' }, h('div', { class: 'qr-pair' }, qrBox(e, 'register'), qrBox(e, 'checkin'))),
    h('section', { class: 'panel stack' },
      h('div', { class: 'spread' },
        h('h2', null, `People (${e.registrations.length} registered · ${attendedCount} attended)`),
        isStep && attendedCount > 0 && h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          const r = await api(`api/events/${e.id}/complete`, { method: 'POST', body: {} });
          toast(r.added ? `Added ${e.program} to ${r.added} ${r.added === 1 ? 'journey' : 'journeys'}.` : 'Everyone who attended already has this step.');
          renderEvent(id);
        } }, `Mark ${e.program} completed for everyone who attended`)),
      !isStep && h('p', { class: 'muted small' }, `${e.program} is not a journey step, so attendance does not change anyone's journey.`),
      e.registrations.length ? h('div', { class: 'table-scroll' }, h('table', null,
        h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', null, 'Phone'), h('th', null, 'Attended'), isStep && h('th', null, 'Journey'))),
        h('tbody', null, e.registrations.map(r => h('tr', null,
          h('td', null, h('a', { href: '#person/' + r.personId }, r.fullName), r.walkIn ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'Walk-in') : null, !r.consent ? h('span', { class: 'badge warn', style: 'margin-left:6px' }, 'No consent') : null),
          h('td', null, r.phone),
          h('td', null, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: r.attended, 'aria-label': `${r.fullName} attended`, onchange: async ev => {
            await api(`api/events/${e.id}/attendance`, { method: 'POST', body: { personId: r.personId, attended: ev.target.checked } }); renderEvent(id);
          } }))),
          isStep && h('td', null, r.completed ? h('span', { class: 'badge ok' }, `✓ ${e.program}`) : r.attended ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
            await api(`api/events/${e.id}/complete`, { method: 'POST', body: { personIds: [r.personId] } }); toast(`${e.program} added to ${r.fullName}'s journey.`); renderEvent(id);
          } }, 'Mark completed') : h('span', { class: 'muted small' }, '—')))))))
        : h('p', { class: 'muted' }, 'No one has registered yet. Share the QR code or link above.')));
}

// ---------- routing ----------
async function route() {
  if (!me) return;
  const [name, id] = location.hash.slice(1).split('/');
  const section = ['person'].includes(name) ? 'people' : name === 'event' ? 'events' : ['today', 'people', 'events'].includes(name) ? name : 'today';
  document.querySelectorAll('.subtabs a').forEach(a => a.classList.toggle('active', a.dataset.view === section));
  try {
    if (name === 'person' && id) await renderPerson(id);
    else if (name === 'event' && id) await renderEvent(id);
    else if (section === 'people') await renderPeople();
    else if (section === 'events') await renderEvents();
    else await renderToday();
  } catch (e) {
    if (e.status === 401) return signedOut();
    view.replaceChildren(h('div', { class: 'panel empty' }, h('h2', null, 'Something went wrong.'), h('p', null, e.message), h('button', { class: 'btn', type: 'button', onclick: route }, 'Try again')));
  }
}

function signedOut() {
  me = null;
  document.getElementById('app').hidden = true;
  document.getElementById('signin').hidden = false;
}

window.addEventListener('hashchange', route);
setupSignIn({
  form: document.getElementById('signinForm'),
  error: document.getElementById('signinError'),
  signOut: document.getElementById('signOut'),
  meUrl: 'api/me',
  onSignedIn(data) {
    me = data;
    document.getElementById('signin').hidden = true;
    document.getElementById('app').hidden = false;
    document.getElementById('whoName').textContent = me.name;
    const role = document.getElementById('whoRole');
    role.textContent = me.role === 'manager' ? 'Manager' : 'Volunteer';
    role.className = me.role === 'manager' ? 'badge accent' : 'badge';
    route();
  },
  onSignedOut: signedOut,
});
