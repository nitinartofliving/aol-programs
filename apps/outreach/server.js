// Zero-dependency server: static files + REST API + JSON-file storage + live data (OpenStreetMap).
const http = require('http'), fs = require('fs'), path = require('path');
const PORT = process.env.PORT || 3000;
const MOCK = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cities.json'), 'utf8'));
const DB_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB = path.join(DB_DIR, 'leads.json');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
// OpenStreetMap's Overpass servers reject or rate-limit placeholder User-Agents,
// so identify the app by its project page.
const UA = process.env.OUTREACH_USER_AGENT || 'AOL-Programs-Outreach/1.0 (+https://github.com/nitinartofliving/aol-programs)';
const OVERPASS = process.env.OVERPASS_URL ? [process.env.OVERPASS_URL] : ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OVERPASS_TIMEOUT_MS = 100000;
const CACHE_FILE = path.join(DB_DIR, 'places-cache.json');
const CACHE_FRESH_MS = 7 * 24 * 3600e3;
const RADIUS = 12000;
const COORDS = { Toronto: [43.6532, -79.3832, 'ON'], Vancouver: [49.2827, -123.1207, 'BC'], Montreal: [45.5017, -73.5673, 'QC'], Calgary: [51.0447, -114.0719, 'AB'], Edmonton: [53.5461, -113.4938, 'AB'], Ottawa: [45.4215, -75.6972, 'ON'], Winnipeg: [49.8951, -97.1384, 'MB'], Saskatoon: [52.1332, -106.67, 'SK'], Regina: [50.4452, -104.6189, 'SK'], Halifax: [44.6488, -63.5752, 'NS'], Moncton: [46.0878, -64.7782, 'NB'], Fredericton: [45.9636, -66.6431, 'NB'], Victoria: [48.4284, -123.3656, 'BC'], Hamilton: [43.2557, -79.8711, 'ON'], Kitchener: [43.4516, -80.4925, 'ON'], 'Quebec City': [46.8139, -71.208, 'QC'], "St. John's": [47.5615, -52.7126, 'NL'] };

const readLeads = () => { try { return JSON.parse(fs.readFileSync(DB, 'utf8')); } catch { return []; } };
const writeLeads = l => { try { fs.mkdirSync(DB_DIR, { recursive: true }); fs.writeFileSync(DB, JSON.stringify(l, null, 2)); } catch (e) { console.error(e.message); } };
const send = (res, code, b, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b)); };
const readBody = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch { r({}); } }); });

