import { expect, it } from 'vitest';
import type { BackgroundBashJob } from '../src/job-store.js';
import { PROCESS_VIEW_BYTES, PROCESS_VIEW_PAGE_SIZE, clipProcessText, parseProcessViewAction,
  parseProcessViewRequest, processViewAction, processViewJob, splitProcessLog, type ProcessViewRequest } from '../src/view.js';

function request(): ProcessViewRequest {
  return { viewId: 'view', sequence: 1, offset: 0, total: 1, running: 1, selectedId: 'job-1',
    jobs: [{ id: 'job-1', command: 'echo test', commandTruncated: false, status: 'running', startedAt: 1, updatedAt: 1 }] };
}

it('projects only display data, with a JSON-byte-bounded command preview', () => {
  const projected = processViewJob({ meta: { id: 'job-1', command: '\u0000'.repeat(2000), startedAt: 1, pid: 999, processToken: 'not-transported', cwd: '/private' },
    status: { status: 'running', updatedAt: 1 } } as BackgroundBashJob);
  expect(projected.commandTruncated).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(projected.command)).length).toBeLessThanOrEqual(512);
  expect(projected).not.toHaveProperty('pid'); expect(projected).not.toHaveProperty('cwd'); expect(projected).not.toHaveProperty('processToken');
  expect(parseProcessViewRequest({ ...request(), jobs: [projected] })).toMatchObject({ jobs: [projected] });
});

it.each([
  { name: 'ASCII', text: 'x'.repeat(128 * 1024) }, { name: 'escaped controls', text: '\u0000'.repeat(128 * 1024) },
  { name: 'Unicode', text: '💚'.repeat(32768) }, { name: 'JSON escapes', text: '\\"\n'.repeat(20000) },
])('chunks $name without splitting Unicode', ({ text }) => {
  const chunks = splitProcessLog(text);
  expect(chunks.join('')).toBe(text); expect(chunks.length).toBeLessThanOrEqual(64);
  for (let index = 0; index < chunks.length; index++) {
    const state = parseProcessViewRequest({ ...request(), detail: { id: 'job-1', index, chunks: chunks.length, text: chunks[index] } });
    expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeLessThan(PROCESS_VIEW_BYTES);
  }
});

it('keeps only the last bounded tail and preserves well-formed text', () => {
  const text = splitProcessLog('💚'.repeat(100000)).join('');
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(128 * 1024);
  expect(text).not.toContain('\uFFFD'); expect(text).toBe('💚'.repeat(32768));
  expect(clipProcessText('\uD800test', 30)).toBe('\uFFFDtest');
});

it('accepts a worst-case full page below the structured-data limit', () => {
  const jobs = Array.from({ length: PROCESS_VIEW_PAGE_SIZE }, (_, i) => ({ ...request().jobs[0]!, id: `${i}`.padEnd(128, 'a'), command: clipProcessText('\u0000'.repeat(3000), 512) }));
  const state = parseProcessViewRequest({ ...request(), selectedId: jobs[0]!.id, jobs, total: jobs.length, running: jobs.length,
    notice: clipProcessText('\u0000'.repeat(3000), 512), detail: { id: jobs[0]!.id, index: 0, chunks: 1, text: splitProcessLog('\u0000'.repeat(3000))[0]! } });
  expect(new TextEncoder().encode(JSON.stringify(state)).length).toBeLessThan(PROCESS_VIEW_BYTES);
});

it.each([
  { offset: -1 }, { offset: 1 }, { total: 0 }, { running: 2 }, { running: 0 }, { sequence: 0 }, { pid: 1 },
  { selectedId: 'missing' }, { jobs: [{ ...request().jobs[0], command: '\uD800' }] },
  { detail: { id: 'missing', index: 0, chunks: 1, text: '' } },
])('rejects an invalid or inconsistent page: %j', change => {
  expect(() => parseProcessViewRequest({ ...request(), ...change })).toThrow('Invalid process view data');
});

it('binds actions to the exact view, generation and visible job', () => {
  const state = request(); const action = processViewAction(state, { action: 'signal', id: 'job-1', signal: 'SIGTERM' });
  expect(parseProcessViewAction(action, state)).toEqual(action);
  for (const changed of [{ viewId: 'other' }, { sequence: 2 }, { id: 'outside' }, { signal: 'SIGSTOP' }, { pid: 5 }]) {
    expect(() => parseProcessViewAction({ ...action, ...changed }, state)).toThrow();
  }
  expect(() => processViewAction(state, { action: 'output', index: 0 })).toThrow();
  expect(() => processViewAction(state, { action: 'page', offset: 18, select: 'first' })).toThrow();
});
