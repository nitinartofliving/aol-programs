import { api, h, setupSignIn, toast } from './shared/kit.js';

const $ = id => document.getElementById(id);
const dialog = $('dialog');
let me = null;

$('askForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('askError').textContent = '';
  const question = $('question').value.trim();
  if (!question) { $('askError').textContent = 'Type a question first.'; return; }
  try {
    const r = await api('api/ask', { method: 'POST', body: { question } });
    $('answer').hidden = false;
    $('answer').classList.toggle('none', !r.found);
    $('answerText').textContent = r.answer;
    $('answerSource').textContent = r.source;
  } catch (err) {
    if (err.status === 401) return signedOut();
    $('askError').textContent = err.message;
  }
});

async function loadKnowledge() {
  const list = await api('api/knowledge');
  $('kbCount').textContent = list.length;
  const manager = me.role === 'manager';
  $('kb').replaceChildren(...list.map(k => h('details', null,
    h('summary', null, k.question),
    h('div', { class: 'body' },
      k.alternatives.length ? h('p', { class: 'muted small' }, 'Also matches: ', k.alternatives.join(' · ')) : null,
      h('p', null, k.answer),
      h('p', { class: 'small' }, h('strong', null, 'Source: '), k.source),
      manager && h('div', { class: 'row' },
        h('button', { class: 'btn small', type: 'button', onclick: () => edit(k) }, 'Edit'),
        h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
          if (!confirm(`Remove the answer to "${k.question}"?`)) return;
          await api('api/knowledge/' + k.id, { method: 'DELETE' }); toast('Answer removed.'); loadKnowledge();
        } }, 'Remove'))))));
  if (!list.length) $('kb').append(h('p', { class: 'muted' }, 'No approved answers yet.'));
}

function edit(k) {
  const form = h('form', { method: 'dialog', novalidate: true },
    h('h2', null, k ? 'Edit answer' : 'Add an approved answer'),
    h('label', null, 'Question', h('input', { name: 'question', maxlength: 200, required: true, value: k?.question ?? '' })),
    h('label', null, 'Other ways people ask it ', h('span', { class: 'optional' }, '(one per line)'),
      h('textarea', { name: 'alternatives', rows: 3, value: (k?.alternatives ?? []).join('\n') })),
    h('label', null, 'Answer', h('textarea', { name: 'answer', rows: 5, maxlength: 1500, required: true, value: k?.answer ?? '' })),
    h('label', null, 'Source', h('input', { name: 'source', maxlength: 150, required: true, placeholder: 'Document name or link', value: k?.source ?? '' })),
    h('p', { class: 'error', role: 'alert' }),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', type: 'submit' }, 'Save'), h('button', { class: 'btn', type: 'button', onclick: () => dialog.close() }, 'Cancel')));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const f = form.elements;
    const body = { question: f.question.value, alternatives: f.alternatives.value.split('\n').map(s => s.trim()).filter(Boolean), answer: f.answer.value, source: f.source.value };
    try {
      await api(k ? 'api/knowledge/' + k.id : 'api/knowledge', { method: k ? 'PUT' : 'POST', body });
      dialog.close(); toast('Answer saved.'); loadKnowledge();
    } catch (err) { form.querySelector('.error').textContent = err.message; }
  });
  dialog.replaceChildren(form);
  dialog.showModal();
}

function signedOut() {
  me = null;
  $('app').hidden = true;
  $('signin').hidden = false;
}

$('addEntry').addEventListener('click', () => edit(null));
setupSignIn({
  form: $('signinForm'),
  error: $('signinError'),
  signOut: $('signOut'),
  meUrl: 'api/me',
  onSignedIn(data) {
    me = data;
    $('signin').hidden = true;
    $('app').hidden = false;
    $('whoName').textContent = me.name;
    $('whoRole').textContent = me.role === 'manager' ? 'Manager' : 'Volunteer';
    $('whoRole').className = me.role === 'manager' ? 'badge accent' : 'badge';
    $('addEntry').hidden = me.role !== 'manager';
    $('kbHint').hidden = me.role === 'manager';
    loadKnowledge().catch(() => {});
    $('question').focus();
  },
  onSignedOut: signedOut,
});
