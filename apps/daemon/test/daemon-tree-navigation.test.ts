import { expect, it } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { parseOperationResult } from '@felan-ai/session-protocol';
import { SessionCommands } from '../src/daemon/commands.js';
import type { SessionRegistry } from '../src/daemon/registry.js';

it('projects tree roles, parents, labels, leaf and readable custom/compaction summaries', async () => {
  const manager = SessionManager.inMemory('/fixture');
  manager.appendModelChange('fixture', 'model');
  const user = manager.appendMessage({ role: 'user', content: 'Hello tree', timestamp: 1 });
  const custom = manager.appendCustomMessageEntry('test-context', [{ type: 'text', text: 'Context for navigation' }], true);
  manager.appendLabelChange(user, 'Start');
  const compaction = manager.appendCompaction('Retained conversation summary', user, 100);
  const registry = {
    binding: () => ({ runtime: { session: { sessionManager: manager } } }),
    projection: () => ({ snapshot: () => ({ revision: 7, branch: compaction }) }),
  } as unknown as SessionRegistry;
  const commands = new SessionCommands({ registry, configuration: {} as never, models: { getAvailable: () => [] }, invalidated() {} });
  const response = await commands.read({ v: 1, id: 'request', op: 'session.tree', session: 'session', params: {} });
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Tree request failed');
  const tree = parseOperationResult('session.tree', response.result);
  expect(tree).toMatchObject({ branch: compaction, revision: 7 });
  expect(tree.entries.find(entry => entry.id === user)).toMatchObject({ role: 'user', label: 'Start', summary: 'Hello tree' });
  expect(tree.entries.find(entry => entry.id === custom)).toMatchObject({ parent: user, kind: 'custom_message', summary: '[test-context]: Context for navigation' });
  expect(tree.entries.find(entry => entry.id === compaction)?.summary).toBe('Retained conversation summary');
});

it('bounds custom text previews without serializing custom state or image payloads', async () => {
  const manager = SessionManager.inMemory('/fixture');
  manager.appendCustomEntry('private-state', { secret: 'never include custom state' });
  manager.appendCustomMessageEntry('context', [
    { type: 'text', text: 'x'.repeat(40_000) }, { type: 'image', mimeType: 'image/png', data: 'private-image-data' },
  ], true);
  const registry = {
    binding: () => ({ runtime: { session: { sessionManager: manager } } }),
    projection: () => ({ snapshot: () => ({ revision: 1, branch: manager.getLeafId() }) }),
  } as unknown as SessionRegistry;
  const commands = new SessionCommands({ registry, configuration: {} as never, models: { getAvailable: () => [] }, invalidated() {} });
  const response = await commands.read({ v: 1, id: 'request', op: 'session.tree', session: 'session', params: {} });
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Tree request failed');
  const tree = parseOperationResult('session.tree', response.result);
  expect(Buffer.byteLength(tree.entries.at(-1)!.summary)).toBeLessThanOrEqual(16_384);
  expect(JSON.stringify(tree)).not.toMatch(/never include|private-image-data/u);
});
