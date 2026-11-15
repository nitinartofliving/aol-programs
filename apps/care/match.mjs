// SevaAssist matching, ported from the Python prototype:
// exact match on the approved question or an alternative wins; otherwise the
// best similarity score (Python's SequenceMatcher.ratio) must reach 0.80.
// A question about volunteers never matches an answer about teachers, and
// the other way round.

export const THRESHOLD = 0.8;

// Ratcliff/Obershelp similarity, the same measure as difflib.SequenceMatcher.ratio().
export function similarity(a, b) {
  if (!a.length && !b.length) return 1;
  return (2 * matches(a, b)) / (a.length + b.length);
}

function matches(a, b) {
  let total = 0;
  const stack = [[0, a.length, 0, b.length]];
  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop();
    let bestI = alo, bestJ = blo, bestK = 0;
    let prev = new Map();
    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      for (let j = blo; j < bhi; j++) {
        if (a[i] !== b[j]) continue;
        const k = (prev.get(j - 1) || 0) + 1;
        next.set(j, k);
        if (k > bestK) { bestI = i - k + 1; bestJ = j - k + 1; bestK = k; }
      }
      prev = next;
    }
    if (!bestK) continue;
    total += bestK;
    stack.push([alo, bestI, blo, bestJ], [bestI + bestK, ahi, bestJ + bestK, bhi]);
  }
  return total;
}

export function subject(text) {
  const words = text.toLowerCase().split(/\s+/).map(w => w.replace(/^[?.!,]+|[?.!,]+$/g, ''));
  if (words.some(w => w === 'volunteer' || w === 'volunteers')) return 'volunteer';
  if (words.some(w => w === 'teacher' || w === 'teachers')) return 'teacher';
  return null;
}

export function findAnswer(question, entries) {
  const q = question.trim().toLowerCase();
  const qSubject = subject(q);
  let best = null, bestScore = 0;
  for (const entry of entries) {
    for (const approved of [entry.question, ...(entry.alternatives || [])]) {
      const a = approved.toLowerCase();
      const aSubject = subject(a);
      if (qSubject !== aSubject && (qSubject || aSubject)) continue;
      if (q === a) return { found: true, entry, score: 1 };
      const score = similarity(q, a);
      if (score > bestScore) { bestScore = score; best = entry; }
    }
  }
  if (best && bestScore >= THRESHOLD) return { found: true, entry: best, score: bestScore };
  return { found: false, entry: null, score: bestScore };
}
