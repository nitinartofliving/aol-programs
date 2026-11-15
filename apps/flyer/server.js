'use strict';
// Flyer Studio host application: zero dependencies. Serves the front end and enforces the Creative Engine's gates.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const U = require('./engine/util'), A = require('./engine/assets'), { plan } = require('./engine/plan'), G = require('./engine/gates'), llm = require('./engine/llm');
const { imageInfo } = require('./engine/png');

const ROOT = __dirname, PORT = process.env.PORT || 3000;
const CFG_PATH = path.join(ROOT, 'config', 'admin-config.json');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const DIRS = { jobs: path.join(DATA, 'jobs'), art: path.join(DATA, 'artifacts') };
for (const d of Object.values(DIRS)) fs.mkdirSync(d, { recursive: true });
fs.mkdirSync(path.join(ROOT, 'uploads', 'city'), { recursive: true });
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' };

const loadCfg = () => ({ ...JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) });
const saveCfg = c => fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2));
const registry = () => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'programmes.json'), 'utf8')); } catch { return { programmes: [] }; } };
const jobs = new Map();
for (const f of fs.readdirSync(DIRS.jobs)) if (f.endsWith('.json')) { try { const j = JSON.parse(fs.readFileSync(path.join(DIRS.jobs, f), 'utf8')); jobs.set(j.id, j); } catch { /* skip */ } }
const saveJob = j => { j.updated = new Date().toISOString(); jobs.set(j.id, j); fs.writeFileSync(path.join(DIRS.jobs, j.id + '.json'), JSON.stringify(j)); };

const send = (res, code, b, type = 'application/json', extra = {}) => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }); res.end(Buffer.isBuffer(b) || typeof b === 'string' ? b : JSON.stringify(b)); };
const readBody = (req, max = 30e6) => new Promise((ok, no) => { const c = []; let n = 0; req.on('data', d => { n += d.length; if (n > max) { no(new Error('too large')); req.destroy(); } else c.push(d); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { no(new Error('invalid JSON')); } }); });
const isLoopback = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const isAdmin = req => process.env.ADMIN_TOKEN ? req.headers['x-admin-token'] === process.env.ADMIN_TOKEN : isLoopback(req);

