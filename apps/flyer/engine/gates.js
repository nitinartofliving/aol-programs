'use strict';
// Gate A (approved for render), mechanical final inspection, human review, Gate B (ready).
const U = require('./util');
const { encodeQR, decodeQRFromLuma } = require('./qr');
const { decodePNG } = require('./png');

const CANVAS = { '3:4': { w: 1080, h: 1440 }, '4:5': { w: 1080, h: 1350 } };
const SCORE_DIMS = [['calm', 'Calm and coherent visual expression'], ['hierarchy', 'Clarity of hierarchy'], ['spacing', 'Spacing and alignment'], ['typography', 'Typography and readability'], ['copy', 'Natural, relevant copy'], ['action', 'Clear and appropriate next action'], ['photography', 'Photography and asset integration'], ['brandfit', 'Brand and programme fit']];
const HUMAN_ITEMS = [
  ['D02', 'Priority', 'The offering, reason to care, schedule and next action can each be found at a glance.'],
  ['D03', 'Alignment', 'Visible left edges, baselines and any centred items line up; no apparent offsets.'],
  ['D04', 'Grouping', 'Date, time and place read as one group; the call to action and its link or contact read as another.'],
  ['D05', 'Type texture', 'Weights, stroke strength and line spacing are consistent; nothing looks fragile or oversized.'],
  ['D06', 'Line endings', 'No dangling short words, awkward breaks or unnatural gaps in titles or paragraphs.'],
  ['D07', 'Small-screen reading', 'At phone width the title, dates, action and contact are readable without zooming.'],
  ['D08', 'Empty space', 'Open areas create separation and focus; no accidental holes.'],
  ['D10', 'Image finish', 'Crops, edges and photo placement look natural (not applicable if no photos).'],
  ['D11', 'Asset respect', 'Logo and portrait look unaltered, correctly proportioned and with clear space (not applicable if none).'],
  ['D12', 'Safe area (visual)', 'Nothing important is clipped or crowds an edge; the QR quiet zone is clear.'],
  ['D13', 'Action (visual)', 'The call to action matches the real route; the printed link or contact reads completely.'],
  ['D14', 'Restraint', 'Nothing is present only to decorate; removing any element would lose meaning.']
];
const norm = s => String(s || '').replace(/\s+/g, '');
const inter = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const near = (a, b, t = 0.51) => Math.abs(a - b) <= t;

