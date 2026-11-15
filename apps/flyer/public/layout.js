/* Layout engine (Teams D and E). Measures real text with the browser's fonts, wraps phrase by phrase,
   and proposes element boxes. The host re-validates every rule before approving the spec. */
(function () {
  const FL = {};
  const TITLE_CANDIDATES = ['Iowan Old Style', 'Palatino Linotype', 'Palatino', 'Book Antiqua', 'Georgia', 'Cambria', 'Charter', 'Liberation Serif', 'DejaVu Serif', 'Times New Roman'];
  const BODY_CANDIDATES = ['Avenir Next', 'Segoe UI', 'Helvetica Neue', 'Inter', 'Arial', 'Liberation Sans', 'DejaVu Sans'];
  const mctx = document.createElement('canvas').getContext('2d');

  function installed(name, generic) {
    const t = 'mmmmmmmmmmlliWWW@@';
    const w = f => { mctx.font = '72px ' + f; return mctx.measureText(t).width; };
    return w(`"${name}", monospace`) !== w('monospace') || w(`"${name}", ${generic}`) !== w(generic);
  }
  FL.resolveFonts = async function (inputs) {
    const af = inputs.fonts || {}, files = inputs.approved_fonts_files || [];
    const out = { title: null, body: null, source: 'system' };
    for (const role of ['title', 'body']) {
      const want = af[role], file = want && files.find(f => f.filename === want);
      if (file) { try { const ff = new FontFace('Approved' + role, `url(${file.url})`); await ff.load(); document.fonts.add(ff); out[role] = { name: 'Approved' + role + ' (' + want + ')', css: `"Approved${role}", ${role === 'title' ? 'serif' : 'sans-serif'}` }; out.source = 'approved'; continue; } catch (e) { /* fall back to system */ } }
      const generic = role === 'title' ? 'serif' : 'sans-serif', list = role === 'title' ? TITLE_CANDIDATES : BODY_CANDIDATES;
      const found = list.find(n => installed(n, generic));
      out[role] = found ? { name: found, css: `"${found}", ${generic}` } : { name: generic + ' (system default)', css: generic };
    }
    return out;
  };

  const STYLES = {
    label: { family: 'body', weight: 600, size: 32, lh: 1.3 },
    demo: { family: 'body', weight: 600, size: 30, lh: 1.3 },
    invitation: { family: 'body', weight: 400, size: 42, lh: 1.3 },
    body: { family: 'body', weight: 400, size: 36, lh: 1.4 },
    schedule: { family: 'body', weight: 500, size: 40, lh: 1.3 },
    location: { family: 'body', weight: 400, size: 38, lh: 1.35 },
    contact: { family: 'body', weight: 400, size: 36, lh: 1.4 },
    cta: { family: 'body', weight: 600, size: 42, lh: 1.25 },
    note: { family: 'body', weight: 400, size: 32, lh: 1.35 }
  };

  FL.compute = function (inp, imgs, fonts) {
    const W = inp.canvas.w, H = inp.canvas.h, M = inp.margin, cw = W - 2 * M, TXT = inp.palette.text;
    const cssFor = st => (st.family === 'title' ? fonts.title.css : fonts.body.css);
    const fontStr = st => `${st.weight} ${st.size}px ${cssFor(st)}`;
    const meas = (s, st) => { mctx.font = fontStr(st); return mctx.measureText(s).width; };
    function wrapOnce(text, st, maxW) {
      const words = text.split(' '), lines = []; let cur = '';
      const push = w => { if (meas(w, st) <= maxW) { cur = w; return; } let piece = ''; for (const ch of w) { if (meas(piece + ch, st) > maxW && piece) { lines.push(piece); piece = ch; } else piece += ch; } cur = piece; };
      for (const w of words) { const t = cur ? cur + ' ' + w : w; if (meas(t, st) <= maxW) cur = t; else { if (cur) lines.push(cur); push(w); } }
      if (cur) lines.push(cur); return lines;
    }
    function wrap(text, st, maxW) {
      let lines = wrapOnce(text, st, maxW);
      const lastWords = l => l.split(' ').length;
      if (lines.length >= 2 && lastWords(lines[lines.length - 1]) === 1 && lines[lines.length - 1].length < 9 && text.includes(' ')) {
        for (let k = 1; k <= 10; k++) { const l2 = wrapOnce(text, st, maxW * (1 - 0.03 * k)); if (l2.length === lines.length && lastWords(l2[l2.length - 1]) > 1) { lines = l2; break; } if (l2.length > lines.length) break; }
      }
      return lines;
    }
    const textEl = (block, st, x, y, w, lines) => { const lhPx = Math.round(st.size * st.lh); lines = lines || wrap(block.text, st, w); return { id: 't_' + block.id, type: 'text', block: block.id, lines, style: { family: st.family, weight: st.weight, size: st.size, lineHeight: st.lh, lhPx, color: TXT }, box: { x, y, w, h: lines.length * lhPx }, align: 'left', layer: 50 }; };
    const shift = (els, dy) => els.forEach(e => { e.box.y += dy; });

    function attempt(opts) {
      const drop = new Set(opts.drop), compact = !!opts.compact, blocks = inp.blocks.filter(b => !drop.has(b.id)), B = id => blocks.find(b => b.id === id), els = [];
      const logoMaxH = compact ? 72 : 88, heroGap = compact ? 40 : 56, zoneX = W - 260;
      // header
      let logoBox = null, headerH = 0, logoW = 0;
      if (inp.assets.logo && imgs.logo) { const a = inp.assets.logo, s = Math.min(300 / a.width, logoMaxH / a.height), w = Math.round(a.width * s), h = Math.round(a.height * s); logoBox = { x: M, y: M, w, h }; logoW = w; headerH = h; els.push({ id: 'logo', type: 'image', role: 'logo', asset: a.id, box: logoBox, src: { w: a.width, h: a.height }, crop: { sx: 0, sy: 0, sw: a.width, sh: a.height }, layer: 40 }); }
      else if (inp.logo_policy === 'reserve_space') { headerH = logoMaxH; els.push({ id: 'logo_reserve', type: 'reserve', box: { x: M, y: M, w: 300, h: logoMaxH }, layer: 1 }); logoW = 300; }
      if (B('demo_label')) { const x0 = logoW ? M + logoW + 24 : M, w = zoneX - 16 - x0, el = textEl(B('demo_label'), STYLES.demo, x0, M, w); els.push(el); headerH = Math.max(headerH, el.box.h); }
      const heroTop = headerH ? M + headerH + heroGap : (inp.mood.decor === 'rule' ? M : Math.max(M, 200));
      // hero
      const portrait = inp.assets.portrait && imgs.portrait ? inp.assets.portrait : null, sideW = compact ? 270 : 330, textW = portrait ? cw - sideW - 48 : cw;
      const hero = []; let y = 0;
      if (B('eyebrow')) { const e = textEl(B('eyebrow'), STYLES.label, M, y, textW); hero.push(e); y += e.box.h + 20; }
      const tb = B('title'); let tsize = 0, tlines = null;
      // Prefer a calmer two-line title at a slightly smaller size before accepting a taller one at the largest size.
      for (const [lim, top, bottom] of [[2, 92, 68], [3, 92, 64], [4, 92, 64]]) { if (lim > (portrait ? 4 : 3)) continue; for (let s = top; s >= bottom; s -= 4) { const l = wrap(tb.text, { family: 'title', weight: 600, size: s, lh: 1.08 }, textW); if (l.length <= lim) { tsize = s; tlines = l; break; } } if (tsize) break; }
      if (!tsize) return { fail: 'The title is too long to fit at 64 px or larger. Use a shorter display name.' };
      const tel = textEl(tb, { family: 'title', weight: 600, size: tsize, lh: 1.08 }, M, y, textW, tlines); hero.push(tel); y += tel.box.h + 28;
      const inv = textEl(B('invitation'), STYLES.invitation, M, y, textW); hero.push(inv); y += inv.box.h;
      for (const id of ['description', 'benefit_1', 'benefit_2', 'benefit_3', 'conditions']) if (B(id)) { y += id === 'description' ? 20 : 12; const e = textEl(B(id), STYLES.body, M, y, textW); hero.push(e); y += e.box.h; }
      const textH = y, portraitH = portrait ? Math.round(sideW * 4 / 3) : 0, heroH = Math.max(textH, portraitH);
      shift(hero, heroTop); els.push(...hero);
      if (portrait) { const src = portrait, r = 3 / 4; let sw, sh, sx, sy; if (src.width / src.height > r) { sh = src.height; sw = Math.round(sh * r); sx = Math.round((src.width - sw) / 2); sy = 0; } else { sw = src.width; sh = Math.round(sw / r); sx = 0; sy = Math.round((src.height - sh) * 0.12); } els.push({ id: 'portrait', type: 'image', role: 'portrait', asset: src.id, box: { x: W - M - sideW, y: heroTop, w: sideW, h: portraitH }, src: { w: src.width, h: src.height }, crop: { sx, sy, sw, sh }, layer: 30 }); }
      const heroBottom = heroTop + heroH;
      // action group (bottom anchored)
      const qr = inp.qr, qrPx = qr ? qr.region_px : 0, leftW = cw - (qr ? qrPx + 48 : 0), act = []; let ay = 0;
      act.push(textEl(B('cta'), STYLES.cta, M, ay, leftW)); ay += act[0].box.h + 14;
      if (B('url')) { const e = textEl(B('url'), STYLES.body, M, ay, leftW); act.push(e); ay += e.box.h + 14; }
      blocks.filter(b => /^contact_/.test(b.id)).forEach(b => { const e = textEl(b, STYLES.contact, M, ay, leftW); act.push(e); ay += e.box.h + (/_email$/.test(b.id) ? 14 : 2); });
      const actTextH = ay > 0 ? ay - 2 : 0, actionH = Math.max(actTextH, qrPx), actionTop = H - M - actionH; shift(act, actionTop + (qr && qrPx > actTextH ? Math.round((qrPx - actTextH) / 2) : 0)); els.push(...act);
      if (qr) els.push({ id: 'qr', type: 'qr', box: { x: W - M - qrPx, y: H - M - qrPx, w: qrPx, h: qrPx }, module: qr.module_px, quiet: qr.quiet_modules, size: qr.size, version: qr.version, url: qr.url, layer: 40 });
      // info group
      const info = []; let iy = 0; const sched = blocks.filter(b => /^sched_/.test(b.id));
      const oneLine = sched.every(b => meas(b.text, STYLES.schedule) <= cw);
      sched.forEach(b => { let lines = null; if (!oneLine && b.text.includes(' · ')) { const [a, c] = b.text.split(' · '); lines = [a + ' ·', c]; } const e = textEl(b, STYLES.schedule, M, iy, cw, lines); info.push(e); iy += e.box.h + 12; });
      if (B('tznote')) { const e = textEl(B('tznote'), STYLES.note, M, iy, cw); info.push(e); iy += e.box.h + 12; }
      iy += 20; blocks.filter(b => /^loc_/.test(b.id)).forEach(b => { const e = textEl(b, STYLES.location, M, iy, cw); info.push(e); iy += e.box.h + 4; });
      const infoH = Math.max(...info.map(e => e.box.y + e.box.h));
      const minGap = compact ? 40 : 64;
      let infoTop, cityEl = null;
      if (inp.assets.city && imgs.city) {
        const gapA = compact ? 32 : 48, gapB = compact ? 40 : 56, yPhoto = heroBottom + gapA, maxPh = actionTop - minGap - infoH - gapB - yPhoto, minPh = compact ? 140 : 180;
        if (maxPh < minPh) return { fail: 'Not enough vertical room for the city photo with this copy and schedule.' };
        const ph = Math.min(maxPh, 360), a = inp.assets.city, r = cw / ph; let sw, sh, sx, sy; if (a.width / a.height > r) { sh = a.height; sw = Math.round(sh * r); sx = Math.round((a.width - sw) / 2); sy = 0; } else { sw = a.width; sh = Math.round(sw / r); sx = 0; sy = Math.round((a.height - sh) / 2); }
        cityEl = { id: 'city', type: 'image', role: 'city', asset: a.id, box: { x: M, y: yPhoto, w: cw, h: ph }, src: { w: a.width, h: a.height }, crop: { sx, sy, sw, sh }, layer: 30 }; els.push(cityEl); infoTop = yPhoto + ph + gapB;
      } else {
        const free = actionTop - heroBottom - infoH; if (free < 2 * minGap) return { fail: 'Not enough vertical room for the schedule and action.' };
        infoTop = heroBottom + Math.min(Math.round(free * 0.5), 200);
        if (infoTop + infoH + minGap > actionTop) infoTop = actionTop - minGap - infoH;
      }
      if (infoTop + infoH + minGap > actionTop + 0.5) return { fail: 'Not enough vertical room between the schedule and the action group.' };
      shift(info, infoTop); els.push(...info);
      els.push({ id: 'rule_action', type: 'rule', box: { x: M, y: actionTop - Math.round(minGap * 0.6), w: 96, h: 4 }, color: inp.mood.accent, layer: 20 });
      const zone = { x: zoneX, y: 0, w: 260, h: 190 };
      return { ok: true, els, tsize, compact, zone };
    }
    // adaptation ladder: simplify optional copy first, then compact spacing. Never shrink essential type.
    const optional = inp.blocks.filter(b => b.optional).map(b => b.id), steps = [{ drop: [] }, { drop: optional.filter(i => /^benefit_/.test(i)) }, { drop: optional.filter(i => /^benefit_|^description$/.test(i)) }, { drop: optional.filter(i => /^benefit_|^description$/.test(i)), compact: true }, { drop: optional, compact: true }];
    const tried = []; let res = null, used = null;
    for (const s of steps) { const key = JSON.stringify(s); if (tried.includes(key)) continue; tried.push(key); res = attempt(s); if (res.ok) { used = s; break; } }
    if (!res || !res.ok) return { error: res ? res.fail : 'Layout failed.' };
    const adaptations = []; if (used.drop.length) adaptations.push('Dropped optional copy to fit: ' + used.drop.join(', ')); if (used.compact) adaptations.push('Compact spacing and smaller portrait to fit all enabled content');
    adaptations.push('Title set at ' + res.tsize + ' px');
    return { version: 1, canvas: { w: W, h: H }, margin: M, fonts: { title: fonts.title.name, body: fonts.body.name, source: fonts.source }, elements: res.els, decor: { kind: inp.mood.decor, accent: inp.mood.accent, stone: inp.palette.stone, sage: inp.palette.sage, zones: inp.mood.decor === 'rule' ? [] : [res.zone] }, dropped_optional: used.drop, adaptations };
  };
  window.FlyerLayout = FL;
})();
