import {
  attendance, barriers, days, formats, priority, recommendationLabels, surveyVersion, times, timeZone,
} from './catalog.mjs';
import { DAY_MS } from './store.mjs';

const minimumBase = 5;
const minimumSignal = 3;
const windowDays = 30;
const recent = new Set(['once', 'two_plus']);
const hasBarrier = ({ answers }, ...codes) => codes.some(code => answers.barriers.includes(code));
const barriersAnswered = rows => rows.filter(row => !hasBarrier(row, 'skip'));
const share = (count, base) => Math.round((1000 * count) / base) / 10;

const specificDays = days.filter(option => option.id !== 'any_day');
const specificTimes = times.filter(option => option.id !== 'any_time');
const schedulePairs = specificDays.flatMap(day => specificTimes.map(time => ({
  id: day.id + '/' + time.id,
  label: day.label + ' / ' + time.label,
})));
const recommendationOptions = Object.entries(recommendationLabels).map(([id, label]) => ({ id, label }));

function distribution(rows, options, selected) {
  if (rows.length < minimumBase) {
    return { status: 'small_sample', denominator: null, options: [] };
  }
  const counts = Object.fromEntries(options.map(({ id }) => [id, 0]));
  for (const row of rows) {
    for (const id of selected(row)) {
      if (Object.hasOwn(counts, id)) counts[id] += 1;
    }
  }
  return {
    status: 'ready',
    denominator: rows.length,
    options: options.map(({ id, label }) => ({
      id, label, count: counts[id], percent: share(counts[id], rows.length),
    })).sort((a, b) => b.count - a.count),
  };
}

function summarize(rows, isManager) {
  if (rows.length < minimumBase) return { status: 'small_sample', total: null };
  const optionBarriers = barriers.filter(({ id }) => id !== 'skip' && (isManager || id !== 'access'));
  const single = (field, choices) => distribution(
    rows.filter(({ answers }) => answers[field] !== null), choices, ({ answers }) => [answers[field]]
  );
  const paired = rows.filter(({ answers }) =>
    specificDays.some(({ id }) => id === answers.day) && specificTimes.some(({ id }) => id === answers.time)
  );
  return {
    status: 'ready',
    total: rows.length,
    attendance: single('attendance', attendance),
    barriers: distribution(barriersAnswered(rows), optionBarriers, ({ answers }) => answers.barriers),
    priority: single('priority', priority),
    days: single('day', days),
    times: single('time', times),
    schedulePairs: distribution(paired, schedulePairs, ({ answers }) => [answers.day + '/' + answers.time]),
    format: single('format', formats),
    recommendations: distribution(rows, recommendationOptions, row => [row.recommendationCode]),
  };
}

const barrierActions = [
  ['schedule', 'Try a second time slot', 'Use the day and time preferences to pilot one additional slot.', ['day', 'time', 'commitments']],
  ['travel', 'Make travel easier', 'Share parking and transit details. Compare locations or an online option the team can support.', ['travel']],
  ['venue', 'Review the venue', 'Check room setup and arrival instructions. Ask for venue feedback after a session.', ['venue']],
  ['details', 'Share session details', 'Post one reliable listing with local time, location or join instructions. Try reminders in an existing opted-in channel.', ['details']],
  ['orientation', 'Set clear expectations', 'Share a short note on who can join, the session length and what happens during the session.', ['unclear']],
  ['solo', 'Offer flexible support', 'Keep a teacher or volunteer contact available and make group attendance an invitation.', ['solo']],
];

const priorityActions = [
  ['guided', 'Plan guided practice', 'Ask an AOL teacher to lead a follow-up that keeps group practice central.'],
  ['refresher', 'Plan a refresher', 'Ask an AOL teacher to add a short refresher within the follow-up.'],
  ['questions', 'Add teacher questions', 'Set aside time for questions with an AOL teacher.'],
  ['connect', 'Leave time to connect', 'Offer a few optional minutes after practice for graduates to meet.'],
  ['shorter', 'Pilot a shorter format', 'Ask the AOL teacher which approved session format could fit a shorter time window.'],
];

function rankedActions(rows, definitions, cohort, matches, max) {
  if (rows.length < minimumBase) return [];
  return definitions.map(([id, title, nextStep, identifiers]) => {
    const count = rows.filter(row => matches(row, identifiers ?? id)).length;
    return { id, title, nextStep, cohort, count, denominator: rows.length, percent: share(count, rows.length) };
  }).filter(action => action.count >= minimumSignal)
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

function summarizeWindow(rows, from, to, isManager) {
  return {
    fromInclusive: from,
    toExclusive: to,
    all: summarize(rows, isManager),
    noRecent: summarize(rows.filter(({ answers }) => !recent.has(answers.attendance)), isManager),
    recent: summarize(rows.filter(({ answers }) => recent.has(answers.attendance)), isManager),
  };
}

export function buildReport(store, now, isManager, retentionDays) {
  const fromPrior = new Date(now + 1 - 2 * windowDays * DAY_MS).toISOString();
  const fromCurrent = new Date(now + 1 - windowDays * DAY_MS).toISOString();
  const end = new Date(now + 1).toISOString();
  const rows = store.reportRows(fromPrior, end);
  const current = rows.filter(row => row.createdAt >= fromCurrent);
  const prior = rows.filter(row => row.createdAt < fromCurrent);
  const noRecent = current.filter(({ answers }) => !recent.has(answers.attendance));
  return {
    surveyVersion,
    timeZone,
    windowDays,
    minimumBase,
    minimumSignal,
    retentionDays,
    current: summarizeWindow(current, fromCurrent, end, isManager),
    prior: summarizeWindow(prior, fromPrior, fromCurrent, isManager),
    volunteerActions: [
      ...rankedActions(barriersAnswered(noRecent), barrierActions, 'noRecentBarriers',
        (row, codes) => hasBarrier(row, ...codes), 2),
      ...rankedActions(current, priorityActions, 'allPriorities', (row, id) => row.answers.priority === id, 1),
      ...rankedActions(current.filter(({ answers }) => answers.format !== null), [
        ['online', 'Check online options', 'Confirm an approved online session. Share the join details once it is available.'],
      ], 'allFormatAnswers', (row, id) => row.answers.format === id, 1),
    ],
  };
}