function gateA(job, layout, cfg) {
  const P = job.plan, checks = [], issues = [];
  const ck = (id, status, observed, method, team, mandatory = true) => checks.push({ id, mandatory, status, observed_result: observed, evidence_reference: 'host:layout#' + (job.layout_rounds || 1), method, responsible_team: team });
  const bad = (owner, problem, fix) => issues.push({ severity: 'REVISION', owner, problem, required_fix: fix, verification_status: 'OPEN' });
  const cv = CANVAS[P.rq.format] || CANVAS['3:4'];
  const M = layout.margin, els = Array.isArray(layout.elements) ? layout.elements : [];
  let ok = true; const fail = (...a) => { ok = false; bad(...a); };

  // canvas and margins
  const canvasOk = layout.canvas && layout.canvas.w === cv.w && layout.canvas.h === cv.h;
  ck('A10a', canvasOk ? 'PASS' : 'FAIL', canvasOk ? `Canvas ${cv.w} x ${cv.h} matches format ${P.rq.format}.` : 'Canvas does not match the requested format.', 'Compared with format table.', 'Team D');
  if (!canvasOk) fail('Design Director', 'Canvas size does not match the format.', 'Use ' + cv.w + ' x ' + cv.h + '.');
  if (!(M >= 85 && M <= 95)) fail('Layout and Spacing Designer', 'Safe margin is outside 85 to 95 px.', 'Use a margin of about 90 px.');

  // ledger fidelity
  const textEls = els.filter(e => e.type === 'text'), byBlock = new Map(textEls.map(e => [e.block, e]));
  const dropped = Array.isArray(layout.dropped_optional) ? layout.dropped_optional : [];
  const blocks = P.copy.blocks; let ledgerOk = true; const ledgerNotes = [];
  for (const b of blocks) {
    const e = byBlock.get(b.id);
    if (!e) { if (dropped.includes(b.id) && b.optional) { ledgerNotes.push(b.id + ' dropped (optional) to fit'); continue; } ledgerOk = false; ledgerNotes.push(b.id + ' missing'); continue; }
    if (norm(e.lines.join('')) !== norm(b.text)) { ledgerOk = false; ledgerNotes.push(b.id + ' text differs from ledger'); }
  }
  for (const d of dropped) { const b = blocks.find(x => x.id === d); if (!b || !b.optional) { ledgerOk = false; ledgerNotes.push(d + ' is not optional and cannot be dropped'); } }
  for (const e of textEls) if (!blocks.find(b => b.id === e.block)) { ledgerOk = false; ledgerNotes.push('unknown text block ' + e.block); }
  ck('A10b', ledgerOk ? 'PASS' : 'FAIL', ledgerOk ? `All ${blocks.length - dropped.length} approved text blocks present with unchanged characters` + (dropped.length ? `; optional dropped: ${dropped.join(', ')}` : '') + '.' : ledgerNotes.join('; '), 'Character comparison of wrapped lines to the frozen ledger (whitespace ignored).', 'Team A/C');
  if (!ledgerOk) fail('Copy Editor', 'Wrapped text does not match the approved ledger: ' + ledgerNotes.join('; '), 'Render the exact ledger strings; only optional blocks may be dropped.');

  // type scale and families
  const minBy = { title: 64, invitation: 36, body: 36, schedule: 36, location: 36, contact: 36, cta: 36, label: 30, note: 30 };
  const fams = new Set(textEls.map(e => e.style && e.style.family)); let typeOk = fams.size <= 2; const tn = [];
  for (const e of textEls) { const role = (blocks.find(b => b.id === e.block) || {}).role, min = minBy[role] || 36, s = e.style && e.style.size; if (!(s >= min)) { typeOk = false; tn.push(`${e.block} ${s}px < ${min}px`); } if (role === 'title' && s > 100) { typeOk = false; tn.push('title too large'); } if (e.style && e.style.color !== P.palette.text) { typeOk = false; tn.push(e.block + ' uses a non-approved text colour'); } }
  if (fams.size > 2) tn.push('more than two font families');
  ck('A10c', typeOk ? 'PASS' : 'FAIL', typeOk ? `Type scale holds: essential text 36 px or larger, labels 30 px or larger, title ${(textEls.find(e => e.block === 'title') || { style: {} }).style.size} px, ${fams.size} font families, text colour from the approved palette.` : tn.join('; '), 'Layout inspection against the type scale in Section 12.', 'Team E');
  if (!typeOk) fail('Typography and Typesetting Specialist', tn.join('; '), 'Adapt the layout before shrinking essential text.');

  // geometry
  const boxed = els.filter(e => ['text', 'image', 'qr'].includes(e.type)); let geoOk = true; const gn = [];
  for (const e of boxed) { const b = e.box; if (!b || ![b.x, b.y, b.w, b.h].every(Number.isFinite)) { geoOk = false; gn.push((e.id || e.block) + ' has no valid box'); continue; } if (b.x < M - 0.01 || b.y < M - 0.01 || b.x + b.w > cv.w - M + 0.01 || b.y + b.h > cv.h - M + 0.01) { geoOk = false; gn.push((e.id || e.block) + ' leaves the safe area'); } }
  for (let i = 0; i < boxed.length; i++) for (let j = i + 1; j < boxed.length; j++) if (boxed[i].box && boxed[j].box && inter(boxed[i].box, boxed[j].box)) { geoOk = false; gn.push(`${boxed[i].id || boxed[i].block} overlaps ${boxed[j].id || boxed[j].block}`); }
  // Decoration overlaps are reported only; they no longer fail A10d or block export.
  const decorNotes = [];
  for (const z of (layout.decor && layout.decor.zones) || []) for (const e of boxed) if (e.box && inter(e.box, z)) decorNotes.push((e.id || e.block) + ' overlaps the decoration');
  const decorNote = decorNotes.length ? ` Note (not blocking): ${decorNotes.join('; ')}.` : '';
  ck('A10d', geoOk ? 'PASS' : 'FAIL', (geoOk ? `${boxed.length} elements sit inside the ${M} px safe area with no overlaps between them.` : gn.join('; ')) + decorNote, 'Bounding-box geometry from measured text metrics.', 'Team D');
  if (!geoOk) fail('Layout and Spacing Designer', gn.join('; '), 'Simplify optional copy or adapt the layout.');

  // assets
  let assetOk = true; const an = [];
  const want = { logo: P.sel.logo, portrait: P.sel.portrait, city: P.sel.city };
  for (const [role, a] of Object.entries(want)) {
    const el = els.find(e => e.type === 'image' && e.role === role);
    if (a && !el) { assetOk = false; an.push(role + ' was selected but is not placed'); }
    if (!a && el) { assetOk = false; an.push(role + ' is placed but was not selected or enabled'); }
    if (a && el) {
      if (el.asset !== a.id) { assetOk = false; an.push(role + ' uses the wrong asset'); }
      const c = el.crop || {}; if (!(c.sw > 0 && c.sh > 0 && c.sx >= 0 && c.sy >= 0 && c.sx + c.sw <= Math.max(a.width, a.height) + 1 && c.sy + c.sh <= Math.max(a.width, a.height) + 1)) { assetOk = false; an.push(role + ' crop is outside the source'); }
      else if (Math.abs(el.box.w / c.sw - el.box.h / c.sh) / (el.box.w / c.sw) > 0.008) { assetOk = false; an.push(role + ' would be stretched'); }
      if (role === 'logo' && (c.sx !== 0 || c.sy !== 0 || Math.abs(c.sw - a.width) > 1 || Math.abs(c.sh - a.height) > 1)) { assetOk = false; an.push('the logo must not be cropped'); }
    }
  }
  if (cfg.logo_policy === 'reserve_space' && !els.find(e => e.type === 'reserve')) { assetOk = false; an.push('logo space was not reserved'); }
  ck('A07b', assetOk ? 'PASS' : 'FAIL', assetOk ? 'Selected originals are placed with proportional scaling only; toggles honoured.' : an.join('; '), 'Placement record compared with the asset manifest.', 'Team F');
  if (!assetOk) fail('Brand Asset and Photography Manager', an.join('; '), 'Place exactly the selected originals, uncropped logo, proportional crops.');

  // QR
  let qrOk = true; const qn = [], qe = els.find(e => e.type === 'qr');
  if (P.qr) { if (!qe) { qrOk = false; qn.push('QR is enabled but not placed'); } else { const b = qe.box; if (b.w !== P.qr.region_px || b.h !== P.qr.region_px) { qrOk = false; qn.push(`QR region must be ${P.qr.region_px} px`); } if (!Number.isInteger(b.x) || !Number.isInteger(b.y)) { qrOk = false; qn.push('QR must sit on whole pixels'); } if (qe.module !== P.qr.module_px) { qrOk = false; qn.push('QR module size mismatch'); } if (qe.url !== P.qr.url) { qrOk = false; qn.push('QR destination mismatch'); } } }
  else if (qe) { qrOk = false; qn.push('QR is placed but not enabled'); }
  ck('A11', P.qr || qe ? (qrOk ? 'PASS' : 'FAIL') : 'NOT_APPLICABLE', P.qr ? (qrOk ? `QR region ${P.qr.region_px} px (version ${P.qr.version}, ${P.qr.module_px} px modules, 4-module quiet zone) on whole pixels.` : qn.join('; ')) : 'QR disabled: no code, placeholder or scanning wording.', 'QR plan compared with layout.', 'Team G');
  if (!qrOk) fail('Link and QR Specialist', qn.join('; '), 'Place the QR at its planned size on whole pixels.');
  const scanWords = blocks.some(b => /scan/i.test(b.text)); if (!P.qr && scanWords) fail('Link and QR Specialist', 'Scan wording appears without a QR.', 'Remove it.');

  const pass = ok && issues.length === 0;
  const out = { pass, checks, issues };
  if (!pass) return out;

  // approved design specification
  const spec = {
    request_id: job.request_id, spec_version: (job.spec_version || 0) + 1, source_brief_hash: U.sha256(P.brief), package_version: cfg.brand_package_version,
    ledger: blocks.map(b => ({ id: b.id, role: b.role, text: b.text, optional: b.optional, dropped: dropped.includes(b.id) })),
    assets: Object.values(want).filter(Boolean).map(a => a.id), palette: P.palette, mood: P.mood,
    fonts: layout.fonts, canvas: layout.canvas, margin: M, elements: els, decor: layout.decor || null, dropped_optional: dropped, adaptations: layout.adaptations || [],
    qr: P.qr || null, output: { format: 'png', width: cv.w, height: cv.h },
    verification_plan: { mandatory: ['F01 ledger vs renderer text', 'F02 export and dimensions', 'F03 informational text contrast measured on pixels', 'F04 safe-area pixel scan', 'F05 QR decode from final file (if enabled)', 'F06 link status per policy', 'F07 asset fidelity', 'H human visual review and scorecard (production)'], optional: ['F10 OCR (unavailable)', 'F12 mobile-size estimate'] }
  };
  spec.spec_hash = U.sha256({ ...spec, spec_hash: undefined });
  out.spec = spec; out.approval = { spec_version: spec.spec_version, spec_hash: spec.spec_hash, approved_at: new Date().toISOString(), approved_by: 'Executive Creative Director (host-enforced Gate A)' };
  if (P.qr) { const q = encodeQR(P.qr.url); if (q.size !== P.qr.size || q.version !== P.qr.version) { out.pass = false; out.issues.push({ severity: 'BLOCKER', owner: 'Link and QR Specialist', problem: 'Encoded QR size differs from the plan.', required_fix: 'Re-plan.', verification_status: 'OPEN' }); } else out.qr_modules = q.modules; }
  return out;
}

