import { homedir } from 'node:os';
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
  expect(tree.entries.find(entry => entry.id === custom)).toMatchObject({ parent: user, kind: 'custom_message', title: 'test-context', summary: 'Context for navigation' });
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

it('projects Pi tool labels, assistant failures, label times and bookkeeping rows', async () => {
  const manager = SessionManager.inMemory('/fixture');
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const toolCalls = manager.appendMessage({ role: 'assistant', content: [
    { type: 'text', text: 'Reading' },
    { type: 'toolCall', id: 'call-read', name: 'read', arguments: { path: `${homedir()}/project/a.ts`, offset: 2, limit: 3 } },
    { type: 'toolCall', id: 'call-bash', name: 'bash', arguments: { command: `echo one\n${'x'.repeat(60)}` } },
  ], api: 'fixture', provider: 'fixture', model: 'model', usage, stopReason: 'toolUse', timestamp: 2 } as never);
  const read = manager.appendMessage({ role: 'toolResult', toolCallId: 'call-read', toolName: 'read', content: [{ type: 'text', text: 'file body' }], isError: false, timestamp: 3 } as never);
  manager.appendLabelChange(read, 'Checked');
  const bash = manager.appendMessage({ role: 'toolResult', toolCallId: 'call-bash', toolName: 'bash', content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 4 } as never);
  const failed = manager.appendMessage({ role: 'assistant', content: [], api: 'fixture', provider: 'fixture', model: 'model', usage, stopReason: 'error', errorMessage: 'provider failed', timestamp: 5 } as never);
  const shell = manager.appendMessage({ role: 'bashExecution', command: 'ls', output: '', exitCode: 0, cancelled: false, truncated: false, timestamp: 6 } as never);
  const compaction = manager.appendCompaction('Summary text', shell, 37_500);
  manager.appendModelChange('fixture', 'model-b');
  const registry = {
    binding: () => ({ runtime: { session: { sessionManager: manager } } }),
    projection: () => ({ snapshot: () => ({ revision: 1, branch: compaction }) }),
  } as unknown as SessionRegistry;
  const commands = new SessionCommands({ registry, configuration: {} as never, models: { getAvailable: () => [] }, invalidated() {} });
  const response = await commands.read({ v: 1, id: 'request', op: 'session.tree', session: 'session', params: {} });
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Tree request failed');
  const tree = parseOperationResult('session.tree', response.result);
  const byId = (id: string) => tree.entries.find(entry => entry.id === id);
  expect(byId(toolCalls)).toMatchObject({ role: 'assistant', summary: 'Reading', stopReason: 'toolUse' });
  expect(byId(read)).toMatchObject({ role: 'toolResult', title: 'read: ~/project/a.ts:2-4', summary: 'file body', label: 'Checked' });
  expect(byId(read)?.labelTimestamp).toBeGreaterThan(0);
  expect(byId(bash)).toMatchObject({ title: `bash: echo one ${'x'.repeat(41)}...`, summary: 'ok' });
  expect(byId(failed)).toMatchObject({ stopReason: 'error', errorMessage: 'provider failed', summary: '' });
  expect(byId(shell)).toMatchObject({ role: 'bashExecution', summary: 'ls' });
  expect(byId(compaction)).toMatchObject({ kind: 'compaction', title: 'compaction: 38k tokens', summary: 'Summary text' });
  expect(tree.entries.filter(entry => entry.kind === 'model_change')).toEqual([expect.objectContaining({ title: 'model: model-b', summary: '' })]);
});

it('labels every built-in tool call like Pi, bounds long text and keeps multiple roots and cleared labels', async () => {
  const manager = SessionManager.inMemory('/fixture');
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const calls = [
    { id: 'write', name: 'write', arguments: { path: `${homedir()}/out.txt` } },
    { id: 'edit', name: 'edit', arguments: { file_path: '/fixture/a.ts' } },
    { id: 'grep', name: 'grep', arguments: { pattern: 'needle', path: 'src' } },
    { id: 'find', name: 'find', arguments: { pattern: '*.ts' } },
    { id: 'ls', name: 'ls', arguments: {} },
    { id: 'custom', name: 'lookup', arguments: { query: 'x'.repeat(60) } },
    { id: 'missing', name: 'missing', arguments: {} },
  ];
  const assistant = manager.appendMessage({ role: 'assistant', content: calls.map(call => ({ type: 'toolCall', ...call })),
    api: 'fixture', provider: 'fixture', model: 'model', usage, stopReason: 'toolUse', timestamp: 1 } as never);
  const results = calls.filter(call => call.id !== 'missing').map(call => manager.appendMessage({ role: 'toolResult', toolCallId: call.id, toolName: call.name,
    content: [{ type: 'text', text: 'ok' }], isError: false, timestamp: 2 } as never));
  const cancelled = manager.appendMessage({ role: 'assistant', content: [], api: 'fixture', provider: 'fixture', model: 'model', usage, stopReason: 'aborted', timestamp: 3 } as never);
  const longError = manager.appendMessage({ role: 'assistant', content: [], api: 'fixture', provider: 'fixture', model: 'model', usage, stopReason: 'error', errorMessage: 'e'.repeat(20_000), timestamp: 4 } as never);
  const labelled = manager.appendMessage({ role: 'user', content: 'label me', timestamp: 5 });
  manager.appendLabelChange(labelled, 'Keep');
  manager.appendLabelChange(labelled, undefined);
  manager.resetLeaf();
  const second = manager.appendMessage({ role: 'user', content: 'second root', timestamp: 6 });
  const registry = {
    binding: () => ({ runtime: { session: { sessionManager: manager } } }),
    projection: () => ({ snapshot: () => ({ revision: 2, branch: second }) }),
  } as unknown as SessionRegistry;
  const commands = new SessionCommands({ registry, configuration: {} as never, models: { getAvailable: () => [] }, invalidated() {} });
  const response = await commands.read({ v: 1, id: 'request', op: 'session.tree', session: 'session', params: {} });
  expect(response.outcome).toBe('accepted'); if (response.outcome !== 'accepted') throw new Error('Tree request failed');
  const tree = parseOperationResult('session.tree', response.result);
  const titles = results.map(id => tree.entries.find(entry => entry.id === id)?.title);
  expect(titles).toEqual(['write: ~/out.txt', 'edit: /fixture/a.ts', 'grep: /needle/ in src', 'find: *.ts in .', 'ls: .',
    `lookup: ${JSON.stringify({ query: 'x'.repeat(60) }).slice(0, 40)}...`]);
  expect(tree.entries.find(entry => entry.id === assistant)?.title).toBeUndefined();
  expect(tree.entries.find(entry => entry.id === cancelled)).toMatchObject({ stopReason: 'aborted', summary: '' });
  const error = tree.entries.find(entry => entry.id === longError)!;
  expect(error.errorMessage).toHaveLength(16_384);
  expect(tree.entries.find(entry => entry.id === labelled)).not.toHaveProperty('label');
  expect(tree.entries.find(entry => entry.id === labelled)).not.toHaveProperty('labelTimestamp');
  expect(tree.entries.filter(entry => entry.parent === undefined).map(entry => entry.id)).toEqual(expect.arrayContaining([second, assistant]));
});
