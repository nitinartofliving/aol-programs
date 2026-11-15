// Small helpers shared by the People and SevaAssist pages.
// The staff token is kept in this browser tab only (sessionStorage) and is
// shared between the People and SevaAssist tabs.

const TOKEN_KEY = 'aol-care-token';
const NAME_KEY = 'aol-care-name';

const store = {
  get(k) { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch {} },
};
export const session = {
  get token() { return store.get(TOKEN_KEY); },
  get name() { return store.get(NAME_KEY); },
  save(token, name) { store.set(TOKEN_KEY, token); store.set(NAME_KEY, name); },
  clear() { store.set(TOKEN_KEY, ''); },
};

export class ApiError extends Error { constructor(status, body) { super(body?.error || 'Something went wrong.'); this.status = status; this.body = body; } }

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json', Authorization: 'Bearer ' + session.token, 'X-Volunteer-Name': encodeURIComponent(session.name) };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// h('div', { class: 'x', onclick: fn }, 'text', child) — builds DOM without innerHTML.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

let toastTimer;
export function toast(message) {
  let t = document.querySelector('.toast');
  if (!t) { t = h('div', { class: 'toast', role: 'status' }); document.body.append(t); }
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// Wires the sign-in form: calls onSignedIn(me) once a token is accepted.
export function setupSignIn({ form, error, signOut, meUrl, onSignedIn, onSignedOut }) {
  const tokenInput = form.querySelector('[name=token]');
  const nameInput = form.querySelector('[name=name]');
  nameInput.value = session.name;
  async function check() {
    try { onSignedIn(await api(meUrl)); return true; } catch (e) {
      if (e.status === 401) { session.clear(); onSignedOut(); return false; }
      throw e;
    }
  }
  async function signIn(token, name) {
    session.save(token, name);
    return check();
  }
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    error.textContent = '';
    const name = nameInput.value.trim();
    if (!name) { error.textContent = 'Enter your name so others can see who is following up.'; return; }
    try {
      if (!(await signIn(tokenInput.value.trim(), name))) error.textContent = 'That token was not accepted. Check it with your manager.';
      else tokenInput.value = '';
    } catch { error.textContent = 'Could not reach the server. Try again.'; }
  });
  signOut?.addEventListener('click', () => { session.clear(); onSignedOut(); });
  if (session.token) check().catch(() => onSignedOut()); else onSignedOut();
  return signIn;
}

export function formatDate(key, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  if (!key) return '';
  const [y, m, d] = key.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}
export function formatDateTime(local) {
  if (!local) return '';
  const [date, time] = local.split('T');
  const [hh, mm] = time.split(':').map(Number);
  const t = new Date(Date.UTC(2000, 0, 1, hh, mm)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
  return `${formatDate(date)} · ${t}`;
}
export function formatWhen(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
