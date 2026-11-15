import {
  answersPayload, commentLength, payloadKey, retryDelay, retryableStatus, toggleBarrier, validateAnswers,
} from './logic.js';

const API = {
  survey: 'api/survey',
  responses: 'api/responses',
};
const MAX_ATTEMPTS = 3;

const $ = id => document.getElementById(id);
const els = {
  title: $('title'),
  introduction: $('introduction'),
  privacy: $('privacy'),
  loading: $('loading'),
  loadError: $('load-error'),
  reload: $('reload'),
  form: $('survey'),
  formAlert: $('form-alert'),
  questions: $('questions'),
  submit: $('submit'),
  submitStatus: $('submit-status'),
  done: $('done'),
  thankYou: $('thank-you'),
  nextStep: $('next-step'),
};

let schema = null;
let answers = emptyAnswers();
let pending = null;       // { key, submissionId } – reused only for an identical retry
let submitting = false;
const ui = {};            // per-question DOM handles

function emptyAnswers() {
  return { attendance: null, barriers: [], priority: null, day: null, time: null, format: null, comment: '', name: '' };
}

/* ---------- helpers ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child) node.append(child);
  return node;
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  // Fallback for non-secure origins (e.g. a phone testing over plain http on the LAN).
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function show(section) {
  for (const s of [els.loading, els.loadError, els.form, els.done]) s.hidden = s !== section;
}

/* ---------- loading the schema ---------- */

