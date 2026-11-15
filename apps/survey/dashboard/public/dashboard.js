// Staff dashboard. All text from the API (names, comments) is rendered with
// textContent, never as HTML.

const TZ = 'America/Edmonton';
const STORAGE_KEY = 'aol-staff-token';
const NAME_KEY = 'aol-staff-name';

const $ = id => document.getElementById(id);
const els = {
  session: $('session'), sessionName: $('session-name'), role: $('role'), refresh: $('refresh'), signOut: $('sign-out'),
  signin: $('signin'), signinForm: $('signin-form'), name: $('name'), token: $('token'), signinError: $('signin-error'), signinBtn: $('signin-btn'),
  banner: $('banner'), loading: $('loading'), app: $('app'),
  tiles: $('tiles'), windowSeg: $('window-seg'), cohortSeg: $('cohort-seg'), windowDates: $('window-dates'),
  actions: $('actions'), charts: $('charts'),
  responsesCard: $('responses-card'), rows: $('rows'), search: $('search'), namedOnly: $('named-only'),
  exportBtn: $('export'), more: $('more'), responsesNote: $('responses-note'), footnote: $('footnote'),
};

const state = {
  token: null, role: null, report: null, labels: {}, window: 'current', cohort: 'all',
  records: [], nextBefore: null,
};

/* ---------- small helpers ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c);
  return node;
}

const storage = {
  get() { try { return sessionStorage.getItem(STORAGE_KEY); } catch { return null; } },
  getName() { try { return sessionStorage.getItem(NAME_KEY); } catch { return null; } },
  set(token, name) { try { sessionStorage.setItem(STORAGE_KEY, token); sessionStorage.setItem(NAME_KEY, name); } catch { /* in-memory only */ } },
  clear() { try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ } },
};

const dateTime = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
const dateOnly = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, dateStyle: 'medium' });

class ApiError extends Error {
  constructor(status, body) { super(body?.message ?? 'HTTP ' + status); this.status = status; this.body = body; }
}

