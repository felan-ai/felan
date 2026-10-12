import { expect, it } from 'vitest';
import { SessionManager } from '@felan-ai/agent-core';
import { restoreSessionCursor, sessionTip } from '../src/daemon/session-cursor.js';

function entry(manager: SessionManager, text: string): string {
  return manager.appendMessage({ role: 'user', content: text, timestamp: 0 });
}

it('preserves an explicitly selected older branch when no new Pi entries were appended', () => {
  const manager = SessionManager.inMemory(); const first = entry(manager, 'first'); const second = entry(manager, 'second');
  restoreSessionCursor(manager, { branch: first, observedTip: second });
  expect(manager.getLeafId()).toBe(first); expect(sessionTip(manager)).toBe(second);
});

it('recovers Pi-durable descendants written after the last control checkpoint', () => {
  const manager = SessionManager.inMemory(); const first = entry(manager, 'first');
  const cursor = { branch: first, observedTip: sessionTip(manager) };
  const second = entry(manager, 'second');
  restoreSessionCursor(manager, cursor);
  expect(manager.getLeafId()).toBe(second); expect(manager.getBranch().map(item => item.id)).toEqual([first, second]);
});

it('recovers appended work on an older selected branch without adopting its former sibling', () => {
  const manager = SessionManager.inMemory(); const first = entry(manager, 'first'); const sibling = entry(manager, 'sibling');
  manager.branch(first); const next = entry(manager, 'new branch');
  restoreSessionCursor(manager, { branch: first, observedTip: sibling });
  expect(manager.getLeafId()).toBe(next); expect(manager.getBranch().map(item => item.id)).toEqual([first, next]);
});

it('supports a checkpoint before the first entry and retains legacy selection conservatively', () => {
  const manager = SessionManager.inMemory(); const empty = { branch: manager.getSessionId(), observedTip: sessionTip(manager) };
  restoreSessionCursor(manager, empty); expect(manager.getLeafId()).toBeNull();
  const first = entry(manager, 'first'); restoreSessionCursor(manager, empty); expect(manager.getLeafId()).toBe(first);
  entry(manager, 'later'); restoreSessionCursor(manager, { branch: first }); expect(manager.getLeafId()).toBe(first);
});

it('refuses missing checkpoints and an unobserved chain inconsistent with the selected branch', () => {
  const manager = SessionManager.inMemory(); const first = entry(manager, 'first'); const second = entry(manager, 'second');
  const latest = entry(manager, 'latest');
  expect(() => restoreSessionCursor(manager, { branch: first, observedTip: 'missing' })).toThrow('observed transcript tip');
  expect(() => restoreSessionCursor(manager, { branch: first, observedTip: second })).toThrow('do not extend');
  expect(() => restoreSessionCursor(manager, { branch: 'missing', observedTip: latest })).toThrow('active branch');
  expect(manager.getLeafId()).toBe(latest);
});
