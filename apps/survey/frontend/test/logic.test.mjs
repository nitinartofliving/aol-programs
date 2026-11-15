import assert from 'node:assert/strict';
import test from 'node:test';
import {
  answersPayload, commentLength, payloadKey, retryDelay, toggleBarrier, validateAnswers,
} from '../public/logic.js';

const rules = { exclusive: ['none', 'skip'], max: 2 };

test('Q2: exclusive answers clear others and ordinary answers clear exclusives', () => {
  assert.deepEqual(toggleBarrier(['day', 'time'], 'none', true, rules).selected, ['none']);
  assert.deepEqual(toggleBarrier(['none'], 'day', true, rules).selected, ['day']);
  assert.deepEqual(toggleBarrier(['skip'], 'none', true, rules).selected, ['none']);
});

test('Q2: a third ordinary answer is refused, existing picks stay editable', () => {
  const third = toggleBarrier(['day', 'time'], 'travel', true, rules);
  assert.deepEqual(third, { selected: ['day', 'time'], limitReached: true });
  const untick = toggleBarrier(['day', 'time'], 'day', false, rules);
  assert.deepEqual(untick, { selected: ['time'], limitReached: false });
  assert.deepEqual(toggleBarrier(untick.selected, 'travel', true, rules).selected, ['time', 'travel']);
});

test('payload trims comments, sends blanks as null and keeps optional fields null', () => {
  const payload = answersPayload({ attendance: 'never', barriers: ['other'], priority: 'guided', comment: '   \r\n ' });
  assert.deepEqual(payload, {
    attendance: 'never', barriers: ['other'], priority: 'guided', day: null, time: null, format: null, comment: null, name: null,
  });
  assert.equal(answersPayload({ name: '  Priya \n S ' }).name, 'Priya S');
});

test('comment length counts code points like the server', () => {
  assert.equal(commentLength('🙂'.repeat(240)), 240);
  assert.equal(commentLength('  a\r\nb  '), 3);
  const fields = validateAnswers(answersPayload({ attendance: 'never', barriers: ['none'], priority: 'guided', comment: 'x'.repeat(241) }));
  assert.ok(fields.comment);
});

test('required questions are validated before sending', () => {
  const fields = validateAnswers(answersPayload({ barriers: [] }), rules);
  assert.deepEqual(Object.keys(fields).sort(), ['attendance', 'barriers', 'priority']);
});

test('identical answers keep the same retry key, a change makes a new one', () => {
  const a = answersPayload({ attendance: 'never', barriers: ['none'], priority: 'guided' });
  const b = answersPayload({ attendance: 'never', barriers: ['none'], priority: 'connect' });
  assert.equal(payloadKey('v1', a), payloadKey('v1', { ...a }));
  assert.notEqual(payloadKey('v1', a), payloadKey('v1', b));
});

test('Retry-After is honoured and capped', () => {
  assert.equal(retryDelay('3'), 3000);
  assert.equal(retryDelay(null, 1500), 1500);
  assert.equal(retryDelay('600'), 30000);
});
