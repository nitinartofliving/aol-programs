(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const state = { cfg: null, job: null, survey: null, city: null, baseJob: null, baseSurvey: null, eventLink: null, busy: false, adminToken: sessionStorage.getItem('adminToken') || '' };
  let formVersion = 0;
  let localIssue = false;
  const fieldErrors = new Map();

  function clearFieldError(control) {
    const entry = fieldErrors.get(control);
    if (!entry) return;
    entry.message.remove();
    if (entry.describedBy === null) control.removeAttribute('aria-describedby');
    else control.setAttribute('aria-describedby', entry.describedBy);
    control.removeAttribute('aria-invalid');
    fieldErrors.delete(control);
  }
  function clearFieldErrors() {
    for (const control of fieldErrors.keys()) clearFieldError(control);
  }
  function answersChanged(control) {
    formVersion++;
    if (control) clearFieldError(control);
    if (control?.classList.contains('s-end') && !control.value) {
      const row = control.closest('.row');
      clearFieldError(row.querySelector('.s-date'));
      clearFieldError(row.querySelector('.s-start'));
    }
    $('addEventError').textContent = '';
    updateEventLinkStatus();
    if (localIssue && !state.busy) {
      $('status').textContent = 'Answers changed. Select Make my flyer to check them again.';
    } else if (state.job?.status === 'NEEDS_INPUT' && !state.busy && $('questions').children.length) {
      $('status').textContent = 'Answers changed. Select Make my flyer to check them again. The questions below are from the last check.';
    }
  }

  function questionTarget(field) {
    const direct = {
      'offering.raw_text': 'offer', 'offering.approved_description': 'approved',
      'schedule.timezone': 'tz', 'location.city': 'city', 'location.venue': 'venue',
      'location.delivery_mode': 'mode', 'action.destination_url': 'url',
      'format': 'format', 'imagery.include_gurudev': 'gurudev',
      'imagery.city_photo_asset_id': 'cityFile', 'assets.logo': 'opBtn',
    };
    if (direct[field]) return field === 'location.delivery_mode' ? document.querySelector('#mode input:checked') : $(direct[field]);
    if (field === 'schedule.sessions') return document.querySelector('#sessions .s-date') || $('addSession');
    if (field === 'contacts') return document.querySelector('#contacts .c-phone') || $('addContact');
    let m = /^schedule\.sessions\[(\d+)\]\.(date|start_time|end_time)$/.exec(field);
    if (m) {
      const rows = [...document.querySelectorAll('#sessions .row')].filter(row => row.querySelector('.s-date').value || row.querySelector('.s-start').value);
      return rows[Number(m[1])]?.querySelector({ date: '.s-date', start_time: '.s-start', end_time: '.s-end' }[m[2]]);
    }
    m = /^contacts\[(\d+)\]\.(email|phone)$/.exec(field);
    if (m) {
      const rows = [...document.querySelectorAll('#contacts .row')].filter(row => [...row.querySelectorAll('input')].some(input => input.value.trim()));
      return rows[Number(m[1])]?.querySelector('.c-' + m[2]);
    }
    return null;
  }

  function showFieldError(control, text) {
    if (!control) return;
    let entry = fieldErrors.get(control);
    if (!entry) {
      const message = document.createElement('span');
      message.className = 'field-error';
      message.id = 'field-error-' + (document.querySelectorAll('.field-error').length + 1);
      const label = control.closest('label');
      if (label) label.append(message); else control.insertAdjacentElement('afterend', message);
      entry = { message, describedBy: control.getAttribute('aria-describedby') };
      fieldErrors.set(control, entry);
      control.setAttribute('aria-describedby', [entry.describedBy, message.id].filter(Boolean).join(' '));
      if (control.matches('input, select, textarea')) control.setAttribute('aria-invalid', 'true');
    }
    entry.message.textContent += (entry.message.textContent ? ' ' : '') + text;
  }

  async function api(path, opt = {}) {
    const headers = { 'Content-Type': 'application/json' }; if (state.adminToken) headers['x-admin-token'] = state.adminToken;
    const res = await fetch(path, { method: opt.method || 'GET', headers, body: opt.body ? JSON.stringify(opt.body) : undefined });
    const data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data.error || 'Request failed (' + res.status + ')'); return data;
  }
  const fileToB64 = f => new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(f); });

  // ---------- form rows ----------
  function addSession(v = {}) {
    const d = document.createElement('div'); d.className = 'row';
    d.innerHTML = `<label>Date<input type="date" class="s-date" value="${esc(v.date || '')}"></label><label>Starts<input type="time" class="s-start" value="${esc(v.start_time || '')}"></label><label>Ends (optional)<input type="time" class="s-end" value="${esc(v.end_time || '')}"></label><button class="x" type="button" aria-label="Remove this date">×</button>`;
    d.querySelector('.x').onclick = () => { d.remove(); answersChanged(); }; $('sessions').appendChild(d);
  }
  function addContact(v = {}) {
    const d = document.createElement('div'); d.className = 'row c';
    d.innerHTML = `<label>Name<input type="text" class="c-name" value="${esc(v.name || '')}"></label><label>Phone<input type="tel" class="c-phone" value="${esc(v.phone || '')}"></label><label>Email<input type="email" class="c-email" value="${esc(v.email || '')}"></label><button class="x" type="button" aria-label="Remove this contact">×</button>`;
    d.querySelector('.x').onclick = () => { d.remove(); answersChanged(); }; $('contacts').appendChild(d);
  }
  function collectSurvey() {
    const moods = [...document.querySelectorAll('#moods input:checked')].map(i => i.value), other = $('moodOther').value.trim(); if (other) moods.push(other);
    const mode = document.querySelector('input[name=mode]:checked').value;
    return {
      mode: state.baseJob ? 'revise' : 'create',
      offering: { raw_text: $('offer').value, programme_id: null, approved_description: $('approved').value || null },
      mood: { selected: moods },
      imagery: { include_gurudev: $('gurudev').checked, include_city_photo: $('cityOn').checked, city_photo_asset_id: $('cityOn').checked && state.city ? state.city.asset_id : null, city_photo_metrics: $('cityOn').checked && state.city ? { sharpness: state.city.sharpness } : null },
      schedule: { timezone: $('tz').value || null, sessions: [...document.querySelectorAll('#sessions .row')].map(r => ({ date: r.querySelector('.s-date').value, start_time: r.querySelector('.s-start').value, end_time: r.querySelector('.s-end').value || null })) },
      location: { delivery_mode: mode, city: $('city').value, venue: $('venue').value, address: $('address').value, on_course_page: $('onpage').checked },
      contacts: [...document.querySelectorAll('#contacts .row')].map(r => ({ name: r.querySelector('.c-name').value, phone: r.querySelector('.c-phone').value, email: r.querySelector('.c-email').value })),
      action: { include_qr: location.pathname.startsWith('/flyer/') || $('qrOn').checked, destination_url: $('url').value || null, destination_type: $('dtype').value || null },
      format: $('format').value, extra_notes: $('notes').value, revision: { base_artifact_id: null, requested_changes: [], locked_elements: [] }
    };
  }
  function eventDraft(survey) {
    const lines = survey.offering.raw_text.split('\n').map(line => line.trim()).filter(Boolean);
    const first = survey.schedule.sessions[0];
    return {
      title: lines[0] || '',
      program: $('eventType').value || 'Other',
      startsAt: first?.date && first?.start_time ? first.date + 'T' + first.start_time : '',
      place: [survey.location.venue, survey.location.address, survey.location.city].map(s => s.trim()).filter(Boolean).join(', '),
      description: [lines.slice(1).join('\n'), survey.offering.approved_description?.trim()].filter(Boolean).join('\n\n'),
      registrationUrl: $('url').value.trim(),
      teacher: '',
    };
  }
  function matchesEvent(draft, event) {
    return ['title', 'startsAt', 'place', 'description', 'registrationUrl', 'program'].every(key => draft[key] === (event[key] || ''));
  }
  function updateEventLinkStatus() {
    if (!$('eventLinkStatus')) return;
    const ev = state.eventLink?.event;
    $('eventLinkStatus').textContent = ev && matchesEvent(eventDraft(collectSurvey()), ev)
      ? 'Event created. The QR will use the selected destination.'
      : 'An event will be created automatically when you make the flyer.';
  }
  function readEventLink() {
    try {
      const raw = sessionStorage.getItem('aol-flyer-event-link');
      state.eventLink = raw ? JSON.parse(raw) : null;
      updateEventLinkStatus();
    } catch {
      state.eventLink = null;
      $('eventLinkStatus').textContent = 'Could not read the event link. Check browser storage.';
    }
  }
  function signInForEvent(survey) {
    sessionStorage.setItem('aol-flyer-survey', JSON.stringify({ survey, city: state.city, program: $('eventType').value, useOurForm: $('qrOn').checked }));
    sessionStorage.setItem('aol-flyer-signin-pending', '1');
    $('status').textContent = 'Sign in to People to automatically create the event and continue making the flyer.';
    if (window.parent !== window) window.parent.location.hash = '#people';
    else location.href = '/care/';
  }
  async function automaticEvent(draft, staffApi, checkedVersion) {
    const linked = state.eventLink?.event;
    if (linked && matchesEvent(draft, linked)) {
      const response = await fetch('/e/api/events/' + encodeURIComponent(linked.slug), { cache: 'no-store' });
      if (response.ok) {
        const current = await response.json();
        if (current.status === 'open' && matchesEvent(draft, current)) return linked;
      } else if (response.status !== 404) throw new Error('Could not check the existing event. Try again.');
      sessionStorage.removeItem('aol-flyer-creation');
    }
    if (formVersion !== checkedVersion) throw new Error('Answers changed while checking. Select Make my flyer again.');
    const pending = JSON.parse(sessionStorage.getItem('aol-flyer-creation') || 'null');
    const key = pending && JSON.stringify(pending.draft) === JSON.stringify(draft) ? pending.key : crypto.randomUUID();
    sessionStorage.setItem('aol-flyer-creation', JSON.stringify({ draft, key }));
    const saved = await staffApi('/care/api/events', { method: 'POST', body: { ...draft, flyerKey: key } });
    const { registrations, ...event } = saved;
    state.eventLink = { event };
    try { sessionStorage.setItem('aol-flyer-event-link', JSON.stringify(state.eventLink)); }
    catch { throw new Error('The event was created, but its link could not be saved in this browser. Check browser storage and retry.'); }
    updateEventLinkStatus();
    return event;
  }
  function matchEventType() {
    const firstLine = $('offer').value.split('\n').map(line => line.trim()).find(Boolean);
    $('eventType').value = [...$('eventType').options].find(option => option.value && option.value.toLowerCase() === firstLine?.toLowerCase())?.value || '';
    $('eventType').dataset.previous = $('eventType').value;
  }
  function fillSurvey(f) {
    clearFieldErrors(); answersChanged();
    $('offer').value = (f.offering && f.offering.raw_text) || ''; $('approved').value = (f.offering && f.offering.approved_description) || '';
    matchEventType();
    document.querySelectorAll('#moods input').forEach(i => { i.checked = !!(f.mood && f.mood.selected || []).includes(i.value); });
    $('gurudev').checked = !!(f.imagery && f.imagery.include_gurudev);
    $('cityOn').checked = !!(f.imagery && f.imagery.include_city_photo);
    $('cityBox').classList.toggle('hide', !$('cityOn').checked);
    state.city = null; $('cityInfo').textContent = '';
    $('tz').value = (f.schedule && f.schedule.timezone) || ''; $('sessions').innerHTML = ''; ((f.schedule && f.schedule.sessions) || [{}]).forEach(addSession);
    const l = f.location || {}; document.querySelector(`input[name=mode][value=${l.delivery_mode || 'in_person'}]`).checked = true; $('city').value = l.city || ''; $('venue').value = l.venue || ''; $('address').value = l.address || ''; $('onpage').checked = !!l.on_course_page;
    $('contacts').innerHTML = ''; (f.contacts && f.contacts.length ? f.contacts : [{}]).forEach(addContact);
    const a = f.action || {}; $('qrOn').checked = !!a.include_qr; $('url').value = a.destination_url || ''; $('dtype').value = a.destination_type || ''; if (f.format) $('format').value = f.format;
    $('notes').value = f.extra_notes || '';
    updateEventLinkStatus();
  }

  // ---------- city photo ----------
  function sharpness(img) {
    const s = Math.min(1, 320 / Math.max(img.naturalWidth, img.naturalHeight)), w = Math.max(8, Math.round(img.naturalWidth * s)), h = Math.max(8, Math.round(img.naturalHeight * s));
    const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(img, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data, g = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    let sum = 0, sq = 0, n = 0; for (let y = 1; y < h - 1; y++) for (let xx = 1; xx < w - 1; xx++) { const v = 4 * g[y * w + xx] - g[y * w + xx - 1] - g[y * w + xx + 1] - g[(y - 1) * w + xx] - g[(y + 1) * w + xx]; sum += v; sq += v * v; n++; }
    return Math.round((sq / n - (sum / n) ** 2) * 10) / 10;
  }
  async function onCityFile(e) {
    const f = e.target.files[0]; if (!f) return; $('cityInfo').textContent = 'Uploading…';
    try {
      const b64 = await fileToB64(f), up = await api('api/uploads/city', { method: 'POST', body: { filename: f.name, data_base64: b64 } });
      const img = new Image(); await new Promise((ok, no) => { img.onload = ok; img.onerror = no; img.src = up.url; });
      state.city = { asset_id: up.asset_id, width: up.width, height: up.height, sharpness: sharpness(img) };
      $('cityInfo').innerHTML = `<img src="${esc(up.url)}" alt="Uploaded city photo"><span>${up.width} × ${up.height} px. Sharpness score ${state.city.sharpness} (blurry photos are flagged, never repaired).</span>`;
    } catch (err) { state.city = null; $('cityInfo').innerHTML = `<span style="color:var(--bad)">${esc(err.message)}</span>`; }
    finally { answersChanged($('cityFile')); }
  }

  // ---------- proof panel ----------
  const GATES = ['brief', 'gateA', 'render', 'checks', 'review', 'gateB'];
  function setGates(m) { GATES.forEach(g => { const li = document.querySelector(`#gates [data-g=${g}]`); li.className = m[g] || ''; }); }
  function gateStates(r) {
    const g = {}; if (r.status === 'NEEDS_INPUT') { g.brief = 'bad'; return g; } g.brief = 'ok';
    g.gateA = r.design_spec ? 'ok' : r.status === 'PLANNING' ? 'run' : (r.pre_render_review.status === 'REVISION' ? 'bad' : '');
    if (r.final_review.artifact_id) {
      g.render = 'ok'; const mech = r.final_review.checks.some(c => c.mandatory && c.status === 'FAIL' && !c.id.startsWith('H-')); g.checks = mech ? 'bad' : 'ok';
      const humanFail = r.final_review.checks.some(c => c.id.startsWith('H-') && c.status === 'FAIL');
      g.review = r.status === 'READY' ? 'ok' : humanFail ? 'bad' : r.workflow.awaiting === 'human_review' || r.status === 'DRAFT_PREVIEW' ? 'wait' : '';
      g.gateB = r.status === 'READY' ? 'ok' : r.status === 'DRAFT_PREVIEW' ? 'wait' : r.status === 'NEEDS_REVIEW' && !r.workflow.awaiting ? 'bad' : '';
    }
    if (r.status === 'ERROR') g.gateB = 'bad'; return g;
  }
  const FIELD_SECTION = f => /^offering/.test(f) ? 'sA' : /^mood/.test(f) ? 'sB' : /gurudev/.test(f) ? 'sC' : /city_photo/.test(f) ? 'sD' : /^schedule/.test(f) ? 'sE' : /^location|^format/.test(f) ? 'sL' : /^contacts/.test(f) ? 'sF' : /^action/.test(f) ? 'sG' : f === 'assets.logo' ? 'op' : 'sA';
  function show(r) {
    state.job = r; setGates(gateStates(r));
    const cls = r.status === 'READY' ? 'ok' : ['NEEDS_INPUT', 'ERROR'].includes(r.status) || (r.status === 'NEEDS_REVIEW' && !r.workflow.awaiting) ? 'bad' : 'wait';
    const title = { READY: 'Ready', NEEDS_INPUT: 'A few details are needed', DRAFT_PREVIEW: 'Demo draft preview', NEEDS_REVIEW: r.workflow.awaiting ? 'Waiting for your review' : 'Needs changes', APPROVED_FOR_RENDER: 'Approved for render', PLANNING: 'Planning', ERROR: 'Something went wrong' }[r.status] || r.status;
    $('status').className = 'status ' + cls; $('status').innerHTML = `<strong>${esc(title)}</strong>${esc(r.message)} ${esc(r.next_action)}`;
    document.querySelectorAll('.card.flag').forEach(c => c.classList.remove('flag'));
    clearFieldErrors();
    const targets = r.questions.map(q => questionTarget(q.field));
    $('questions').innerHTML = r.questions.length ? '<p class="muted">From the last check. Update your answers, then select Make my flyer again.</p>' + r.questions.map((q, i) => { const sec = FIELD_SECTION(q.field); if (sec !== 'op') { $(sec)?.classList.add('flag'); showFieldError(targets[i], q.question); } return `<div class="q"><b>${esc(q.question)}</b><span class="muted">${esc(q.reason)}</span><br><a href="${sec === 'op' ? '#' : '#' + sec}" data-question="${i}" ${sec === 'op' ? 'data-op="1"' : ''}>${sec === 'op' ? 'Open the operator panel' : 'Go to this question'}</a></div>`; }).join('') : '';
    $('questions').querySelectorAll('[data-op]').forEach(a => a.onclick = e => { e.preventDefault(); openOperator(); });
    $('questions').querySelectorAll('[data-question]:not([data-op])').forEach(a => a.onclick = e => {
      const target = targets[Number(a.dataset.question)];
      if (target?.isConnected) { e.preventDefault(); target.focus(); }
    });
    const iss = r.issues.filter(i => i.severity !== 'BLOCKER' || !r.questions.length);
    $('issues').innerHTML = iss.length ? `<details class="evidence"><summary>Notes and issues (${iss.length})</summary><ul class="list ev">${iss.map(i => `<li><span><span class="chipx ${i.severity === 'NOTE' ? 'NOT_APPLICABLE' : i.severity === 'BLOCKER' ? 'FAIL' : 'UNVERIFIED'}">${esc(i.severity)}</span>${esc(i.problem)}</span><span class="meth">${esc(i.owner)}. ${esc(i.required_fix)}</span></li>`).join('')}</ul></details>` : '';
    const checks = [['Plan', r.pre_render_review.checks], ['Final artifact', r.final_review.checks]].filter(x => x[1].length);
    $('evidence').classList.toggle('hide', !checks.length);
    $('evBody').innerHTML = checks.map(([h, cs]) => `<h4>${h}</h4><ul class="list ev">${cs.map(c => `<li><span><span class="chipx ${c.status}">${esc(c.status)}</span><b>${esc(c.id)}</b> ${esc(c.observed_result)}</span><span class="meth">${c.mandatory ? 'Mandatory. ' : ''}${esc(c.method)}</span></li>`).join('')}</ul>`).join('');
    renderResult(r); renderReview(r);
  }
  function renderResult(r) {
    const el = $('result'); el.innerHTML = '';
    if (r.status === 'READY') { const d = r.deliverables; el.innerHTML = `<div class="res"><a class="btn primary" href="${esc(d.download_url)}" download>Download the flyer (PNG, ${d.width_px} × ${d.height_px})</a>${d.action_url ? `<div><b>Action link</b> (share it alongside the flyer for people on a phone)<br><a href="${esc(d.action_url)}" target="_blank" rel="noopener">${esc(d.action_url)}</a></div>` : ''}<div><b>Alt text</b><pre>${esc(d.alt_text)}</pre></div><div><b>Plain-text copy</b><pre>${esc(d.accessible_text)}</pre></div><div><button class="btn small" id="chg" type="button">Make a change</button></div></div>`; }
    else if (r.status === 'DRAFT_PREVIEW') el.innerHTML = `<div class="res"><b>${esc(r.preview.label)}</b><span class="muted">This is a design sample with invented facts. It is not a production flyer and cannot be released. Checks not completed: ${r.preview.unverified_checks.length ? '' : 'none'}</span>${r.preview.unverified_checks.length ? `<ul class="list ev">${r.preview.unverified_checks.map(u => `<li>${esc(u)}</li>`).join('')}</ul>` : ''}<div><button class="btn small" id="chg" type="button">Make a change</button></div></div>`;
    else if (r.status === 'NEEDS_REVIEW' && r.final_review.artifact_id && !r.workflow.awaiting) el.innerHTML = `<div class="res"><span class="muted">Fix the issues below, then render again as a new version.</span><div><button class="btn small" id="chg" type="button">Make a change</button></div></div>`;
    if ($('chg')) $('chg').onclick = startRevision;
    if (r.final_review.artifact_id && !$('cv').width) { /* nothing */ }
  }
  function renderReview(r) {
    const el = $('reviewBox'); el.innerHTML = ''; if (r.execution_profile === 'demo' || !r.final_review.artifact_id || r.status === 'READY' || r.workflow.awaiting !== 'human_review') return;
    el.innerHTML = `<form class="revbox" id="revForm"><h3>Human review</h3><p class="muted">Look at the flyer at full size and at phone width (use the buttons above it), then mark each item. Automatic checks cannot judge these. Your answers are recorded with your name and decide whether the flyer is released.</p>
      <label class="fld"><span>Your name</span><input id="rvName" type="text" required minlength="2"></label>
      <label class="check"><input id="rvMobile" type="checkbox"><span>I viewed the flyer at phone width.</span></label>
      <div>${r.workflow.human_items.map(h => { const m = r.final_review.checks.find(c => c.id === 'H-' + h.id); if (m && m.status === 'NOT_APPLICABLE') return ''; return `<div class="hi" data-id="${h.id}"><span class="t">${esc(h.name)}</span><span class="d">${esc(h.desc)}</span><span class="opts"><label><input type="radio" name="r_${h.id}" value="PASS"> Looks right</label><label><input type="radio" name="r_${h.id}" value="FAIL"> Needs a fix</label><input type="text" class="note" placeholder="What needs fixing (location and defect)" aria-label="Note for ${esc(h.name)}"></span></div>`; }).join('')}</div>
      <div><b>Scorecard</b> <span class="muted">(1 unacceptable, 3 adequate but weak, 4 polished, 5 exceptional. Release needs 4 or higher everywhere.)</span><div class="scores">${r.workflow.score_dims.map(d => { const q = r.quality_scores.find(s => s.id === d.id); if (q && !q.applicable) return ''; return `<label for="sc_${d.id}">${esc(d.label)}</label><select id="sc_${d.id}" data-s="${d.id}"><option value="">Choose</option>${[1, 2, 3, 4, 5].map(n => `<option>${n}</option>`).join('')}</select>`; }).join('')}</div></div>
      <button class="btn primary" type="submit">Submit review</button><span id="revErr" class="muted"></span></form>`;
    $('revForm').onsubmit = async ev => {
      ev.preventDefault(); const items = {}; let missing = 0;
      el.querySelectorAll('.hi').forEach(h => { const v = h.querySelector('input[type=radio]:checked'); if (!v) missing++; else items[h.dataset.id] = { status: v.value, note: h.querySelector('.note').value }; });
      const scores = {}; el.querySelectorAll('select[data-s]').forEach(s => { if (!s.value) missing++; else scores[s.dataset.s] = +s.value; });
      if (!$('rvMobile').checked) { $('revErr').textContent = ' Please view the flyer at phone width first.'; return; }
      if (missing) { $('revErr').textContent = ` ${missing} item(s) still need an answer.`; return; }
      try { show(await api(`api/jobs/${r.job_id}/review`, { method: 'POST', body: { reviewer: $('rvName').value, mobile_viewed: true, items, scores } })); } catch (e) { $('revErr').textContent = ' ' + e.message; }
    };
  }
  function resetProof() { localIssue = false; clearFieldErrors(); document.querySelectorAll('.card.flag').forEach(c => c.classList.remove('flag')); $('questions').innerHTML = ''; $('result').innerHTML = ''; $('reviewBox').innerHTML = ''; $('issues').innerHTML = ''; $('evidence').classList.add('hide'); $('status').className = 'status'; $('status').textContent = ''; setGates({}); }
  function showCanvas() { $('sheetEmpty').classList.add('hide'); $('prevImg').classList.add('hide'); $('cv').classList.remove('hide'); $('viewbar').classList.remove('hide'); }
  function showImage(url) { $('sheetEmpty').classList.add('hide'); $('cv').classList.add('hide'); $('prevImg').src = url; $('prevImg').classList.remove('hide'); $('viewbar').classList.remove('hide'); }
  function setBusy(msg) { state.busy = !!msg; $('makeBtn').disabled = !!msg; $('busy').classList.toggle('hide', !msg); $('busy').textContent = msg || ''; }

  // ---------- pipeline ----------
  function loadImg(url) { return new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('A selected image could not be opened.')); i.src = url; }); }
  async function run() {
    if (state.busy) return; resetProof(); setBusy('Checking your answers…'); setGates({ brief: 'run' });
    try {
      const incomplete = [...document.querySelectorAll('#sessions .row')].filter(row => !row.querySelector('.s-date').value && !row.querySelector('.s-start').value && row.querySelector('.s-end').value);
      if (incomplete.length) {
        localIssue = true;
        incomplete.forEach(row => {
          showFieldError(row.querySelector('.s-date'), 'Enter a date, or clear the end time.');
          showFieldError(row.querySelector('.s-start'), 'Enter a start time, or clear the end time.');
        });
        $('status').className = 'status bad';
        $('status').textContent = 'Complete each date and start time, or clear its end time.';
        setGates({ brief: 'bad' }); setBusy(null); incomplete[0].querySelector('.s-date').focus(); return;
      }
      const survey = collectSurvey(), checkedVersion = formVersion;
      const integrated = location.pathname.startsWith('/flyer/');
      const useOurForm = integrated && $('qrOn').checked;
      const draft = integrated ? eventDraft(survey) : null;
      if (integrated) {
        if (!draft.registrationUrl || !draft.startsAt) {
          localIssue = true;
          $('status').className = 'status bad';
          const target = !draft.registrationUrl ? $('url') : document.querySelector('#sessions ' + (survey.schedule.sessions[0]?.date ? '.s-start' : '.s-date')) || $('addSession');
          showFieldError(target, !draft.registrationUrl ? 'Enter the official registration link.' : 'Enter the first date and start time.');
          target.focus();
          $('status').textContent = 'Enter the official link and the first event date and start time.';
          setGates({ brief: 'bad' }); setBusy(null); return;
        }
      }
      if (state.baseJob) { survey.revision = { base_artifact_id: state.baseJob, requested_changes: ['Edited fields: ' + changedSections(state.baseSurvey, survey).join(', ')], locked_elements: lockedIds(state.baseSurvey, survey, (state.job && state.job.approved_copy && state.job.approved_copy.blocks) || []) }; }
      const preflight = useOurForm ? { ...survey, action: { ...survey.action, include_qr: false } } : survey;
      let r = await api('api/jobs', { method: 'POST', body: preflight });
      if (formVersion !== checkedVersion) { $('status').className = 'status wait'; $('status').textContent = 'Answers changed while checking. Select Make my flyer to check them again.'; setBusy(null); return; }
      show(r);
      if (r.status === 'NEEDS_INPUT') { const first = r.questions.map(q => questionTarget(q.field)).find(target => target && target !== $('opBtn')); if (first) first.focus(); else $('questions').scrollIntoView({ block: 'nearest' }); setBusy(null); return; }
      if (r.status !== 'PLANNING') { setBusy(null); return; }
      if (integrated) {
        const { session, api: staffApi } = await import('/care/shared/kit.js');
        if (formVersion !== checkedVersion) { $('status').textContent = 'Answers changed while checking. Select Make my flyer again.'; setBusy(null); return; }
        if (!session.token) { setBusy(null); signInForEvent(survey); return; }
        setBusy('Creating the event…');
        let linked;
        try { linked = await automaticEvent(draft, staffApi, checkedVersion); }
        catch (e) {
          if (e.status === 401) { session.clear(); setBusy(null); signInForEvent(survey); return; }
          throw e;
        }
        if (formVersion !== checkedVersion) { $('status').textContent = 'The event was created, but answers changed. Select Make my flyer to check them again.'; setBusy(null); return; }
        if (useOurForm) {
          let publicLink;
          try { publicLink = new URL(linked.publicUrl); }
          catch { throw new Error('The saved event link is invalid.'); }
          if (publicLink.pathname !== '/e/' + linked.slug || publicLink.search || publicLink.hash ||
              (state.cfg.execution_profile === 'production' && publicLink.protocol !== 'https:')) {
            throw new Error('A production flyer needs a public HTTPS event link. Configure AOL_PUBLIC_ORIGIN.');
          }
          survey.action.destination_url = linked.publicUrl;
          survey.action.destination_type = 'registration';
          r = await api('api/jobs', { method: 'POST', body: survey });
          if (formVersion !== checkedVersion) { $('status').textContent = 'Answers changed while checking. Select Make my flyer to check them again.'; setBusy(null); return; }
          const linkProblem = r.questions.find(q => q.field === 'action.destination_url');
          if (r.status === 'NEEDS_INPUT' && linkProblem) {
            throw new Error('The event was created, but its event-form link was rejected: ' + linkProblem.reason + ' For a local demo, use localhost and a fictional example.org official link. For a real flyer, configure AOL_PUBLIC_ORIGIN as a public HTTPS address.');
          }
          show(r);
          if (r.status === 'NEEDS_INPUT') { const first = r.questions.map(q => questionTarget(q.field)).find(target => target && target !== $('opBtn')); if (first) first.focus(); setBusy(null); return; }
          if (r.status !== 'PLANNING') { setBusy(null); return; }
        }
      }
      state.survey = survey;
      setBusy('Measuring text and fitting the layout…'); setGates({ ...gateStates(r), gateA: 'run' });
      const inp = r.workflow.layout_inputs, imgs = {}; for (const role of ['logo', 'portrait', 'city']) if (inp.assets[role]) imgs[role] = await loadImg(inp.assets[role].url);
      const fonts = await FlyerLayout.resolveFonts(inp); const layout = FlyerLayout.compute(inp, imgs, fonts);
      if (layout.error) { r.status = 'NEEDS_REVIEW'; r.message = 'The enabled content does not fit on this format: ' + layout.error; r.next_action = 'Turn off a photo or the QR code, shorten the schedule, or use a shorter title. Nothing was shrunk below the readable minimum.'; r.workflow.awaiting = null; show(r); setGates({ brief: 'ok', gateA: 'bad' }); setBusy(null); return; }
      r = await api(`api/jobs/${r.job_id}/layout`, { method: 'POST', body: { layout } }); show(r);
      if (r.status !== 'APPROVED_FOR_RENDER' || r.workflow.awaiting !== 'render') { setBusy(null); return; }
      if (state.cfg.output_mode === 'plan_only') { setBusy(null); return; }
      setBusy('Rendering the approved design…'); setGates({ ...gateStates(r), render: 'run' });
      const canvas = $('cv'); showCanvas(); const rep = await FlyerRender.draw(canvas, r.design_spec, r.workflow.qr_modules, imgs, fonts); const b64 = await FlyerRender.toBase64(canvas);
      setBusy('Inspecting the exported file…');
      r = await api(`api/jobs/${r.job_id}/render`, { method: 'POST', body: { spec_hash: r.design_spec.spec_hash, spec_version: r.design_spec.spec_version, png_base64: b64, text_report: rep.textReport, asset_report: rep.assetReport, fonts: rep.fonts } }); show(r);
      $('sheet').scrollIntoView({ block: 'nearest' });
    } catch (e) { $('status').className = 'status bad'; $('status').innerHTML = `<strong>Something went wrong</strong>${esc(e.message)}`; setGates({}); }
    setBusy(null);
  }

  // ---------- revisions ----------
  const SECTION_IDS = { A: [/^title$/, /^invitation$/, /^description$/, /^benefit_/, /^conditions$/], E: [/^sched_/, /^tznote$/], L: [/^eyebrow$/, /^loc_/], F: [/^contact_/], G: [/^cta$/, /^url$/] };
  function sectionData(s) { return { A: [s.offering, s.mood], E: s.schedule, L: [s.location, s.format], F: s.contacts, G: s.action }; }
  function changedSections(a, b) { const x = sectionData(a), y = sectionData(b); return Object.keys(x).filter(k => JSON.stringify(x[k]) !== JSON.stringify(y[k])).map(k => ({ A: 'what the flyer is for', E: 'dates', L: 'location', F: 'contacts', G: 'action' }[k])); }
  function lockedIds(a, b, blocks) { const x = sectionData(a), y = sectionData(b), out = []; for (const k of Object.keys(x)) if (JSON.stringify(x[k]) === JSON.stringify(y[k])) for (const blk of blocks) if (SECTION_IDS[k].some(re => re.test(blk.id))) out.push(blk.id); return out; }
  function startRevision() { state.baseJob = state.job.job_id; state.baseSurvey = JSON.parse(JSON.stringify(state.survey)); $('reviseBar').classList.remove('hide'); $('reviseText').textContent = 'Editing a copy of your last flyer. Anything you leave alone stays word for word the same.'; $('form').scrollIntoView({ behavior: 'smooth' }); }

  // ---------- operator ----------
  async function openOperator() {
    const c = await api('api/config'); state.cfg = c; const body = $('opBody');
    if (!c.admin) { body.innerHTML = `<div class="op"><p>Operator changes are limited to the computer running the app${c.admin_needs_token ? ', or need the admin token' : ''}.</p>${c.admin_needs_token ? `<label class="fld"><span>Admin token</span><input id="tok" type="password"></label><button class="btn" id="tokGo" type="button">Unlock</button>` : ''}</div>`; if ($('tokGo')) $('tokGo').onclick = () => { state.adminToken = $('tok').value; sessionStorage.setItem('adminToken', state.adminToken); openOperator(); }; $('opDlg').showModal(); return; }
    const list = (cat, items) => items.length ? items.map(a => `<div class="a"><span>${esc(a.filename)}${a.width ? ` · ${a.width}×${a.height}` : ''}${a.lum != null ? ` · ${a.lum < 0.85 ? 'for light backgrounds' : 'light-on-dark'}` : ''}</span><button class="btn small" data-del="${cat}|${esc(a.filename)}" type="button">Remove</button></div>`).join('') : '<span class="muted">None yet</span>';
    body.innerHTML = `<div class="op">
      <fieldset><legend>Execution profile</legend><label class="check"><input type="radio" name="prof" value="production" ${c.execution_profile === 'production' ? 'checked' : ''}><span><b>Production.</b> Real facts and approved assets only. A flyer is released only after both gates and a human review.</span></label><label class="check"><input type="radio" name="prof" value="demo" ${c.execution_profile === 'demo' ? 'checked' : ''}><span><b>Demo.</b> Fictional sample. Labelled on the image, example.org contacts only, never marked ready.</span></label></fieldset>
      <fieldset><legend>Rules</legend><label class="fld inline"><span>Logo</span><select id="opLogo"><option value="include_required">Include (required)</option><option value="reserve_space">Reserve clean space</option><option value="omit">Omit</option></select></label><label class="fld inline"><span>Live link check</span><select id="opLink"><option value="best_effort">Best effort</option><option value="required">Required</option></select></label><label class="fld inline"><span>Output</span><select id="opOut"><option value="generate">Generate the flyer</option><option value="plan_only">Plan only</option></select></label><button class="btn primary small" id="opSave" type="button">Save settings</button></fieldset>
      <fieldset><legend>Asset package (approved originals)</legend><div class="assets"><b>Logos</b>${list('logos', c.assets.logos)}<input type="file" id="upLogos" accept="image/png,image/jpeg,image/svg+xml,image/webp"><span class="muted">Use the official file for a light background. It is never recoloured or redrawn.</span></div><div class="assets"><b>Approved portraits of Gurudev</b>${list('gurudev', c.assets.gurudev)}<input type="file" id="upGurudev" accept="image/png,image/jpeg,image/webp"></div><div class="assets"><b>Brand fonts (optional)</b>${list('fonts', c.assets.fonts)}<input type="file" id="upFonts" accept=".ttf,.otf,.woff,.woff2"><span class="muted">After adding fonts, name them under approved_fonts in config/admin-config.json.</span></div></fieldset>
      <p class="muted">Language model: ${esc(c.capabilities.language_model)}. Link check: ${esc(c.capabilities.live_link_check)}. OCR: ${esc(c.capabilities.ocr)}.</p></div>`;
    $('opLogo').value = c.logo_policy; $('opLink').value = c.live_link_check; $('opOut').value = c.output_mode;
    $('opSave').onclick = async () => { try { await api('api/admin/config', { method: 'POST', body: { execution_profile: document.querySelector('input[name=prof]:checked').value, logo_policy: $('opLogo').value, live_link_check: $('opLink').value, output_mode: $('opOut').value } }); await loadConfig(); $('opSave').textContent = 'Saved'; } catch (e) { $('opSave').textContent = e.message; } };
    for (const [id, cat] of [['upLogos', 'logos'], ['upGurudev', 'gurudev'], ['upFonts', 'fonts']]) $(id).onchange = async e => { const f = e.target.files[0]; if (!f) return; try { await api('api/admin/assets', { method: 'POST', body: { category: cat, filename: f.name, data_base64: await fileToB64(f) } }); openOperator(); } catch (err) { alert(err.message); } };
    body.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { const [cat, name] = b.dataset.del.split('|'); await api(`api/admin/assets?category=${cat}&filename=${encodeURIComponent(name)}`, { method: 'DELETE' }); openOperator(); });
    if (!$('opDlg').open) $('opDlg').showModal();
  }
  async function openHistory() {
    const list = await api('api/jobs'); $('histBody').innerHTML = list.length ? `<div class="hist">${list.map(j => `<button class="btn" data-j="${j.id}" type="button"><span>${esc(j.title || 'Untitled')}</span><span class="muted">${esc(j.status)} · ${esc(j.profile)} · ${new Date(j.created).toLocaleString()}</span></button>`).join('')}</div>` : '<p class="muted">No flyers yet.</p>';
    $('histBody').querySelectorAll('[data-j]').forEach(b => b.onclick = async () => { const r = await api('api/jobs/' + b.dataset.j); $('histDlg').close(); resetProof(); show(r); if (r.final_review.artifact_id) { showImage('/preview/' + r.final_review.artifact_id + '.png'); } state.survey = null; }); $('histDlg').showModal();
  }

  async function loadConfig() {
    const c = await api('api/config'); state.cfg = c; const demo = c.execution_profile === 'demo';
    $('profilePill').textContent = demo ? 'Demo profile' : 'Production profile'; $('profilePill').className = 'pill' + (demo ? ' demo' : ''); $('demoBar').classList.toggle('hide', !demo);
    $('format').innerHTML = c.allowed_formats.map(f => `<option value="${f}">${f === '3:4' ? 'Portrait 3:4 (1080 × 1440)' : 'Portrait 4:5 (1080 × 1350)'}</option>`).join(''); $('format').value = c.default_format;
  }
  async function loadEventTypes() {
    try {
      const { eventPrograms } = await import('/care/shared/catalog.js');
      const select = $('eventType');
      select.replaceChildren(new Option('Choose a type', ''), ...eventPrograms.map(program => new Option(program, program)));
      select.disabled = false;
      matchEventType();
      select.addEventListener('change', () => {
        const lines = $('offer').value.split('\n');
        const previous = select.dataset.previous || '';
        if (select.value && select.value !== 'Other' && (!lines[0].trim() || lines[0].trim() === previous)) {
          lines[0] = select.value;
          $('offer').value = lines.join('\n');
          clearFieldError($('offer'));
        }
        select.dataset.previous = select.value;
      });
    } catch {
      $('eventTypeError').textContent = 'Could not load event types. Refresh the page to try again.';
    }
  }
  async function init() {
    await loadConfig(); addSession(); addContact();
    const hasPeopleApp = location.pathname.startsWith('/flyer/');
    $('eventTypeField').hidden = !hasPeopleApp;
    $('destinationTypeField').hidden = hasPeopleApp;
    $('eventLinkStatus').hidden = !hasPeopleApp;
    if (!hasPeopleApp) {
      $('qrLabel').textContent = 'Add a QR code to the course link';
      $('urlLabel').textContent = 'Course link';
      $('linkHint').textContent = 'The link is used exactly as entered. It is never shortened and no tracking is added.';
    } else if (state.cfg.execution_profile === 'demo') {
      $('linkHint').textContent += ' Local demo links work only on this computer and require a fictional example.org official link. Demo events are saved in People and may persist.';
    }
    if (hasPeopleApp) await loadEventTypes();
    try {
      const saved = sessionStorage.getItem('aol-flyer-survey');
      if (saved) {
        const parsed = JSON.parse(saved);
        fillSurvey(parsed.survey);
        state.city = parsed.city;
        if (typeof parsed.useOurForm === 'boolean') $('qrOn').checked = parsed.useOurForm;
        if (state.city) $('cityInfo').textContent = 'Previously uploaded city photo selected.';
        if (parsed.program) { $('eventType').value = parsed.program; $('eventType').dataset.previous = $('eventType').value; }
        sessionStorage.removeItem('aol-flyer-survey');
      }
    } catch { $('addEventError').textContent = 'Could not restore the flyer answers. Check browser storage.'; }
    readEventLink();
    const resumeAfterSignIn = () => {
      try {
        if (sessionStorage.getItem('aol-flyer-signin-ready') !== '1') return;
        sessionStorage.removeItem('aol-flyer-signin-ready');
        sessionStorage.removeItem('aol-flyer-survey');
        if (window.parent !== window) window.parent.location.hash = '#flyer';
        run();
      } catch { $('status').textContent = 'Could not resume after sign-in. Check browser storage and select Make my flyer again.'; }
    };
    window.addEventListener('storage', e => {
      if (e.key === 'aol-flyer-event-link') readEventLink();
      if (e.key === 'aol-flyer-signin-ready') resumeAfterSignIn();
    });
    $('form').addEventListener('input', e => answersChanged(e.target));
    $('form').addEventListener('change', e => answersChanged(e.target));
    $('addSession').onclick = () => { if (document.querySelectorAll('#sessions .row').length < 6) { addSession(); answersChanged(); } };
    $('addContact').onclick = () => { if (document.querySelectorAll('#contacts .row').length < 3) { addContact(); answersChanged(); } };
    $('cityOn').onchange = () => $('cityBox').classList.toggle('hide', !$('cityOn').checked); $('cityFile').onchange = onCityFile;
    $('makeBtn').onclick = run; $('fixtureBtn').onclick = () => fillSurvey(state.cfg.demo_fixture); $('opBtn').onclick = openOperator; $('opClose').onclick = () => $('opDlg').close(); $('historyBtn').onclick = openHistory; $('histClose').onclick = () => $('histDlg').close();
    $('reviseCancel').onclick = () => { state.baseJob = null; state.baseSurvey = null; $('reviseBar').classList.add('hide'); };
    document.querySelectorAll('#viewbar [data-view]').forEach(b => b.onclick = () => { document.querySelectorAll('#viewbar [data-view]').forEach(x => x.classList.toggle('on', x === b)); $('sheet').classList.toggle('phone', b.dataset.view === 'phone'); });
    window.__studio = { state, collectSurvey, fillSurvey, run };
    if (hasPeopleApp) resumeAfterSignIn();
  }
  init();
})();
