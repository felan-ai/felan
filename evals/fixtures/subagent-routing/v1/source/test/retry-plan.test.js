import assert from 'node:assert/strict';
import test from 'node:test';
import { planRetries } from '../src/retry-plan.js';
import { retrySchedule } from '../src/retry-schedule.js';

test('starts retries after one base delay and caps later delays', () => {
  assert.deepEqual(retrySchedule(4, 100, 250), [100, 200, 250, 250]);
});

test('returns no retries when attempts are disabled', () => {
  assert.deepEqual(planRetries({ attempts: 0, baseDelayMs: 100, maxDelayMs: 250 }), []);
});

test('preserves validation for invalid attempts', () => {
  assert.throws(() => retrySchedule(-1, 100, 250), /attempts must be a non-negative integer/);
});