// ---------- Live places via OpenStreetMap Overpass (free, no key) ----------
// The free Overpass servers are often busy and can take 30-60 s to answer, so
// ask all of them at once and use the first good answer.
async function overpassQuery(ql) {
  try {
    return await Promise.any(OVERPASS.map(async url => {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(ql), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS) });
      if (!r.ok) throw new Error('Overpass ' + r.status + ' from ' + new URL(url).host);
      const j = await r.json();
      if (j.remark && /runtime error|timed out/i.test(j.remark)) throw new Error('Overpass: ' + j.remark);
      return j.elements || [];
    }));
  } catch (e) { throw new Error((e.errors || [e]).map(x => x.message).join('; ')); }
}
function toPlace(e, kind, role) {
  const T = e.tags || {};
  return {
    name: T.name || '', kind, address: [T['addr:housenumber'], T['addr:street']].filter(Boolean).join(' '),
    site: T.website || T['contact:website'] || '',
    contact: { name: '', role, email: T.email || T['contact:email'] || '', phone: T.phone || T['contact:phone'] || '' },
    osm: `https://www.openstreetmap.org/${e.type}/${e.id}`, source: 'Live · OpenStreetMap'
  };
}
const richness = p => (p.site ? 1 : 0) + (p.contact.email ? 2 : 0) + (p.contact.phone ? 1 : 0);
function dedupe(list) { const s = new Set(); return list.filter(p => p.name && !s.has(p.name.toLowerCase()) && s.add(p.name.toLowerCase())); }
// Results are saved to disk for 7 days so repeat searches are instant and
// survive restarts. If the live servers are down, older saved results are
// used before falling back to mock data.
const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; } };
const cache = readCache();
const saveCache = () => { try { fs.mkdirSync(DB_DIR, { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch (e) { console.error(e.message); } };
const pending = new Map();
async function livePlaces(city) {
  const hit = cache[city];
  if (hit && Date.now() - hit.t < CACHE_FRESH_MS) return { ...hit.v, savedAt: hit.t };
  if (!pending.has(city)) pending.set(city, fetchPlaces(city).finally(() => pending.delete(city)));
  try {
    const v = await pending.get(city);
    cache[city] = { t: Date.now(), v }; saveCache();
    return v;
  } catch (e) {
    if (hit) { console.error('Live lookup failed, using saved results:', e.message); return { ...hit.v, savedAt: hit.t, stale: true }; }
    throw e;
  }
}
async function fetchPlaces(city) {
  // A bounding box is much faster for Overpass than a radius search.
  const [lat, lon] = COORDS[city], dLat = RADIUS / 111320, dLon = RADIUS / (111320 * Math.cos(lat * Math.PI / 180));
  const a = `(${(lat - dLat).toFixed(4)},${(lon - dLon).toFixed(4)},${(lat + dLat).toFixed(4)},${(lon + dLon).toFixed(4)})`;
  // One combined request per server: the free servers allow only ~2 requests at a
  // time from one address, so separate searches queue up and time out.
  // Exact tag matches only: a name search across every gym is too slow for them.
  const elements = await overpassQuery(`[out:json][timeout:90];
    (nwr["amenity"="university"]${a};nwr["amenity"="college"]${a};)->.u;
    (nwr["sport"="yoga"]${a};nwr["sport"="meditation"]${a};nwr["leisure"="yoga"]${a};nwr["amenity"="meditation_centre"]${a};)->.w;
    .u out center tags 60;
    .w out center tags 120;`);
  const isCampus = e => e.tags && ['university', 'college'].includes(e.tags.amenity);
  const uni = elements.filter(isCampus), well = elements.filter(e => !isCampus(e));
  const universities = dedupe(uni.map(e => toPlace(e, e.tags && e.tags.amenity === 'college' ? 'College' : 'University', 'Student Wellness / Health Promotion office'))
    .sort((x, y) => (x.kind === 'University' ? 0 : 1) - (y.kind === 'University' ? 0 : 1) || richness(y) - richness(x))).slice(0, 12);
  const wellness = dedupe(well.map(e => toPlace(e, (e.tags.sport || '').includes('meditation') || e.tags.amenity === 'meditation_centre' ? 'Meditation centre' : 'Yoga / wellness studio', 'Studio owner or community manager'))
    .sort((x, y) => richness(y) - richness(x))).slice(0, 24);
  if (!universities.length && !wellness.length) throw new Error('no places found');
  return { universities, wellness };
}
function mockPlaces(city) {
  const m = MOCK[city]; if (!m) return { universities: [], wellness: [] };
  const map = (p, kind) => ({ name: p.name, kind: p.kind || kind, address: p.address || '', site: p.site || '', contact: { name: p.contact.name, role: p.contact.role, email: p.contact.email, phone: '' }, source: 'Mock data' });
  return { universities: m.universities.map(p => map(p, 'University')), wellness: m.wellness.map(p => map(p, 'Wellness')) };
}

// ---------- Contact finder (reads a place's public website) ----------
function safeUrl(u) {
  try {
    const x = new URL(u), h = x.hostname;
    if (!/^https?:$/.test(x.protocol) || h === 'localhost' || h.includes(':') || !h.includes('.') || /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return null;
    return x;
  } catch { return null; }
}
async function getPage(u) {
  const x = safeUrl(u); if (!x) return '';
  try { const r = await fetch(x, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(7000) }); return r.ok ? (await r.text()).slice(0, 400000) : ''; } catch { return ''; }
}
const pickEmails = h => [...new Set((h.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(s => s.toLowerCase()))]
  .filter(e => !/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(e) && !/example|sentry|wixpress|domain\.com/.test(e));
async function findContact(site) {
  let html = await getPage(site), emails = pickEmails(html);
  if (!emails.length) {
    const m = html.match(/href=["']([^"']*contact[^"']*)["']/i);
    if (m) { try { html = await getPage(new URL(m[1], site).href); emails = pickEmails(html); } catch { } }
  }
  const phone = (html.match(/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/) || [])[0] || '';
  return { email: emails[0] || '', phone };
}

// ---------- Events ----------
const GEN = [
  ['Student club fairs and frosh week', 9, 3, 'Campus', 'New students looking for stress relief and clubs.'],
  ['Winter-term club fairs', 1, 12, 'Campus', 'Second student intake after the holidays.'],
  ['Exam-stress weeks (fall)', 12, 1, 'Campus', 'Offer free breathing sessions through student wellness.'],
  ['Exam-stress weeks (spring)', 4, 1, 'Campus', 'Pre-exam relaxation sessions.'],
  ['Mental Health Awareness Week', 5, 3, 'Awareness', 'Anxiety and depression workshops with partners.'],
  ['International Day of Yoga', 6, 21, 'Yoga', 'Public yoga gatherings in most cities.'],
  ['World Mental Health Day', 10, 10, 'Awareness', 'Workshops on stress, anxiety and depression.'],
  ['World Meditation Day', 12, 21, 'Meditation', 'Group meditation events.']
];
const pad = n => String(n).padStart(2, '0');
const gq = s => 'https://www.google.com/search?q=' + encodeURIComponent(s);
function genericEvents(city, from, to) {
  const out = [], y0 = +from.slice(0, 4) || new Date().getFullYear(), y1 = +to.slice(0, 4) || y0 + 1;
  for (let y = y0; y <= Math.min(y1, y0 + 2); y++) for (const e of GEN) {
    const d = `${y}-${pad(e[1])}-${pad(e[2])}`;
    if (d >= from && d <= to) out.push({ name: e[0], date: d, type: e[3], why: e[4], url: gq(`${e[0]} ${city} ${y}`), source: 'Recurring calendar' });
  }
  return out;
}
async function ticketmaster(city, from, to) {
  const key = process.env.TICKETMASTER_KEY; if (!key) return [];
  try {
    const u = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${key}&city=${encodeURIComponent(city)}&countryCode=CA&keyword=${encodeURIComponent('wellness yoga mindfulness meditation')}&size=15&startDateTime=${from}T00:00:00Z&endDateTime=${to}T23:59:59Z`;
    const j = await (await fetch(u, { signal: AbortSignal.timeout(10000) })).json();
    return ((j._embedded && j._embedded.events) || []).map(e => ({ name: e.name, date: e.dates.start.localDate, type: 'Live event', why: 'Venue: ' + ((e._embedded && e._embedded.venues && e._embedded.venues[0].name) || 'see link'), url: e.url, source: 'Live · Ticketmaster' }));
  } catch { return []; }
}

function template(l) {
  return `Hi ${l.name}, I'm reaching out from Art of Living in ${l.city || 'your city'}. We run free intro sessions on breathing and meditation that many people find helpful for ${(l.interest || 'wellness').toLowerCase()}. Would you like to join one, or share it with your community?`;
}

const handler = async (req, res) => {
  const u = new URL(req.url, 'http://x'), p = u.pathname, sp = u.searchParams;
  try {
    if (p === '/api/cities') return send(res, 200, Object.keys(COORDS));
    if (p === '/api/outreach') {
      const city = sp.get('city'); if (!COORDS[city]) return send(res, 404, { error: 'unknown city' });
      const from = sp.get('from') || '2000-01-01', to = sp.get('to') || '2100-01-01';
      let places, live = true;
      try { places = await livePlaces(city); }
      catch (e) { console.error('Live lookup failed:', e.message); places = mockPlaces(city); live = false; }
      const mockEv = ((MOCK[city] || {}).events || []).map(e => ({ ...e, url: gq(e.name + ' ' + city), source: 'Mock data' }));
      const events = [...mockEv, ...genericEvents(city, from, to), ...await ticketmaster(city, from, to)]
        .filter(e => e.date >= from && e.date <= to).sort((a, b) => a.date.localeCompare(b.date));
      const tag = city.toLowerCase().replace(/[^a-z]/g, '');
      const influencers = [{ handle: '#yoga' + tag, niche: 'Yoga', url: 'https://www.instagram.com/explore/tags/yoga' + tag + '/' }, { handle: '#mentalhealth' + tag, niche: 'Mental health', url: 'https://www.instagram.com/explore/tags/mentalhealth' + tag + '/' }, { handle: '#meditation' + tag, niche: 'Meditation', url: 'https://www.instagram.com/explore/tags/meditation' + tag + '/' }, ...((MOCK[city] || {}).influencers || [])];
      return send(res, 200, { province: COORDS[city][2], live, ...places, events, influencers });
    }
    if (p === '/api/contact') { const s = sp.get('url'); if (!safeUrl(s)) return send(res, 400, { error: 'bad url' }); return send(res, 200, await findContact(s)); }
    if (p === '/api/leads.csv') {
      const rows = readLeads(), cols = ['name', 'city', 'type', 'role', 'email', 'interest', 'status', 'followUp', 'notes'];
      const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      return send(res, 200, [cols.join(','), ...rows.map(r => cols.map(k => q(r[k])).join(','))].join('\n'), 'text/csv');
    }
    if (p === '/api/leads' && req.method === 'GET') return send(res, 200, readLeads());
    if (p === '/api/leads' && req.method === 'POST') {
      const b = await readBody(req); if (!b.name) return send(res, 400, { error: 'name required' });
      const l = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: b.name, city: b.city || '', type: b.type || 'Person', role: b.role || '', email: b.email || '', interest: b.interest || 'Other', status: 'New', followUp: '', notes: b.notes || '' };
      const all = readLeads(); all.unshift(l); writeLeads(all); return send(res, 201, l);
    }
    const m = p.match(/^\/api\/leads\/(\w+)(\/message)?$/);
    if (m) {
      const all = readLeads(), i = all.findIndex(l => l.id === m[1]);
      if (i < 0) return send(res, 404, { error: 'not found' });
      if (m[2]) return send(res, 200, { message: template(all[i]) });
      if (req.method === 'PATCH') { Object.assign(all[i], await readBody(req), { id: m[1] }); writeLeads(all); return send(res, 200, all[i]); }
      if (req.method === 'DELETE') { all.splice(i, 1); writeLeads(all); return send(res, 200, { ok: true }); }
    }
    const f = path.join(__dirname, 'public', p === '/' ? 'index.html' : p);
    if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
  } catch (e) { console.error(e); send(res, 500, { error: 'server error' }); }
};
module.exports = handler;
if (require.main === module) http.createServer(handler).listen(PORT, () => console.log('Running at http://localhost:' + PORT));