async function loadSurvey() {
  show(els.loading);
  try {
    const res = await fetch(API.survey, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    schema = await res.json();
  } catch {
    show(els.loadError);
    return false;
  }
  renderSurvey();
  show(els.form);
  return true;
}

/* ---------- rendering ---------- */

function renderSurvey() {
  document.title = schema.title;
  els.title.textContent = schema.title;
  els.introduction.textContent = schema.introduction;
  els.privacy.textContent = schema.privacyNote;
  els.submit.textContent = schema.submitLabel;

  // Drop any kept answer that the (possibly refreshed) schema no longer offers.
  const byId = Object.fromEntries(schema.questions.map(q => [q.id, q]));
  const valid = (q, id) => q?.options?.some(o => o.id === id);
  const scheduleFields = Object.fromEntries((byId.schedule?.fields ?? []).map(f => [f.id, f]));
  if (!valid(byId.attendance, answers.attendance)) answers.attendance = null;
  answers.barriers = answers.barriers.filter(id => valid(byId.barriers, id));
  if (!valid(byId.priority, answers.priority)) answers.priority = null;
  if (!valid(scheduleFields.day, answers.day)) answers.day = null;
  if (!valid(scheduleFields.time, answers.time)) answers.time = null;
  if (!valid(byId.format, answers.format)) answers.format = null;

  els.questions.replaceChildren(...schema.questions.map((q, index) => renderQuestion(q, index + 1)));
}

function promptLegend(q, number) {
  return el('legend', { class: 'prompt', id: `${q.id}-legend` },
    `${number}. ${q.prompt}`,
    q.required ? null : el('span', { class: 'tag', text: 'Optional' }),
  );
}

function errorSlot(id) {
  return el('p', { class: 'field-error', id: `${id}-error`, hidden: true });
}

function renderQuestion(q, number) {
  if (q.type === 'single') return renderSingle(q, number);
  if (q.type === 'multiple') return renderMultiple(q, number);
  if (q.type === 'group') return renderSchedule(q, number);
  if (q.type === 'text') return renderText(q, number);
  return el('div');
}

function radioList(name, options, current, onPick) {
  return el('div', { class: 'options' }, options.map(option => {
    const input = el('input', {
      type: 'radio', name, value: option.id, id: `${name}-${option.id}`,
      checked: current === option.id,
      onchange: () => onPick(option.id),
    });
    return el('label', { class: 'choice', for: input.id }, input, el('span', { text: option.label }));
  }));
}

function clearButton(label, onClear) {
  return el('button', { type: 'button', class: 'clear', text: label, hidden: true, onclick: onClear });
}

function renderSingle(q, number) {
  const error = errorSlot(q.id);
  let clear = null;
  const list = radioList(q.id, q.options, answers[q.id], id => {
    answers[q.id] = id;
    if (clear) clear.hidden = false;
    clearFieldError(q.id);
  });
  if (!q.required) {
    clear = clearButton('Clear selection', () => {
      answers[q.id] = null;
      for (const input of list.querySelectorAll('input')) input.checked = false;
      clear.hidden = true;
      list.querySelector('input')?.focus();
    });
    clear.hidden = answers[q.id] == null;
  }
  const fieldset = el('fieldset', { class: 'question', id: `q-${q.id}`, 'aria-describedby': error.id },
    promptLegend(q, number),
    q.hint ? el('p', { class: 'hint', text: q.hint }) : null,
    error, list, clear,
  );
  ui[q.id] = { fieldset, error, focus: () => list.querySelector('input:checked, input')?.focus() };
  return fieldset;
}

function renderMultiple(q, number) {
  const error = errorSlot(q.id);
  const exclusive = q.exclusiveOptions ?? [];
  const max = q.maxSelections ?? 2;
  const limitNote = el('p', { class: 'note limit', id: `${q.id}-limit`, role: 'status', hidden: true,
    text: `You can choose up to ${max}. Untick one to change it.` });
  const otherNote = el('p', { class: 'note', id: `${q.id}-other`, role: 'status', hidden: true, text: q.otherHint ?? '' });

  const inputs = [];
  const sync = () => {
    for (const input of inputs) input.checked = answers.barriers.includes(input.value);
    otherNote.hidden = !(q.otherOption && answers.barriers.includes(q.otherOption));
  };
  const list = el('div', { class: 'options' }, q.options.map(option => {
    const input = el('input', {
      type: 'checkbox', name: q.id, value: option.id, id: `${q.id}-${option.id}`,
      onchange: event => {
        const result = toggleBarrier(answers.barriers, option.id, event.target.checked, { exclusive, max });
        answers.barriers = result.selected;
        limitNote.hidden = !result.limitReached;
        sync();
        clearFieldError(q.id);
      },
    });
    inputs.push(input);
    return el('label', { class: 'choice', for: input.id }, input, el('span', { text: option.label }));
  }));
  sync();

  const fieldset = el('fieldset', { class: 'question', id: `q-${q.id}`, 'aria-describedby': `${q.id}-hint ${error.id}` },
    promptLegend(q, number),
    el('p', { class: 'hint', id: `${q.id}-hint`, text: q.hint ?? `Choose up to ${max}.` }),
    error, list, limitNote, otherNote,
  );
  ui[q.id] = { fieldset, error, focus: () => inputs.find(i => i.checked)?.focus() ?? inputs[0]?.focus() };
  return fieldset;
}

function renderSchedule(q, number) {
  const error = errorSlot(q.id);
  const groups = q.fields.map(field => {
    const name = field.id;
    let clear;
    const list = radioList(name, field.options, answers[name], id => {
      answers[name] = id;
      clear.hidden = false;
      clearFieldError(q.id);
    });
    clear = clearButton(`Clear ${field.label.toLowerCase()}`, () => {
      answers[name] = null;
      for (const input of list.querySelectorAll('input')) input.checked = false;
      clear.hidden = true;
      list.querySelector('input')?.focus();
    });
    clear.hidden = answers[name] == null;
    return el('fieldset', { class: 'subgroup', id: `q-${name}` },
      el('legend', { class: 'sublabel', text: field.label }), list, clear);
  });
  const fieldset = el('fieldset', { class: 'question', id: `q-${q.id}`, 'aria-describedby': `${q.id}-hint ${error.id}` },
    promptLegend(q, number),
    q.hint ? el('p', { class: 'hint', id: `${q.id}-hint`, text: q.hint }) : null,
    error,
    el('div', { class: 'schedule' }, groups),
  );
  const handle = { fieldset, error, focus: () => fieldset.querySelector('input')?.focus() };
  ui[q.id] = handle;
  ui.day = handle;   // 422 field names map onto the schedule group
  ui.time = handle;
  return fieldset;
}

function renderText(q, number) {
  const max = q.maxLength ?? 240;
  const line = q.input === 'line';
  const error = errorSlot(q.id);
  const counter = el('p', { class: 'counter', id: `${q.id}-count`, 'aria-live': 'polite' });
  const area = el(line ? 'input' : 'textarea', {
    id: `${q.id}-input`, name: q.id,
    type: line ? 'text' : null,
    rows: line ? null : '4',
    autocomplete: q.autocomplete ?? 'off',
    spellcheck: line ? 'false' : 'true',
    'aria-describedby': `${q.id}-hint ${q.id}-count ${error.id}`,
  });
  area.value = answers[q.id] ?? '';
  const update = () => {
    const used = commentLength(area.value);
    counter.textContent = `${used} / ${max}`;
    counter.classList.toggle('over', used > max);
  };
  area.addEventListener('input', () => {
    answers[q.id] = area.value;
    update();
    if (commentLength(area.value) <= max) clearFieldError(q.id);
  });
  update();
  // A <label> (not a legend) keeps the prompt as the field's accessible name.
  const fieldset = el('div', { class: 'question', id: `q-${q.id}` },
    el('label', { for: area.id, class: 'prompt prompt-label' },
      `${number}. ${q.prompt}`, q.required ? null : el('span', { class: 'tag', text: 'Optional' })),
    q.hint ? el('p', { class: 'hint', id: `${q.id}-hint`, text: q.hint }) : null,
    error, area, line ? null : counter,
  );
  ui[q.id] = { fieldset, error, input: area, focus: () => area.focus() };
  return fieldset;
}

/* ---------- errors ---------- */

function clearFieldError(id) {
  const handle = ui[id];
  if (!handle) return;
  handle.error.hidden = true;
  handle.error.textContent = '';
  handle.fieldset.classList.remove('has-error');
  handle.input?.removeAttribute('aria-invalid');
}

function clearAllErrors() {
  for (const id of Object.keys(ui)) clearFieldError(id);
  els.formAlert.hidden = true;
  els.formAlert.textContent = '';
}

function showFieldErrors(fields) {
  let first = null;
  const order = ['attendance', 'barriers', 'priority', 'day', 'time', 'format', 'comment', 'name'];
  for (const id of order) {
    if (!fields[id] || !ui[id]) continue;
    const handle = ui[id];
    handle.error.textContent = handle.error.hidden ? fields[id] : `${handle.error.textContent} ${fields[id]}`;
    handle.error.hidden = false;
    handle.fieldset.classList.add('has-error');
    handle.input?.setAttribute('aria-invalid', 'true');
    first ??= handle;
  }
  if (fields.form) showAlert(fields.form);
  else if (first) {
    const count = Object.keys(fields).length;
    showAlert(count === 1 ? 'Please check the highlighted answer.' : 'Please check the highlighted answers.', false);
    first.fieldset.scrollIntoView({ behavior: 'smooth', block: 'center' });
    first.focus();
  }
}

function showAlert(message, focus = true) {
  els.formAlert.textContent = message;
  els.formAlert.hidden = false;
  if (focus) {
    els.formAlert.scrollIntoView({ behavior: 'smooth', block: 'center' });
    els.formAlert.focus();
  }
}

/* ---------- submitting ---------- */

function setSubmitting(on, message = '') {
  submitting = on;
  els.submit.setAttribute('aria-disabled', on ? 'true' : 'false');
  els.submit.replaceChildren(
    ...(on ? [el('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Saving…'] : [schema.submitLabel]),
  );
  els.submitStatus.textContent = message;
}

async function onSubmit(event) {
  event.preventDefault();
  if (submitting) return;             // ignore repeat taps while saving
  clearAllErrors();

  const payloadAnswers = answersPayload(answers);
  if (!schema.questions.some(q => q.id === 'name')) delete payloadAnswers.name;
  const commentQuestion = schema.questions.find(q => q.id === 'comment');
  const barrierQuestion = schema.questions.find(q => q.id === 'barriers');
  const nameQuestion = schema.questions.find(q => q.id === 'name');
  const fields = validateAnswers(payloadAnswers, {
    maxComment: commentQuestion?.maxLength ?? 240,
    maxName: nameQuestion?.maxLength ?? 80,
    exclusive: barrierQuestion?.exclusiveOptions ?? [],
  });
  if (Object.keys(fields).length) return showFieldErrors(fields);

  // Same answers as a failed attempt → same UUID (safe replay). Anything changed → new UUID.
  const key = payloadKey(schema.version, payloadAnswers);
  if (!pending || pending.key !== key) pending = { key, submissionId: uuid() };
  const body = JSON.stringify({ surveyVersion: schema.version, submissionId: pending.submissionId, ...payloadAnswers });

  setSubmitting(true, 'Saving your feedback…');
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetch(API.responses, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body,
        cache: 'no-store',
      });
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        setSubmitting(true, 'Connection problem. Trying again…');
        await sleep(2000 * attempt);
        continue;
      }
      setSubmitting(false);
      return showAlert('We couldn’t reach the server. Your answers are still here. Check your connection and tap Share feedback again.');
    }

    let data = null;
    try { data = await res.json(); } catch { /* non-JSON error page from a proxy */ }

    if (res.status === 200 || res.status === 201) return showReceipt(data);

    if (res.status === 422) {
      setSubmitting(false);
      pending = null; // a corrected submission gets a new UUID
      return showFieldErrors(data?.fields ?? { form: data?.message ?? 'Please check your answers.' });
    }

    if (res.status === 409 && data?.error === 'survey_updated') {
      pending = null;
      const reloaded = await loadSurvey();
      setSubmitting(false);
      if (reloaded) showAlert('The survey was just updated. Please check your answers and tap Share feedback again.');
      return;
    }

    if (res.status === 409) {
      pending = null;
      setSubmitting(false);
      return showAlert('Please tap Share feedback again to send your latest answers.');
    }

    if (retryableStatus(res.status) && attempt < MAX_ATTEMPTS) {
      const wait = retryDelay(res.headers.get('Retry-After'), 2000 * attempt);
      setSubmitting(true, `The server is busy. Trying again in ${Math.ceil(wait / 1000)} s…`);
      await sleep(wait);
      continue;
    }

    setSubmitting(false);
    return showAlert(
      (data?.message ? data.message + ' ' : 'Something went wrong. ') +
      'Your answers are still here. Please tap Share feedback again.',
    );
  }
}

function showReceipt(receipt) {
  const rec = receipt?.recommendation;
  let href = null;
  try {
    const url = new URL(rec?.href);
    if (url.protocol === 'https:') href = url.href;
  } catch { /* leave href null */ }

  els.thankYou.textContent = receipt?.thankYou ?? '';
  if (rec?.label && href) {
    els.nextStep.textContent = rec.label;
    els.nextStep.href = href;
    els.nextStep.hidden = false;
  } else {
    els.nextStep.hidden = true;
  }
  pending = null;
  submitting = false;
  show(els.done);
  window.scrollTo({ top: 0 });
  els.thankYou.focus();
}

/* ---------- start ---------- */

els.form.addEventListener('submit', onSubmit);
els.reload.addEventListener('click', loadSurvey);
loadSurvey();