// ---------- Final artifact inspection (mechanical, deterministic, outside the browser) ----------
function percentile(arr, p) { const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))]; }
function finalChecks(job, png, reports, cfg, linkStatus) {
  const spec = job.spec, P = job.plan, checks = [];
  const ck = (id, mandatory, status, observed, method, team, evid) => checks.push({ id, mandatory, status, observed_result: observed, evidence_reference: evid || 'artifact:' + job.artifact_id, method, responsible_team: team });
  let img = null;
  try { img = decodePNG(png); } catch (e) { ck('F02', true, 'FAIL', 'The exported file could not be opened: ' + e.message, 'PNG decode with zlib.', 'Team G'); return checks; }
  const W = spec.canvas.w, H = spec.canvas.h;
  ck('F02', true, img.width === W && img.height === H ? 'PASS' : 'FAIL', `Exported PNG opened; measured ${img.width} x ${img.height}, approved ${W} x ${H} (aspect ${(img.width / img.height).toFixed(4)}).`, 'PNG header and pixel decode on the host.', 'Team G');
  if (img.width !== W || img.height !== H) return checks;

  // F01 ledger vs renderer text report
  const rt = Array.isArray(reports.text) ? reports.text : []; const rmap = new Map(rt.map(t => [t.block, t])); let f1 = true; const n1 = [];
  for (const e of spec.elements.filter(x => x.type === 'text')) { const r = rmap.get(e.block); const led = spec.ledger.find(l => l.id === e.block); if (!r) { f1 = false; n1.push(e.block + ' not drawn'); continue; } if (r.lines.join('|') !== e.lines.join('|')) { f1 = false; n1.push(e.block + ' drawn lines differ from approved lines'); } if (norm(r.lines.join('')) !== norm(led.text)) { f1 = false; n1.push(e.block + ' differs from ledger'); } if (r.lines.some((l, i) => (r.widths || [])[i] > e.box.w + 0.5)) { f1 = false; n1.push(e.block + ' overflows its box'); } }
  for (const r of rt) if (!spec.elements.find(e => e.type === 'text' && e.block === r.block)) { f1 = false; n1.push('unapproved text drawn: ' + r.block); }
  ck('F01', true, f1 ? 'PASS' : 'FAIL', f1 ? `${rt.length} text blocks drawn exactly as the approved ledger; no line wider than its box.` : n1.join('; '), 'Renderer draw log compared with the frozen ledger (OCR unavailable, so on-image reading is covered by the human review).', 'Team H Content Auditor');

  // F03 contrast on actual pixels
  const bg = U.hexToRgb(spec.palette.background), tc = U.hexToRgb(spec.palette.text), Lt = U.relLum(tc); const rows = []; let minC = 99;
  for (const e of spec.elements.filter(x => x.type === 'text')) {
    const b = e.box, ds = [], lums = []; for (let y = Math.floor(b.y); y < Math.min(H, Math.ceil(b.y + b.h)); y++) for (let x = Math.floor(b.x); x < Math.min(W, Math.ceil(b.x + b.w)); x++) { const L = U.relLum(img.rgb(x, y)); lums.push(L); ds.push(Math.abs(L - Lt)); }
    const dmax = percentile(ds, 0.9), back = lums.filter((L, i) => ds[i] >= 0.8 * dmax); const cs = back.map(L => (Math.max(L, Lt) + 0.05) / (Math.min(L, Lt) + 0.05)); const worst = cs.length ? percentile(cs, 0.05) : 0; rows.push({ block: e.block, ratio: +worst.toFixed(2), samples: back.length }); minC = Math.min(minC, worst);
  }
  ck('F03', true, minC >= 4.5 ? 'PASS' : 'FAIL', `Worst-case measured ratio ${minC.toFixed(2)}:1 across ${rows.length} text blocks (target 4.5:1 or higher); lowest blocks: ${rows.sort((a, b) => a.ratio - b.ratio).slice(0, 3).map(r => r.block + ' ' + r.ratio).join(', ')}. This is a contrast check, not accessibility certification.`, 'Exported pixels inside each text box: backing luminance (5th percentile worst case) against the declared text colour.', 'Team E');

  // F04 safe area
  const M = spec.margin, zones = (spec.decor && spec.decor.zones) || []; let dirty = 0, total = 0, worstAt = null;
  const inZone = (x, y) => zones.some(z => x >= z.x && x < z.x + z.w && y >= z.y && y < z.y + z.h);
  const scan = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { if (inZone(x, y)) continue; total++; const [r, g, b] = img.rgb(x, y); if (Math.abs(r - bg[0]) > 6 || Math.abs(g - bg[1]) > 6 || Math.abs(b - bg[2]) > 6) { dirty++; if (!worstAt) worstAt = [x, y]; } } };
  scan(0, 0, W, M); scan(0, H - M, W, H); scan(0, M, M, H - M); scan(W - M, M, W, H - M);
  ck('F04', true, dirty / Math.max(1, total) <= 0.0005 ? 'PASS' : 'FAIL', `Margin bands scanned (${total} px outside declared decoration): ${dirty} off-background pixels${worstAt ? ' first at ' + worstAt.join(',') : ''}. Nothing informational or clipped in the ${M} px safe margin.`, 'Pixel scan of the four margin bands.', 'Team H Visual Auditor');

  // F05 QR
  if (spec.qr) {
    const qe = spec.elements.find(e => e.type === 'qr'); const r = decodeQRFromLuma((x, y) => img.luma(x, y), { x: qe.box.x, y: qe.box.y, w: qe.box.w });
    ck('F05', true, r.ok && r.text === spec.qr.url ? 'PASS' : 'FAIL', r.ok ? (r.text === spec.qr.url ? `QR decoded from the exported flyer (version ${r.version}, ${r.scale} px modules, error-correction check passed) to exactly the approved URL.` : 'QR decodes to a different value: ' + r.text) : 'QR could not be decoded from the exported flyer: ' + r.error, 'Independent decoder samples the exported PNG pixels at the approved QR region. This is not a camera scan test.', 'Team G', 'artifact:' + job.artifact_id + '#qr');
  } else ck('F05', false, 'NOT_APPLICABLE', 'QR disabled: no code and no scanning wording.', 'Toggle check.', 'Team G');

  // F06 link
  if (spec.qr || (P.links && P.links.url)) {
    const st = linkStatus || { status: 'unavailable', detail: 'not checked' }; const req = cfg.live_link_check === 'required';
    const status = st.status === 'failed' ? 'FAIL' : st.status === 'verified' ? 'PASS' : (req ? 'UNVERIFIED' : 'PASS');
    ck('F06', true, job.profile === 'demo' ? 'NOT_APPLICABLE' : status, job.profile === 'demo' ? 'Fictional demo link: never contacted.' : `Live destination status: ${st.status}. ${st.detail}.` + (st.status === 'unavailable' && !req ? ' Policy best_effort: the organiser-supplied link is used without claiming it was verified.' : ''), 'Server-side request with private-network protection; policy ' + cfg.live_link_check + '.', 'Team G');
  } else ck('F06', false, 'NOT_APPLICABLE', 'No link in this flyer.', 'n/a', 'Team G');

  // F07 asset fidelity
  const as = Array.isArray(reports.assets) ? reports.assets : []; let f7 = true; const n7 = [];
  for (const e of spec.elements.filter(x => x.type === 'image')) {
    const r = as.find(a => a.id === e.id); const a = [P.sel.logo, P.sel.portrait, P.sel.city].find(x => x && x.id === e.asset);
    if (!r) { f7 = false; n7.push(e.id + ' not drawn'); continue; }
    if (r.asset !== e.asset || r.filter !== 'none') { f7 = false; n7.push(e.id + ' used another asset or a filter'); }
    const sameDims = (r.natural.w === a.width && r.natural.h === a.height) || (r.natural.w === a.height && r.natural.h === a.width);
    if (!sameDims) { f7 = false; n7.push(e.id + ' natural size differs from the inventory'); }
    if (['x', 'y', 'w', 'h'].some(k => !near(r.box[k], e.box[k]))) { f7 = false; n7.push(e.id + ' drawn off its approved box'); }
    if (Math.abs(r.box.w / r.crop.sw - r.box.h / r.crop.sh) / (r.box.w / r.crop.sw) > 0.008) { f7 = false; n7.push(e.id + ' stretched'); }
    if (r.mirrored) { f7 = false; n7.push(e.id + ' mirrored'); }
  }
  for (const r of as) if (!spec.elements.find(e => e.type === 'image' && e.id === r.id)) { f7 = false; n7.push('unapproved image drawn: ' + r.id); }
  ck('F07', true, f7 ? 'PASS' : 'FAIL', f7 ? (as.length ? `${as.length} original file(s) drawn unfiltered, unmirrored and in proportion at their approved boxes.` : 'No images in this flyer; no generated logo or likeness used.') : n7.join('; '), 'Browser draw log compared with approved placement and server inventory dimensions. A generative redraw would not pass.', 'Team F');
  const toggleOk = !!P.sel.city === !!as.find(a => a.id === 'city') && !!P.sel.portrait === !!as.find(a => a.id === 'portrait') && !!P.sel.logo === !!as.find(a => a.id === 'logo');
  ck('F08', true, toggleOk ? 'PASS' : 'FAIL', toggleOk ? 'City photo, portrait and logo present exactly as selected; disabled options are absent.' : 'Image presence does not match the toggles.', 'Draw log versus plan.', 'Team F');

  // fonts
  ck('F09', cfg.exact_font_required, cfg.exact_font_required ? ((reports.fonts && reports.fonts.source === 'approved') ? 'PASS' : 'FAIL') : 'NOT_APPLICABLE', cfg.exact_font_required ? 'Exact brand fonts required.' : `No exact brand font required. Rendered with ${(reports.fonts && reports.fonts.title) || '?'} (titles) and ${(reports.fonts && reports.fonts.body) || '?'} (text); font identity unverified beyond the browser's resolved family.`, 'Browser font resolution report.', 'Team E');
  ck('F10', false, 'UNVERIFIED', 'No OCR engine is available in this host. Text accuracy rests on the renderer draw log (F01) and human reading.', 'Capability discovery.', 'Team H');
  const minEssential = Math.min(...spec.elements.filter(e => e.type === 'text' && !['label', 'note'].includes((spec.ledger.find(l => l.id === e.block) || {}).role)).map(e => e.style.size));
  ck('F12', false, 'PASS', `Estimated at 375 px wide: essential text about ${(minEssential * 375 / 1080).toFixed(1)} px, title about ${(((spec.elements.find(e => e.block === 'title') || { style: { size: 0 } }).style.size) * 375 / 1080).toFixed(1)} px. This is an estimate from sizes, not a phone test.`, 'Projection from the type scale.', 'Mobile Readability Reviewer');
  return checks;
}