async function api(path) {
  const res = await fetch(path, {
    headers: { Accept: 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    cache: 'no-store',
  });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

function showBanner(message) {
  els.banner.textContent = message;
  els.banner.hidden = !message;
}

/* ---------- labels from the questionnaire ---------- */

const ruleText = {
  access_support: 'Health or access needs',
  learning_support: 'Wants refresher / teacher time',
  solo_preference: 'Prefers practising alone',
  session_fit: 'Travel, venue, unsure or shorter session',
  online_preference: 'Online, approved link set',
  online_contact: 'Online, no link yet',
  session_planning: 'Day, time, commitments or details',
  group_interest: 'Wants guided practice / meeting graduates',
  availability: 'Gave a specific day, time or in person',
  open_invitation: 'No specific need',
};

async function loadLabels() {
  try {
    const survey = await api('api/survey');
    for (const q of survey.questions) {
      for (const o of q.options ?? []) state.labels[`${q.id}:${o.id}`] = o.label;
      for (const f of q.fields ?? []) for (const o of f.options ?? []) state.labels[`${f.id}:${o.id}`] = o.label;
    }
  } catch { /* fall back to IDs */ }
}
const label = (field, id) => (id == null ? '' : state.labels[`${field}:${id}`] ?? id);

/* ---------- sign in / out ---------- */

async function signIn(token, name) {
  state.token = token;
  els.signinBtn.disabled = true;
  els.signinError.hidden = true;
  showBanner('');
  els.loading.hidden = false;
  try {
    const [report] = await Promise.all([api('api/staff/report'), loadLabels()]);
    state.report = report;
    // Manager can list responses; reporter gets 403.
    try {
      const page = await api('api/staff/responses?limit=50');
      state.role = 'manager';
      state.records = page.records;
      state.nextBefore = page.nextBefore;
    } catch (err) {
      if (err.status !== 403) throw err;
      state.role = 'reporter';
      state.records = [];
      state.nextBefore = null;
    }
    storage.set(token, name);
    els.signin.hidden = true;
    els.session.hidden = false;
    els.app.hidden = false;
    els.sessionName.textContent = name;
    els.role.textContent = state.role === 'manager' ? 'Manager' : 'Reporter';
    els.token.value = '';
    render();
  } catch (err) {
    state.token = null;
    storage.clear();
    els.signin.hidden = false;
    els.app.hidden = true;
    els.session.hidden = true;
    els.sessionName.textContent = '';
    els.signinError.textContent = err.status === 401
      ? 'That token wasn’t accepted. Check it matches AOL_MANAGER_TOKEN or AOL_REPORT_TOKEN in the backend .env.'
      : (err.body?.message ?? 'Could not reach the dashboard server.');
    els.signinError.hidden = false;
    els.token.focus();
  } finally {
    els.signinBtn.disabled = false;
    els.loading.hidden = true;
  }
}

function signOut() {
  storage.clear();
  Object.assign(state, { token: null, role: null, report: null, records: [], nextBefore: null });
  els.rows.replaceChildren();
  els.app.hidden = true;
  els.session.hidden = true;
  els.sessionName.textContent = '';
  els.signin.hidden = false;
  els.token.value = '';
  showBanner('');
  els.token.focus();
}

async function refresh() {
  if (!state.token) return;
  els.refresh.disabled = true;
  try {
    state.report = await api('api/staff/report');
    if (state.role === 'manager') {
      const page = await api('api/staff/responses?limit=50');
      state.records = page.records;
      state.nextBefore = page.nextBefore;
    }
    showBanner('');
    render();
  } catch (err) {
    if (err.status === 401) return signOut();
    showBanner(err.body?.message ?? 'Could not refresh. Is the backend running?');
  } finally {
    els.refresh.disabled = false;
  }
}

/* ---------- rendering ---------- */

function render() {
  renderTiles();
  renderFilters();
  renderActions();
  renderCharts();
  renderResponses();
  const r = state.report;
  els.footnote.textContent =
    `Questionnaire ${r.surveyVersion} · Times in local time · Groups or questions with fewer than ${r.minimumBase} answers are hidden · ` +
    `Responses are kept ${r.retentionDays} days. This is feedback from people who responded, not everyone who took an AOL program.`;
}

function tile(labelText, value, sub) {
  return el('div', { class: 'tile' },
    el('div', { class: 'tile-label', text: labelText }),
    el('div', { class: 'tile-value', text: value }),
    sub ? el('div', { class: 'tile-sub', text: sub }) : null);
}

const totalText = summary => (summary.status === 'ready' ? String(summary.total) : 'Under 5');

function renderTiles() {
  const { current, prior } = state.report;
  els.tiles.replaceChildren(
    tile('Responses, last 30 days', totalText(current.all), `Previous 30 days: ${totalText(prior.all)}`),
    tile('No follow-up in 30 days', totalText(current.noRecent), 'Never joined + joined before'),
    tile('Joined a follow-up in 30 days', totalText(current.recent), 'One, or two or more'),
  );
}

function renderFilters() {
  for (const b of els.windowSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.window === state.window));
  for (const b of els.cohortSeg.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.cohort === state.cohort));
  const w = state.report[state.window];
  const end = new Date(Date.parse(w.toExclusive) - 1);
  els.windowDates.textContent = `${dateOnly.format(new Date(w.fromInclusive))} – ${dateOnly.format(end)}`;
}

const cohortText = {
  noRecentBarriers: 'people with no follow-up in 30 days who answered Q2',
  allPriorities: 'everyone',
  allFormatAnswers: 'people who chose a format',
};

function renderActions() {
  const list = state.report.volunteerActions;
  if (!list.length) {
    els.actions.replaceChildren(el('p', { class: 'empty', text: 'No suggestions yet. They appear once enough people share the same answer.' }));
    return;
  }
  els.actions.replaceChildren(...list.map(a => el('article', { class: 'action' },
    el('h3', { text: a.title }),
    el('p', { text: a.nextStep }),
    el('p', { class: 'meta', text: `${a.count} of ${a.denominator} ${cohortText[a.cohort] ?? a.cohort} (${a.percent}%)` }),
  )));
}

const chartDefs = [
  ['attendance', 'Follow-ups joined in the past 30 days', 'Base: everyone in this group'],
  ['barriers', 'What makes it harder to join', 'Base: people who answered (Prefer to skip excluded). Up to two choices each, so totals can pass 100%.'],
  ['priority', 'What they would most like', 'Base: everyone in this group'],
  ['days', 'Day that works', 'Base: people who chose a day'],
  ['times', 'Time that works', 'Base: people who chose a time'],
  ['schedulePairs', 'Best day and time together', 'Base: people who chose both a specific day and time'],
  ['format', 'How they prefer to join', 'Base: people who chose a format'],
  ['recommendations', 'Next step they were given', 'Base: everyone in this group'],
];