function capabilities(cfg) {
  return { qr_encoder: 'built-in (byte mode, versions 1 to 10, error correction M)', qr_decoder_on_final_file: 'built-in pixel-sampling decoder', png_decoder: 'built-in', ocr: 'unavailable', live_link_check: cfg.live_link_check, language_model: llm.enabled ? 'enabled (' + (process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5') + ')' : 'not configured; host copy templates are used', layout_and_render: 'browser (canvas, layered)', visual_inspection: 'human reviewer via the host', mobile_test: 'estimated; human review at 375 px' };
}

function compareToPrior(job) {
  const rq = job.plan.rq, baseId = rq.revision.base_artifact_id, base = baseId && jobs.get(baseId);
  if (!base || !base.plan || !base.plan.copy) return null;
  const a = new Map(base.plan.copy.blocks.map(b => [b.id, b.text])), b = new Map(job.plan.copy.blocks.map(x => [x.id, x.text])), changed = [];
  for (const id of new Set([...a.keys(), ...b.keys()])) if (a.get(id) !== b.get(id)) changed.push(id);
  const locked = rq.revision.locked_elements, unexpected = changed.filter(id => locked.includes(id));
  return { base_job_id: baseId, changed, unexpected_changes: unexpected, requested_changes: rq.revision.requested_changes };
}

function altText(job) {
  const P = job.plan, t = id => (P.copy.blocks.find(b => b.id === id) || {}).text; const sess = P.copy.blocks.filter(b => /^sched_/.test(b.id)).map(b => b.text);
  return `Flyer for ${t('title')}${t('eyebrow') ? ' (' + t('eyebrow').toLowerCase() + ')' : ''}. ${t('invitation')} ${sess.join('; ')}.${P.qr ? ' A QR code links to the course page.' : ''}`.replace(/\s+/g, ' ');
}
function accessibleText(job) { return job.plan.copy.blocks.filter(b => !job.spec || !job.spec.dropped_optional.includes(b.id)).map(b => b.text).join('\n') + (job.plan.qr ? '\nLink: ' + job.plan.qr.url : ''); }

function buildResponse(job) {
  const cfg = job.cfg, P = job.plan, status = job.status, dec = job.decision;
  const lastRender = job.renders[job.renders.length - 1];
  const ready = status === 'READY', draft = status === 'DRAFT_PREVIEW';
  const unverified = [...(job.final_checks || []), ...((job.review_eval && job.review_eval.items) || [])].filter(c => c.status === 'UNVERIFIED').map(c => c.id + ': ' + c.observed_result);
  const caps = { id: 'A12', mandatory: false, status: 'PASS', observed_result: 'Capabilities discovered at planning time: ' + Object.entries(capabilities(cfg)).map(([k, v]) => k.replace(/_/g, ' ') + ' = ' + v).join('; '), evidence_reference: 'host:capabilities', method: 'Capability discovery before planning (Section 4).', responsible_team: 'Team G' };
  const preChecks = [...(P.checks || []), ...(job.gateA_checks || []), caps];
  const issues = [...(P.issues || []), ...(job.gateA_issues || []), ...(job.final_issues || []), ...((job.review_eval && job.review_eval.issues) || [])];
  let message = '', next = '';
  switch (status) {
    case 'NEEDS_INPUT': message = 'A few details are needed before the flyer can be planned.'; next = 'Answer the questions and submit again.'; break;
    case 'PLANNING': message = 'Brief validated. Waiting for the layout to be measured in the browser.'; next = 'The browser measures text and sends the layout for approval.'; break;
    case 'APPROVED_FOR_RENDER': message = cfg.output_mode === 'plan_only' ? 'Design specification approved. No image was rendered (plan only).' : 'Design specification approved for this exact version. Ready to render.'; next = cfg.output_mode === 'plan_only' ? 'Switch output mode to generate to render.' : 'Render the approved specification.'; break;
    case 'DRAFT_PREVIEW': message = 'All facts in this sample are fictional. It is not a production flyer.'; next = 'Review the preview. Production release needs real assets, a real event and a human review.'; break;
    case 'NEEDS_REVIEW': message = dec && dec.awaiting_review ? 'Automatic checks are complete. A human review is required before release.' : 'The flyer needs changes before release.'; next = dec && dec.awaiting_review ? 'Inspect the flyer at full size and at phone width, then submit the reviewer sign-off.' : 'Fix the listed issues. Change the inputs or the flyer, then render again.'; break;
    case 'READY': message = 'Both gates passed for this exact artifact.'; next = 'Download the flyer. Share the action link alongside it for people viewing on a phone.'; break;
    default: message = job.message || 'Something went wrong.'; next = 'Try again; details are in the issues list.';
  }
  return {
    request_id: job.request_id, job_id: job.id, status, execution_profile: job.profile, message, questions: P.questions || [], assumptions: P.assumptions || [],
    normalized_brief: P.brief || null, approved_copy: P.copy ? { blocks: P.copy.blocks, sources: P.copy.source } : null, design_spec: job.spec || null, asset_manifest: P.manifest || [],
    pre_render_review: { status: job.spec ? 'PASS' : job.gateA_issues && job.gateA_issues.length ? 'REVISION' : P.status === 'NEEDS_INPUT' ? 'BLOCKED' : 'NOT_RUN', spec_version: job.spec ? job.spec.spec_version : null, checks: preChecks },
    final_review: { status: !job.final_checks ? 'NOT_RUN' : ready ? 'PASS' : draft ? 'DRAFT' : (job.final_checks.some(c => c.mandatory && c.status === 'FAIL') ? 'FAIL' : 'PENDING_HUMAN_REVIEW'), artifact_id: job.artifact_id || null, checks: [...(job.final_checks || []), ...((job.review_eval && job.review_eval.items) || [])] },
    quality_scores: job.review_eval ? job.review_eval.scores : [],
    craft_review: { status: job.review_eval ? (job.review_eval.craft.some(c => c.status === 'FAIL') ? 'FAIL' : job.review_eval.craft.some(c => c.status === 'UNVERIFIED') ? 'PENDING' : 'PASS') : 'NOT_RUN', checks: job.review_eval ? job.review_eval.craft : [], revision_goal: (P.rq && P.rq.revision.requested_changes.join('; ')) || null, comparison_to_prior: job.comparison_to_prior || null },
    deliverables: ready ? { flyer_artifact_id: job.artifact_id, download_url: 'download/' + job.id + '.png', format: 'PNG', width_px: job.spec.output.width, height_px: job.spec.output.height, alt_text: altText(job), accessible_text: accessibleText(job), action_url: P.links && P.links.url } : { flyer_artifact_id: null, download_url: null, format: null, width_px: null, height_px: null, alt_text: null, accessible_text: null, action_url: null },
    preview: draft ? { artifact_id: job.artifact_id, url: 'preview/' + job.artifact_id + '.png', label: 'DESIGN SAMPLE · FICTIONAL EVENT', unverified_checks: unverified } : { artifact_id: null, url: null, label: null, unverified_checks: [] },
    review_candidate: !ready && !draft && job.artifact_id ? { artifact_id: job.artifact_id, url: 'preview/' + job.artifact_id + '.png', label: 'Candidate for human review (not approved)' } : null,
    issues, next_action: next, versions: { prompt: '1.2', brand_package: cfg.brand_package_version, brief: P.brief ? U.sha256(P.brief).slice(0, 12) : null, design_spec: job.spec ? job.spec.spec_version : null, artifact: job.artifact_id || null },
    workflow: { state: status, planning_rounds_used: job.layout_rounds || 0, planning_rounds_max: cfg.planning_rounds, render_attempts_used: job.renders.length, render_attempts_max: cfg.render_attempts, awaiting: status === 'PLANNING' ? 'layout' : status === 'APPROVED_FOR_RENDER' ? 'render' : status === 'NEEDS_REVIEW' && dec && dec.awaiting_review ? 'human_review' : null, human_items: G.HUMAN_ITEMS.map(([id, name, desc]) => ({ id, name, desc })), score_dims: G.SCORE_DIMS.map(([id, label]) => ({ id, label })), layout_inputs: status === 'PLANNING' || status === 'APPROVED_FOR_RENDER' || (status === 'NEEDS_REVIEW' && !job.artifact_id) ? layoutInputs(job) : null, qr_modules: status === 'APPROVED_FOR_RENDER' ? job.qr_modules || null : null, last_render: lastRender || null }
  };
}
function layoutInputs(job) {
  const P = job.plan, cfg = job.cfg; if (!P.copy) return null;
  const a = x => x ? { id: x.id, url: x.url, width: x.width, height: x.height, filename: x.filename } : null;
  return { canvas: G.CANVAS[P.rq.format], margin: cfg.safe_margin_px, blocks: P.copy.blocks, assets: { logo: a(P.sel.logo), portrait: a(P.sel.portrait), city: a(P.sel.city) }, logo_policy: cfg.logo_policy, palette: P.palette, mood: P.mood, qr: P.qr, fonts: cfg.approved_fonts, approved_fonts_files: A.inventory().fonts, profile: job.profile, spec_version: job.spec_version || 0 };
}

async function createJob(raw) {
  const cfg = loadCfg(), profile = cfg.execution_profile === 'demo' ? 'demo' : 'production';
  const inv = A.inventory(), now = new Date();
  const job = { id: 'job_' + crypto.randomBytes(5).toString('hex'), created: now.toISOString(), profile, cfg, request_id: (raw && raw.request_id) || 'req_' + crypto.randomBytes(4).toString('hex'), raw, renders: [], layout_rounds: 0, spec_version: 0 };
  job.plan = await plan(raw, { cfg, profile, registry: registry(), inv, now, llm });
  if (job.plan.status === 'PLANNING' && profile === 'production' && job.plan.links && job.plan.links.url) {
    job.link_status = await U.checkLink(job.plan.links.url);
    if (job.link_status.status === 'failed') { job.plan.issues.push({ severity: 'BLOCKER', owner: 'Link and QR Specialist', problem: 'The destination looks broken: ' + job.link_status.detail, required_fix: 'Provide a working link.', verification_status: 'OPEN' }); job.plan.questions.push({ field: 'action.destination_url', question: 'This link did not work. What is the correct address?', reason: job.link_status.detail }); job.plan.status = 'NEEDS_INPUT'; }
    else if (cfg.live_link_check === 'required' && job.link_status.status !== 'verified') job.plan.issues.push({ severity: 'NOTE', owner: 'Link and QR Specialist', problem: 'Live link checking is required but the destination could not be verified; the flyer cannot be released as READY.', required_fix: 'Retry when the destination is reachable.', verification_status: 'UNVERIFIED' });
  }
  job.status = job.plan.status; if (job.plan.copy) job.comparison_to_prior = compareToPrior(job);
  saveJob(job); return job;
}

function handleLayout(job, body) {
  if (!['PLANNING', 'NEEDS_REVIEW', 'APPROVED_FOR_RENDER'].includes(job.status) || !job.plan.copy) throw Object.assign(new Error('This job is not waiting for a layout.'), { code: 409 });
  if (job.status === 'NEEDS_REVIEW' && job.artifact_id) throw Object.assign(new Error('A render already exists. Edit the inputs to create a new version.'), { code: 409 });
  if (job.layout_rounds >= job.cfg.planning_rounds) { job.status = 'NEEDS_REVIEW'; saveJob(job); return; }
  job.layout_rounds++;
  const r = G.gateA(job, body.layout || {}, job.cfg); job.gateA_checks = r.checks; job.gateA_issues = r.issues;
  if (r.pass) { job.spec = r.spec; job.spec_version = r.spec.spec_version; job.approval = r.approval; job.qr_modules = r.qr_modules || null; job.status = 'APPROVED_FOR_RENDER'; job.final_checks = null; job.artifact_id = null; }
  else { job.status = job.layout_rounds >= job.cfg.planning_rounds ? 'NEEDS_REVIEW' : 'PLANNING'; if (job.status === 'NEEDS_REVIEW') job.message = 'Planning budget used.'; }
  saveJob(job);
}

async function handleRender(job, body) {
  if (job.status !== 'APPROVED_FOR_RENDER' || !job.spec) throw Object.assign(new Error('Rendering is only allowed for an approved specification (Gate A).'), { code: 409 });
  if (body.spec_hash !== job.spec.spec_hash || body.spec_version !== job.spec.spec_version) throw Object.assign(new Error('The render does not match the approved specification version.'), { code: 409 });
  if (job.renders.length >= job.cfg.render_attempts) throw Object.assign(new Error('The render budget is used up.'), { code: 409 });
  if (job.cfg.output_mode === 'plan_only') throw Object.assign(new Error('Output mode is plan only.'), { code: 409 });
  const png = Buffer.from(String(body.png_base64 || ''), 'base64'); if (png.length < 1000 || png.length > 20e6) throw Object.assign(new Error('Missing or oversized image.'), { code: 400 });
  const artifactId = 'art_' + job.id.slice(4) + '_' + (job.renders.length + 1);
  fs.writeFileSync(path.join(DIRS.art, artifactId + '.png'), png);
  job.artifact_id = artifactId; job.renders.push({ attempt: job.renders.length + 1, spec_hash: job.spec.spec_hash, artifact_id: artifactId, at: new Date().toISOString(), bytes: png.length });
  job.final_checks = G.finalChecks(job, png, { text: body.text_report, assets: body.asset_report, fonts: body.fonts }, job.cfg, job.link_status);
  job.review = null; job.review_eval = G.evaluateReview(job, null);
  job.final_issues = job.final_checks.filter(c => c.status === 'FAIL').map(c => ({ severity: 'REVISION', owner: c.responsible_team, problem: c.id + ': ' + c.observed_result, required_fix: 'Correct and render a new approved version.', verification_status: 'OPEN' }));
  job.decision = G.decide(job, job.cfg); job.status = job.decision.status; saveJob(job);
}
function handleReview(job, body) {
  if (!job.artifact_id || !job.final_checks) throw Object.assign(new Error('Nothing to review yet.'), { code: 409 });
  if (!body.reviewer || String(body.reviewer).trim().length < 2) throw Object.assign(new Error('Reviewer name is required.'), { code: 400 });
  job.review = { reviewer: String(body.reviewer).trim().slice(0, 80), at: new Date().toISOString(), items: body.items || {}, scores: body.scores || {}, score_notes: body.score_notes || {}, mobile_viewed: body.mobile_viewed === true };
  job.review_eval = G.evaluateReview(job, job.review); job.decision = G.decide(job, job.cfg); job.status = job.decision.status; saveJob(job);
}

function sanitizeName(n) { return String(n || '').replace(/[^\w.\- ]/g, '_').replace(/^\.+/, '').slice(0, 80); }
function serveFile(res, fp, root, extra = {}) {
  const abs = path.resolve(fp); if (!abs.startsWith(path.resolve(root)) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
  send(res, 200, fs.readFileSync(abs), MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', extra);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = decodeURIComponent(u.pathname);
  try {
    if (p === '/api/config') { const cfg = loadCfg(), inv = A.inventory(); return send(res, 200, { execution_profile: cfg.execution_profile, allowed_formats: cfg.allowed_formats, default_format: cfg.default_format, logo_policy: cfg.logo_policy, live_link_check: cfg.live_link_check, output_mode: cfg.output_mode, exact_font_required: cfg.exact_font_required, capabilities: capabilities(cfg), admin: isAdmin(req), admin_needs_token: !!process.env.ADMIN_TOKEN, assets: { logos: inv.logos, gurudev: inv.gurudev, fonts: inv.fonts }, prompt_version: cfg.prompt_version, demo_fixture: JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'demo-fixture.json'), 'utf8')) }); }
    if (p === '/api/admin/config' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Operator access required.' });
      const b = await readBody(req), cfg = loadCfg();
      if (b.execution_profile) { if (!['production', 'demo'].includes(b.execution_profile)) return send(res, 400, { error: 'invalid profile' }); cfg.execution_profile = b.execution_profile; }
      if (b.logo_policy) { if (!['include_required', 'reserve_space', 'omit'].includes(b.logo_policy)) return send(res, 400, { error: 'invalid logo policy' }); cfg.logo_policy = b.logo_policy; }
      if (b.live_link_check) { if (!['required', 'best_effort'].includes(b.live_link_check)) return send(res, 400, { error: 'invalid link policy' }); cfg.live_link_check = b.live_link_check; }
      if (b.output_mode) { if (!['generate', 'plan_only'].includes(b.output_mode)) return send(res, 400, { error: 'invalid output mode' }); cfg.output_mode = b.output_mode; }
      saveCfg(cfg); return send(res, 200, { ok: true });
    }
    if (p === '/api/admin/assets' && req.method === 'POST') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Operator access required.' });
      const b = await readBody(req), cat = { logos: 'logos', gurudev: 'gurudev', fonts: 'brand/fonts' }[b.category]; if (!cat) return send(res, 400, { error: 'category must be logos, gurudev or fonts' });
      const name = sanitizeName(b.filename), buf = Buffer.from(String(b.data_base64 || ''), 'base64');
      if (!name || buf.length < 50 || buf.length > 20e6) return send(res, 400, { error: 'invalid file' });
      if (cat === 'brand/fonts' ? !/\.(ttf|otf|woff2?)$/i.test(name) : !/\.(png|jpe?g|webp|svg)$/i.test(name)) return send(res, 400, { error: 'unsupported file type' });
      if (cat !== 'brand/fonts' && !imageInfo(buf, name).type) return send(res, 400, { error: 'file is not a readable image' });
      fs.writeFileSync(path.join(ROOT, 'assets', cat, name), buf); return send(res, 200, { ok: true, id: (b.category === 'fonts' ? 'font:' : b.category === 'logos' ? 'logo:' : 'gurudev:') + name });
    }
    if (p === '/api/admin/assets' && req.method === 'DELETE') {
      if (!isAdmin(req)) return send(res, 403, { error: 'Operator access required.' });
      const cat = { logos: 'logos', gurudev: 'gurudev', fonts: 'brand/fonts' }[u.searchParams.get('category')], name = sanitizeName(u.searchParams.get('filename'));
      if (!cat || !name) return send(res, 400, { error: 'bad request' }); const fp = path.join(ROOT, 'assets', cat, name); if (fs.existsSync(fp)) fs.unlinkSync(fp); return send(res, 200, { ok: true });
    }
    if (p === '/api/uploads/city' && req.method === 'POST') {
      const b = await readBody(req), buf = Buffer.from(String(b.data_base64 || ''), 'base64'), info = imageInfo(buf, b.filename || '');
      if (buf.length > 15e6 || !['png', 'jpeg', 'webp'].includes(info.type)) return send(res, 400, { error: 'Upload a PNG, JPEG or WebP photo under 15 MB.' });
      const f = crypto.randomBytes(6).toString('hex') + (info.type === 'jpeg' ? '.jpg' : '.' + info.type); fs.writeFileSync(path.join(ROOT, 'uploads', 'city', f), buf);
      return send(res, 200, { asset_id: 'city:' + f, width: info.width, height: info.height, url: 'uploads/city/' + f });
    }
    if (p === '/api/jobs' && req.method === 'POST') { const job = await createJob(await readBody(req)); return send(res, 200, buildResponse(job)); }
    if (p === '/api/jobs' && req.method === 'GET') return send(res, 200, [...jobs.values()].sort((a, b) => b.created.localeCompare(a.created)).slice(0, 30).map(j => ({ id: j.id, title: j.plan && j.plan.rq && j.plan.rq.offering.display_name, status: j.status, profile: j.profile, created: j.created })));
    const m = p.match(/^\/api\/jobs\/(job_\w+)(?:\/(layout|render|review))?$/);
    if (m) {
      const job = jobs.get(m[1]); if (!job) return send(res, 404, { error: 'Unknown job.' });
      if (!m[2] && req.method === 'GET') return send(res, 200, buildResponse(job));
      if (req.method === 'POST') {
        const body = await readBody(req);
        try { if (m[2] === 'layout') handleLayout(job, body); else if (m[2] === 'render') await handleRender(job, body); else if (m[2] === 'review') handleReview(job, body); }
        catch (e) { if (e.code) return send(res, e.code, { error: e.message }); job.status = 'ERROR'; job.message = 'Technical failure: ' + e.message; saveJob(job); console.error(e); return send(res, 200, buildResponse(job)); }
        return send(res, 200, buildResponse(job));
      }
    }
    let dl = p.match(/^\/download\/(job_\w+)\.png$/);
    if (dl) { const j = jobs.get(dl[1]); if (!j || j.status !== 'READY' || !j.artifact_id) return send(res, 403, { error: 'Only a flyer that passed both gates can be downloaded.' }); return serveFile(res, path.join(DIRS.art, j.artifact_id + '.png'), DIRS.art, { 'Content-Disposition': 'attachment; filename="flyer-' + j.id + '.png"' }); }
    dl = p.match(/^\/preview\/(art_\w+)\.png$/); if (dl) return serveFile(res, path.join(DIRS.art, dl[1] + '.png'), DIRS.art);
    const csp = { 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" };
    if (p.startsWith('/assets/')) return serveFile(res, path.join(ROOT, p), path.join(ROOT, 'assets'), csp);
    if (p.startsWith('/uploads/city/')) return serveFile(res, path.join(ROOT, p), path.join(ROOT, 'uploads', 'city'), csp);
    const f = p === '/' ? '/index.html' : p; return serveFile(res, path.join(ROOT, 'public', f), path.join(ROOT, 'public'));
  } catch (e) { console.error(e); send(res, 500, { error: e.message === 'too large' ? 'Upload too large.' : 'Server error.' }); }
});
if (require.main === module) server.listen(PORT, () => console.log(`Flyer Studio running at http://localhost:${PORT}`));
module.exports = { server, createJob };
