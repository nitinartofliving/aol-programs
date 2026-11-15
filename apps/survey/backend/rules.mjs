import {
  attendance, barriers, days, exclusiveBarriers, formats, maxCommentLength, maxNameLength,
  priority, recommendationLabels, surveyVersion, times,
} from './catalog.mjs';

const submissionFields = new Set([
  'surveyVersion', 'submissionId', 'attendance', 'barriers', 'priority',
  'day', 'time', 'format', 'comment', 'name',
]);
const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validChoice = (choices, value) => choices.some(({ id }) => id === value);

export function validateSubmission(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: { form: 'Send a JSON object.' } };
  }
  if (Object.keys(body).some(key => !submissionFields.has(key))) {
    return { errors: { form: 'This form contains an unexpected field.' } };
  }
  if (body.surveyVersion !== surveyVersion) {
    return { versionMismatch: true };
  }

  const errors = {};
  if (typeof body.submissionId !== 'string' || !uuidV4.test(body.submissionId)) {
    errors.form = 'Start a new submission and try again.';
  }
  if (!validChoice(attendance, body.attendance)) {
    errors.attendance = 'Choose one attendance answer.';
  }
  if (!Array.isArray(body.barriers) || body.barriers.length < 1 || body.barriers.length > 2 ||
      new Set(body.barriers).size !== body.barriers.length ||
      !body.barriers.every(value => validChoice(barriers, value))) {
    errors.barriers = 'Choose one or two answers.';
  } else if (body.barriers.length > 1 && body.barriers.some(value => exclusiveBarriers.includes(value))) {
    errors.barriers = 'Choose this answer on its own.';
  }
  if (!validChoice(priority, body.priority)) {
    errors.priority = 'Choose one answer.';
  }
  for (const [field, options] of [['day', days], ['time', times], ['format', formats]]) {
    if (body[field] != null && !validChoice(options, body[field])) {
      errors[field] = 'Choose one of the listed options or clear your selection.';
    }
  }

  // Preserve normal line breaks. Never read free text as a recommendation signal.
  let comment = null;
  if (body.comment != null) {
    if (typeof body.comment !== 'string') {
      errors.comment = 'Enter a short comment or leave the box blank.';
    } else {
      comment = body.comment.replace(/\r\n?/g, '\n').trim() || null;
      if (comment && ([...comment].length > maxCommentLength ||
        /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(comment))) {
        errors.comment = 'Use up to ' + maxCommentLength + ' characters of plain text.';
      }
    }
  }
  // Optional name: one line of plain text, never used for routing or reports.
  let name = null;
  if (body.name != null) {
    if (typeof body.name !== 'string') {
      errors.name = 'Enter your name or leave the box blank.';
    } else {
      name = body.name.replace(/\s+/g, ' ').trim() || null;
      if (name && ([...name].length > maxNameLength || /[\u0000-\u001F\u007F]/u.test(name))) {
        errors.name = 'Use up to ' + maxNameLength + ' characters.';
      }
    }
  }

  if (Object.keys(errors).length > 0) return { errors };

  return {
    submissionId: body.submissionId.toLowerCase(),
    answers: {
      attendance: body.attendance,
      barriers: barriers.filter(({ id }) => body.barriers.includes(id)).map(({ id }) => id),
      priority: body.priority,
      day: body.day ?? null,
      time: body.time ?? null,
      format: body.format ?? null,
      comment,
      name,
    },
  };
}

export function recommend(answers, destinations) {
  const selected = new Set(answers.barriers);
  const any = (...codes) => codes.some(code => selected.has(code));
  const result = (code, rule, href) => ({ code, label: recommendationLabels[code], href, rule });

  // Earlier rules take precedence. The order of taps has no effect.
  if (selected.has('access')) {
    return result('teacher_support', 'access_support', destinations.teacher);
  }
  if (['questions', 'refresher'].includes(answers.priority)) {
    return result('teacher_support', 'learning_support', destinations.teacher);
  }
  if (selected.has('solo')) {
    return result('stay_connected', 'solo_preference', destinations.volunteer);
  }
  if (any('travel', 'venue', 'unclear') || answers.priority === 'shorter') {
    return result('ask_volunteer', 'session_fit', destinations.volunteer);
  }
  if (answers.format === 'online') {
    if (destinations.online) return result('online_options', 'online_preference', destinations.online);
    return result('ask_volunteer', 'online_contact', destinations.volunteer);
  }
  if (any('day', 'time', 'commitments', 'details')) {
    return result('find_sessions', 'session_planning', destinations.followups);
  }
  if (['guided', 'connect'].includes(answers.priority)) {
    return result('group_practice', 'group_interest', destinations.followups);
  }
  if ((answers.day && answers.day !== 'any_day') ||
      (answers.time && answers.time !== 'any_time') || answers.format === 'in_person') {
    return result('find_sessions', 'availability', destinations.followups);
  }
  return result('stay_connected', 'open_invitation', destinations.volunteer);
}