function renderCharts() {
  const summary = state.report[state.window][state.cohort];
  if (summary.status !== 'ready') {
    els.charts.replaceChildren(el('div', { class: 'chart' },
      el('p', { class: 'small', text: `Fewer than ${state.report.minimumBase} responses in this group and time window, so the breakdown is hidden to protect privacy and avoid misleading percentages.` })));
    return;
  }
  els.charts.replaceChildren(...chartDefs.filter(([key]) => summary[key]).map(([key, title, baseNote]) => {
    const dist = summary[key];
    const card = el('section', { class: 'chart', 'aria-label': title }, el('h3', { text: title }));
    if (dist.status !== 'ready') {
      card.append(el('p', { class: 'small', text: `Fewer than ${state.report.minimumBase} answers — not shown.` }));
      return card;
    }
    card.append(el('p', { class: 'base', text: `${baseNote} · ${dist.denominator} people` }));
    const shown = key === 'schedulePairs' ? dist.options.filter(o => o.count > 0) : dist.options;
    if (!shown.length) { card.append(el('p', { class: 'small', text: 'No answers yet.' })); return card; }
    const max = Math.max(...shown.map(o => o.percent), 1);
    card.append(el('ul', { class: 'bars' }, shown.map(o => {
      const fill = el('div', { class: 'bar-fill' + (o.count === 0 ? ' zero' : '') });
      fill.style.width = `${(o.percent / max) * 100}%`;
      return el('li', { class: 'bar-row', tabindex: '0', 'data-tip': `${o.label}: ${o.count} of ${dist.denominator} (${o.percent}%)` },
        el('span', { class: 'bar-label', text: o.label }),
        el('span', { class: 'bar-track', 'aria-hidden': 'true' }, fill),
        el('span', { class: 'bar-value', text: `${o.count} · ${o.percent}%` }));
    })));
    return card;
  }));
}

/* ---------- responses table (manager) ---------- */

function filteredRecords() {
  const q = els.search.value.trim().toLowerCase();
  return state.records.filter(r => {
    if (els.namedOnly.checked && !r.answers.name) return false;
    if (!q) return true;
    return [r.answers.name, r.answers.comment].some(t => t && t.toLowerCase().includes(q));
  });
}

function rowCells(r) {
  const a = r.answers;
  const dayTime = [label('day', a.day), label('time', a.time)].filter(Boolean).join(' · ');
  return {
    received: dateTime.format(new Date(r.createdAt)),
    name: a.name ?? '',
    attendance: label('attendance', a.attendance),
    barriers: a.barriers.map(b => label('barriers', b)).join('; '),
    priority: label('priority', a.priority),
    dayTime,
    format: label('format', a.format),
    comment: a.comment ?? '',
    next: r.recommendation.label,
    rule: ruleText[r.recommendation.rule] ?? r.recommendation.rule,
  };
}

function renderResponses() {
  els.responsesCard.hidden = state.role !== 'manager';
  if (state.role !== 'manager') return;
  const list = filteredRecords();
  els.rows.replaceChildren(...list.map(r => {
    const c = rowCells(r);
    return el('tr', {},
      el('td', { text: c.received }),
      el('td', { class: 'name' }, c.name ? c.name : el('span', { class: 'anon', text: 'Anonymous' })),
      el('td', { text: c.attendance }),
      el('td', { text: c.barriers }),
      el('td', { text: c.priority }),
      el('td', { text: c.dayTime || '—' }),
      el('td', { text: c.format || '—' }),
      el('td', { class: 'comment', text: c.comment || '—' }),
      el('td', {}, c.next, el('span', { class: 'rule', text: c.rule })));
  }));
  if (!list.length) {
    els.rows.replaceChildren(el('tr', {}, el('td', { colspan: '9', class: 'anon', text: state.records.length ? 'No responses match.' : 'No responses yet.' })));
  }
  const named = state.records.filter(r => r.answers.name).length;
  els.responsesNote.textContent =
    `Showing ${list.length} of ${state.records.length} loaded · ${named} gave a name · Newest first. ` +
    'Names and comments are private: share only the charts and suggestions with volunteers.';
  els.more.hidden = state.nextBefore == null;
}

async function loadMore() {
  els.more.disabled = true;
  try {
    const page = await api(`api/staff/responses?limit=100&before=${encodeURIComponent(state.nextBefore)}`);
    state.records.push(...page.records);
    state.nextBefore = page.nextBefore;
    renderResponses();
  } catch (err) {
    if (err.status === 401) return signOut();
    showBanner(err.body?.message ?? 'Could not load more responses.');
  } finally {
    els.more.disabled = false;
  }
}

