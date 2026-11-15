/* Layered renderer (Team G). Draws ONLY the approved spec: background, decoration, original photos and logo
   as preserved layers (proportional crop only), genuine QR modules supplied by the host, and typeset text. */
(function () {
  const R = {};
  function sprig(ctx, W, color) {
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 3; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const x0 = W - 36, y0 = -10, x1 = W - 150, y1 = 168; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(W - 110, 50, x1, y1); ctx.stroke();
    const leaf = (t, side, len) => { const u = 1 - t, px = u * u * x0 + 2 * u * t * (W - 110) + t * t * x1, py = u * u * y0 + 2 * u * t * 50 + t * t * y1; const ang = Math.atan2(2 * u * (50 - y0) + 2 * t * (y1 - 50), 2 * u * ((W - 110) - x0) + 2 * t * (x1 - (W - 110))) + side * 0.9; const ex = px + Math.cos(ang) * len, ey = py + Math.sin(ang) * len, nx = -Math.sin(ang) * len * 0.28, ny = Math.cos(ang) * len * 0.28; ctx.beginPath(); ctx.moveTo(px, py); ctx.quadraticCurveTo(px + (ex - px) / 2 + nx, py + (ey - py) / 2 + ny, ex, ey); ctx.quadraticCurveTo(px + (ex - px) / 2 - nx, py + (ey - py) / 2 - ny, px, py); ctx.stroke(); };
    [[0.2, 1, 46], [0.34, -1, 50], [0.48, 1, 48], [0.62, -1, 44], [0.76, 1, 38], [0.9, -1, 28]].forEach(a => leaf(a[0], a[1], a[2])); ctx.restore();
  }
  R.draw = async function (canvas, spec, qrModules, imgs, fonts) {
    const W = spec.canvas.w, H = spec.canvas.h; canvas.width = W; canvas.height = H; const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = spec.palette.background; ctx.fillRect(0, 0, W, H);
    const d = spec.decor;
    if (d && d.kind === 'sun') { ctx.save(); ctx.beginPath(); ctx.rect(W - 260, 0, 260, 190); ctx.clip(); ctx.globalAlpha = 0.55; ctx.fillStyle = d.accent; ctx.beginPath(); ctx.arc(W - 40, 30, 170, 0, Math.PI * 2); ctx.fill(); ctx.restore(); }
    else if (d && d.kind === 'light') { ctx.save(); ctx.beginPath(); ctx.rect(W - 260, 0, 260, 190); ctx.clip(); const g = ctx.createRadialGradient(W, 0, 0, W, 0, 300); g.addColorStop(0, d.stone); g.addColorStop(1, spec.palette.background); ctx.globalAlpha = 0.65; ctx.fillStyle = g; ctx.fillRect(W - 260, 0, 260, 190); ctx.restore(); }
    else if (d && d.kind === 'sprig') { ctx.save(); ctx.beginPath(); ctx.rect(W - 260, 0, 260, 190); ctx.clip(); sprig(ctx, W, d.accent); ctx.restore(); }
    const textReport = [], assetReport = [], els = spec.elements.slice().sort((a, b) => (a.layer || 0) - (b.layer || 0));
    for (const e of els) {
      if (e.type === 'rule') { ctx.fillStyle = e.color; ctx.fillRect(e.box.x, e.box.y, e.box.w, e.box.h); }
      else if (e.type === 'image') {
        const img = imgs[e.role]; ctx.drawImage(img, e.crop.sx, e.crop.sy, e.crop.sw, e.crop.sh, e.box.x, e.box.y, e.box.w, e.box.h);
        assetReport.push({ id: e.id, asset: e.asset, natural: { w: img.naturalWidth || e.src.w, h: img.naturalHeight || e.src.h }, box: { ...e.box }, crop: { ...e.crop }, filter: 'none', mirrored: false });
      } else if (e.type === 'qr') {
        const s = e.module, q = e.quiet, n = e.size; ctx.fillStyle = '#FFFFFF'; ctx.fillRect(e.box.x, e.box.y, e.box.w, e.box.h); ctx.fillStyle = '#14201A';
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qrModules[r][c]) ctx.fillRect(e.box.x + (q + c) * s, e.box.y + (q + r) * s, s, s);
      }
    }
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    for (const e of els) {
      if (e.type !== 'text') continue; const st = e.style, css = st.family === 'title' ? fonts.title.css : fonts.body.css;
      ctx.font = `${st.weight} ${st.size}px ${css}`; ctx.fillStyle = st.color; const widths = [];
      e.lines.forEach((ln, i) => { const base = e.box.y + i * st.lhPx + (st.lhPx - st.size) / 2 + st.size * 0.8; ctx.fillText(ln, e.box.x, base); widths.push(ctx.measureText(ln).width); });
      textReport.push({ block: e.block, lines: e.lines.slice(), widths, font: ctx.font, size: st.size });
    }
    return { textReport, assetReport, fonts: { title: fonts.title.name, body: fonts.body.name, source: fonts.source } };
  };
  R.toBase64 = canvas => new Promise((ok, no) => canvas.toBlob(b => { if (!b) return no(new Error('Export failed')); const fr = new FileReader(); fr.onload = () => ok(String(fr.result).split(',')[1]); fr.onerror = no; fr.readAsDataURL(b); }, 'image/png'));
  window.FlyerRender = R;
})();
