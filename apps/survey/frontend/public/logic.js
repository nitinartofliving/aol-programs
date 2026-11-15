// Pure form logic shared by the browser (app.js) and the Node tests.
// No DOM access here.

/** Count characters the same way the API does: code points after CRLF→LF and trim. */
export function commentLength(value) {
  return [...String(value ?? '').replace(/\r\n?/g, '\n').trim()].length;
}

/**
 * Apply one Q2 checkbox tap.
 * - An exclusive answer (none / skip) clears everything else.
 * - An ordinary answer clears any exclusive answer.
 * - A third ordinary answer is refused and reports the limit.
 * Returns { selected, limitReached }.
 */
export function toggleBarrier(current, id, checked, { exclusive = [], max = 2 } = {}) {
  let selected = current.filter(value => value !== id);
  if (!checked) return { selected, limitReached: false };
  if (exclusive.includes(id)) return { selected: [id], limitReached: false };
  selected = selected.filter(value => !exclusive.includes(value));
  if (selected.length >= max) return { selected, limitReached: true };
  return { selected: [...selected, id], limitReached: false };
}

/** Build the POST body fields (without surveyVersion / submissionId). */
export function answersPayload(state) {
  const comment = String(state.comment ?? '').replace(/\r\n?/g, '\n').trim();
  const name = String(state.name ?? '').replace(/\s+/g, ' ').trim();
  return {
    attendance: state.attendance ?? null,
    barriers: [...(state.barriers ?? [])],
    priority: state.priority ?? null,
    day: state.day ?? null,
    time: state.time ?? null,
    format: state.format ?? null,
    comment: comment === '' ? null : comment,
    name: name === '' ? null : name,
  };
}

/** Client-side checks that mirror the server. Returns a fields map (empty when valid). */
export function validateAnswers(answers, { maxComment = 240, maxName = 80, exclusive = [] } = {}) {
  const fields = {};
  if (!answers.attendance) fields.attendance = 'Choose one attendance answer.';
  if (answers.barriers.length < 1 || answers.barriers.length > 2) {
    fields.barriers = 'Choose one or two answers.';
  } else if (answers.barriers.length > 1 && answers.barriers.some(id => exclusive.includes(id))) {
    fields.barriers = 'Choose this answer on its own.';
  }
  if (!answers.priority) fields.priority = 'Choose one answer.';
  if (answers.comment && commentLength(answers.comment) > maxComment) {
    fields.comment = 'Use up to ' + maxComment + ' characters of plain text.';
  }
  if (answers.name && [...answers.name].length > maxName) {
    fields.name = 'Use up to ' + maxName + ' characters.';
  }
  return fields;
}

/** Stable key used to decide whether a retry can reuse the same submissionId. */
export function payloadKey(surveyVersion, answers) {
  return JSON.stringify([surveyVersion, answers]);
}

/** Retry-After header in milliseconds, capped so a phone never waits too long. */
export function retryDelay(header, fallbackMs = 2000, capMs = 30000) {
  const seconds = Number(header);
  if (header != null && header !== '' && Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, capMs);
  }
  return fallbackMs;
}

export const retryableStatus = status => status === 429 || status === 502 || status === 503 || status === 504 || status === 500;