function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;           // stop spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  const header = ['Received', 'Name', 'Follow-ups (30 days)', 'Harder to join', 'Would most like', 'Day', 'Time', 'Format', 'Comment', 'Next step', 'Why'];
  const lines = [header.map(csvCell).join(',')];
  for (const r of filteredRecords()) {
    const c = rowCells(r);
    lines.push([c.received, c.name, c.attendance, c.barriers, c.priority, label('day', r.answers.day), label('time', r.answers.time),
      c.format, c.comment, c.next, c.rule].map(csvCell).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `aol-programs-responses-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- wiring ---------- */

if (location.pathname.startsWith('/staff/')) {
  const nav = $('dashboard-nav');
  const followupsPanel = $('followups-panel');
  const carePanel = $('care-panel');
  const careSession = $('care-session');
  const careSections = ['people', 'events', 'today'];
  let careUser = null;
  document.body.classList.add('integrated-dashboard');
  nav.hidden = false;

  function selectSection(section) {
    document.body.dataset.section = section;
    followupsPanel.hidden = section !== 'followups';
    carePanel.hidden = section === 'followups';
    careSession.hidden = section === 'followups' || !careUser;
    nav.querySelectorAll('a').forEach(link => {
      if (link.dataset.section === section) {
        link.setAttribute('aria-current', 'page');
        $('dashboard-title').textContent = link.textContent;
      } else link.removeAttribute('aria-current');
    });
  }

  function navigate() {
    const name = location.hash.slice(1);
    const section = careSections.includes(name) ? name : 'followups';
    selectSection(section);
    if (section === 'followups') return;
    if (!carePanel.getAttribute('src')) carePanel.src = `/care/?embedded=staff#${section}`;
    else if (carePanel.contentWindow.location.hash !== `#${section}`) carePanel.contentWindow.location.hash = section;
  }

  carePanel.addEventListener('load', () => {
    carePanel.contentWindow.addEventListener('hashchange', () => {
      const name = carePanel.contentWindow.location.hash.slice(1).split('/')[0];
      const section = name === 'person' ? 'people' : name === 'event' ? 'events' : name;
      if (!careSections.includes(section) || carePanel.hidden) return;
      selectSection(section);
      history.replaceState(null, '', `#${section}`);
    });
    navigate();
  });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== carePanel.contentWindow || event.data?.type !== 'care-session') return;
    const user = event.data.user;
    if (user !== null && (typeof user?.name !== 'string' || !['manager', 'volunteer'].includes(user.role))) return;
    careUser = user;
    $('care-name').textContent = user?.name ?? '';
    $('care-role').textContent = user?.role === 'manager' ? 'Manager' : user ? 'Volunteer' : '';
    careSession.hidden = carePanel.hidden || !user;
  });
  $('care-sign-out').addEventListener('click', () => {
    carePanel.contentWindow.postMessage({ type: 'care-sign-out' }, location.origin);
  });
  window.addEventListener('hashchange', navigate);
  navigate();
}

els.signinForm.addEventListener('submit', e => {
  e.preventDefault();
  const name = els.name.value.trim();
  const token = els.token.value.trim();
  if (!name) {
    els.signinError.textContent = 'Enter your name.';
    els.signinError.hidden = false;
    els.name.focus();
    return;
  }
  if (token) signIn(token, name);
});
els.signOut.addEventListener('click', signOut);
els.refresh.addEventListener('click', refresh);
els.windowSeg.addEventListener('click', e => {
  const b = e.target.closest('button[data-window]');
  if (!b) return;
  state.window = b.dataset.window;
  renderFilters(); renderCharts();
});
els.cohortSeg.addEventListener('click', e => {
  const b = e.target.closest('button[data-cohort]');
  if (!b) return;
  state.cohort = b.dataset.cohort;
  renderFilters(); renderCharts();
});
els.search.addEventListener('input', renderResponses);
els.namedOnly.addEventListener('change', renderResponses);
els.more.addEventListener('click', loadMore);
els.exportBtn.addEventListener('click', exportCsv);

const saved = storage.get();
const savedName = storage.getName()?.trim();
if (savedName) els.name.value = savedName;
if (saved && savedName) signIn(saved, savedName);
else {
  if (saved) {
    els.token.value = saved;
    els.signinError.textContent = 'Enter your name to continue with your saved survey session.';
    els.signinError.hidden = false;
  }
  els.name.focus();
}
