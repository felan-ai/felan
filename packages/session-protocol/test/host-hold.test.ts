import { describe, expect, it } from 'vitest';
import { parseClientEnvelope, parseControlRequest, parseControlResponse, parseOperationResult } from '../src/index.js';
import { identity, requestId, results } from './fixtures.js';

describe('idle hold for host.stop and host.restart', () => {
  it.each(['host.stop', 'host.restart'] as const)('accepts mode hold for %s in envelopes and control requests', op => {
    const params = { expected: identity, mode: 'hold' };
    expect(parseClientEnvelope({ v: 1, id: requestId(), op, params })).toMatchObject({ op, params });
    expect(parseControlRequest({ control: 1, id: requestId(), op, params })).toMatchObject({ op, params });
    for (const mode of ['drain', 'force']) expect(parseControlRequest({ control: 1, id: requestId(), op, params: { expected: identity, mode } }).params).toEqual({ expected: identity, mode });
    expect(() => parseControlRequest({ control: 1, id: requestId(), op, params: { expected: identity, mode: 'pause' } })).toThrow();
  });

  it('reports a hold next to the unchanged state values', () => {
    const held = { action: 'restart', since: 1_000, until: 61_000 };
    const control = { control: 1, re: requestId(), daemonVersion: 'new', supportedProtocol: 1, identity, state: 'draining', held, outcome: 'accepted' };
    expect(parseControlResponse(control)).toEqual(control);
    expect(parseOperationResult('host.restart', { state: 'draining', held })).toEqual({ state: 'draining', held });
    const status = { ...results['host.status'], state: 'draining', held };
    expect(parseOperationResult('host.status', status)).toMatchObject({ state: 'draining', held });
    expect(() => parseControlResponse({ ...control, state: 'held' })).toThrow();
    expect(() => parseControlResponse({ ...control, held: { ...held, action: 'pause' } })).toThrow();
  });

  it('advertises the accepted stop modes in host.status and control responses', () => {
    const stopModes = ['drain', 'force', 'hold'];
    expect(parseOperationResult('host.status', { ...results['host.status'], stopModes })).toMatchObject({ stopModes });
    expect(parseOperationResult('host.status', results['host.status'])).not.toHaveProperty('stopModes');
    const control = { control: 1, re: requestId(), daemonVersion: 'new', supportedProtocol: 1, identity, state: 'ready', stopModes, outcome: 'accepted' };
    expect(parseControlResponse(control)).toEqual(control);
    expect(() => parseControlResponse({ ...control, stopModes: ['drain', 'drain'] })).toThrow();
    expect(() => parseControlResponse({ ...control, stopModes: ['pause'] })).toThrow();
  });

  it('reports work by kind and still reads a status without it', () => {
    const active = { sessions: 1, runs: 0, work: 3, attachments: 0 };
    const workByKind = { sessions: 1, processes: 1, interactions: 0, providers: 1 };
    expect(parseOperationResult('host.status', { ...results['host.status'], active: { ...active, workByKind } }).active).toEqual({ ...active, workByKind });
    expect(parseOperationResult('host.status', { ...results['host.status'], active }).active).toEqual(active);
    expect(() => parseOperationResult('host.status', { ...results['host.status'], active: { ...active, workByKind: { ...workByKind, processes: -1 } } })).toThrow();
  });
});

describe('holding active runs', () => {
  it.each(['host.stop', 'host.restart'] as const)('accepts an optional step limit with mode hold for %s', op => {
    const params = { expected: identity, mode: 'hold', stepTimeoutMs: 180_000 };
    expect(parseClientEnvelope({ v: 1, id: requestId(), op, params })).toMatchObject({ op, params });
    expect(parseControlRequest({ control: 1, id: requestId(), op, params })).toMatchObject({ op, params });
    for (const stepTimeoutMs of [0, 600_001, 1.5]) {
      expect(() => parseControlRequest({ control: 1, id: requestId(), op, params: { ...params, stepTimeoutMs } })).toThrow();
    }
  });

  it('advertises run holding and reports held runs next to the existing hold fields', () => {
    const held = { action: 'restart', since: 1_000, until: 61_000, runs: 2 };
    const control = { control: 1, re: requestId(), daemonVersion: 'new', supportedProtocol: 1, identity, state: 'draining', held,
      stopModes: ['drain', 'force', 'hold'], holdsRuns: true, outcome: 'accepted' };
    expect(parseControlResponse(control)).toEqual(control);
    expect(parseOperationResult('host.status', { ...results['host.status'], state: 'draining', held, holdsRuns: true })).toMatchObject({ held, holdsRuns: true });
    expect(parseOperationResult('host.restart', { state: 'draining', held })).toEqual({ state: 'draining', held });
    expect(() => parseControlResponse({ ...control, holdsRuns: false })).toThrow();
    expect(() => parseControlResponse({ ...control, held: { ...held, runs: -1 } })).toThrow();
  });

  it('keeps reading the 0.4.8 shapes, which lack run holding', () => {
    const control = { control: 1, re: requestId(), daemonVersion: 'old', supportedProtocol: 1, identity, state: 'draining',
      held: { action: 'restart', since: 1_000, until: 61_000 }, stopModes: ['drain', 'force', 'hold'], outcome: 'accepted' };
    expect(parseControlResponse(control)).toEqual(control);
    expect(parseOperationResult('host.status', results['host.status'])).not.toHaveProperty('holdsRuns');
  });

  it('reports a cancelled attempt with its own error code', () => {
    const control = { control: 1, re: requestId(), daemonVersion: 'new', supportedProtocol: 1, identity, state: 'ready', holdsRuns: true, outcome: 'rejected',
      error: { code: 'hold_cancelled', message: 'A run did not reach the end of its step within 180000 ms.', retryable: false } };
    expect(parseControlResponse(control)).toEqual(control);
  });
});
