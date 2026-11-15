// Public event page: /e/<slug> registers, /e/<slug>/in checks in at the venue.
const $ = id => document.getElementById(id);
const [, , slug, mode] = location.pathname.replace(/\/$/, '').split('/');
const checkIn = mode === 'in';

function formatDateTime(local) {
  const [date, time] = local.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const day = dt.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const t = dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  return `${day} · ${t}`;
}

function show(id) {
  for (const s of ['loading', 'formPanel', 'done', 'closed', 'missing']) $(s).hidden = s !== id;
}

async function load() {
  let ev;
  try {
    const res = await fetch(`/e/api/events/${encodeURIComponent(slug)}`, { cache: 'no-store' });
    if (res.status === 404) { document.title = 'Event not found'; return show('missing'); }
    if (!res.ok) throw new Error();
    ev = await res.json();
  } catch {
    $('loading').querySelector('p').textContent = 'Could not load this event. Check your connection and refresh.';
    return;
  }
  document.title = `${checkIn ? 'Check in' : 'Register'} · ${ev.title}`;
  $('event').hidden = false;
  $('program').textContent = ev.program;
  $('title').textContent = ev.title;
  $('when').textContent = formatDateTime(ev.startsAt);
  $('place').textContent = ev.place;
  $('place').hidden = !ev.place;
  $('teacher').textContent = ev.teacher ? `With ${ev.teacher}` : '';
  $('teacher').hidden = !ev.teacher;
  $('description').textContent = ev.description;
  $('description').hidden = !ev.description;

  if (checkIn) {
    $('formTitle').textContent = 'Welcome! Please check in';
    $('submit').textContent = 'Check in';
    $('emailField').hidden = true;
  } else if (ev.status !== 'open') {
    return show('closed');
  }
  show('formPanel');
}

$('form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = $('form').elements;
  $('error').textContent = '';
  if (!f.fullName.value.trim()) { $('error').textContent = 'Please enter your name.'; return f.fullName.focus(); }
  if (f.phone.value.replace(/\D/g, '').length < 8) { $('error').textContent = 'Please enter your phone number, including the area code.'; return f.phone.focus(); }
  $('submit').disabled = true;
  try {
    const res = await fetch(`/e/api/events/${encodeURIComponent(slug)}/${checkIn ? 'checkin' : 'register'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullName: f.fullName.value, phone: f.phone.value, email: f.email.value, goal: f.goal.value, consent: f.consent.checked, website: f.website.value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('error').textContent = data.error || 'Something went wrong. Please try again.';
      if (res.status === 409) show('closed');
      return;
    }
    const name = f.fullName.value.trim().split(/\s+/)[0];
    if (checkIn) {
      $('doneTitle').textContent = data.alreadyCheckedIn ? `You're already checked in, ${name}.` : `Welcome, ${name}! You're checked in.`;
      $('doneText').textContent = 'Enjoy the session.';
    } else {
      $('doneTitle').textContent = data.alreadyRegistered ? "You're already registered" : "You're on the list!";
      $('doneText').textContent = `See you ${$('when').textContent}${$('place').textContent ? ' at ' + $('place').textContent : ''}.`;
    }
    show('done');
    $('formPanel').hidden = true;
    $('done').focus();
  } catch {
    $('error').textContent = 'Could not send. Check your connection and try again.';
  } finally {
    $('submit').disabled = false;
  }
});

load();