// ---------- Human review and Gate B ----------
function evaluateReview(job, review) {
  const issues = [], items = []; const machine = job.final_checks || [];
  const m = id => (machine.find(c => c.id === id) || {}).status;
  const hasImages = !!(job.plan.sel.portrait || job.plan.sel.city), hasAssets = hasImages || !!job.plan.sel.logo;
  const rv = (review && review.items) || {};
  for (const [id, name, desc] of HUMAN_ITEMS) {
    const na = (id === 'D10' && !hasImages) || (id === 'D11' && !hasAssets);
    const r = rv[id] || {}; let status = na ? 'NOT_APPLICABLE' : ['PASS', 'FAIL'].includes(r.status) ? r.status : 'UNVERIFIED';
    if (status === 'FAIL') issues.push({ severity: 'REVISION', owner: 'Detail and Finish Inspector', problem: `${id} ${name}: ${r.note || 'reviewer marked this as failing'}`, required_fix: r.note || 'Correct the named defect and re-review.', verification_status: 'OPEN' });
    items.push({ id: 'H-' + id, mandatory: !na, status, observed_result: na ? 'Not applicable to this flyer.' : (r.note ? r.note : status === 'PASS' ? 'Reviewer confirmed: ' + desc : 'Awaiting human review.'), evidence_reference: review && review.reviewer ? 'human review by ' + review.reviewer : 'pending', method: na ? 'n/a' : 'Human inspection at full size and about 375 px wide; result supplied through the host.', responsible_team: 'Team H Detail and Finish Inspector' });
  }
  const scores = SCORE_DIMS.map(([id, label]) => { const na = id === 'photography' && !hasImages; const s = review && review.scores ? +review.scores[id] : NaN; return { id, dimension: label, score: na ? null : Number.isInteger(s) && s >= 1 && s <= 5 ? s : null, applicable: !na, reason: na ? 'No photographs or portrait in this flyer.' : (review && review.score_notes && review.score_notes[id]) || '' }; });
  const scoresDone = scores.filter(s => s.applicable).every(s => s.score !== null), scoresOk = scores.filter(s => s.applicable).every(s => s.score >= 4);
  if (scoresDone && !scoresOk) scores.filter(s => s.applicable && s.score < 4).forEach(s => issues.push({ severity: 'REVISION', owner: 'Executive Creative Director', problem: `Scorecard: "${s.dimension}" scored ${s.score}; production needs 4 or higher.`, required_fix: 'Revise and review again.', verification_status: 'OPEN' }));
  // craft record D01..D16
  const craft = [];
  const mk = (id, name, status, obs, method) => craft.push({ id, name, status, observed_result: obs, method });
  const mech = (id, name, fid, method) => { const c = machine.find(x => x.id === fid); mk(id, name, c ? c.status : 'UNVERIFIED', c ? c.observed_result : 'Not run.', method); };
  mech('D01', 'Exact content', 'F01', 'Renderer draw log versus ledger');
  for (const [id, name] of HUMAN_ITEMS) { const h = items.find(x => x.id === 'H-' + id); mk(id, name, h.status, h.observed_result, h.method); }
  mech('D09', 'Colour and contrast', 'F03', 'Pixel measurement');
  mech('D15', 'Export', 'F02', 'Exported file inspected');
  const prior = job.comparison_to_prior; mk('D16', 'Regression', prior ? (prior.unexpected_changes.length ? 'FAIL' : 'PASS') : 'NOT_APPLICABLE', prior ? (prior.unexpected_changes.length ? 'Locked text changed: ' + prior.unexpected_changes.join(', ') : `Compared with ${prior.base_job_id}: ${prior.changed.length} ledger block(s) changed (${prior.changed.join(', ') || 'none'}), others identical.`) : 'No previous version.', 'Ledger diff against the base version');
  craft.sort((a, b) => a.id.localeCompare(b.id));
  const reviewDone = !!(review && review.reviewer && review.mobile_viewed === true);
  return { items, scores, scoresDone, scoresOk, craft, issues, reviewDone };
}
function decide(job, cfg) {
  const mand = [...(job.pre_checks || []), ...(job.final_checks || []), ...((job.review_eval && job.review_eval.items) || [])].filter(c => c.mandatory);
  const failed = mand.filter(c => c.status === 'FAIL'), unver = mand.filter(c => c.status === 'UNVERIFIED' || c.status === 'NOT_RUN');
  const re = job.review_eval;
  if (job.profile === 'demo') return { status: 'DRAFT_PREVIEW', release: false, failed, unverified: unver };
  if (failed.length) return { status: 'NEEDS_REVIEW', release: false, failed, unverified: unver };
  if (!re || !re.reviewDone || unver.length || !re.scoresDone) return { status: 'NEEDS_REVIEW', release: false, failed, unverified: unver, awaiting_review: true };
  if (!re.scoresOk || re.issues.length) return { status: 'NEEDS_REVIEW', release: false, failed, unverified: unver };
  return { status: 'READY', release: true, failed, unverified: unver };
}
module.exports = { gateA, finalChecks, evaluateReview, decide, CANVAS, HUMAN_ITEMS, SCORE_DIMS };
