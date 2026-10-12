import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionManager, type ExtensionContext } from '@felan-ai/agent-core';
import { MEMORY_VIEW_PRESENTER, decodeMemoryDocument, parseMemoryViewChunk, parseMemoryViewRequest, type MemoryViewChoice } from '@felan-ai/ext-memory/view';
import { createBrokerMemoryHost } from '../src/daemon/memory-view.js';
import type { BrokerOutcome } from '../src/daemon/broker.js';
import type { Presentation } from '@felan-ai/session-protocol';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('keeps large retained data out of interaction history while navigating existing read-only runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'memory-view-')); roots.push(root);
  const sessionDir = join(root, 'sessions'); const manager = SessionManager.create(root, join(sessionDir, 'memory'));
  manager.appendMessage({ role: 'user', content: 'Retained request', timestamp: Date.now() });
  manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'Retained response '.repeat(20000) }],
    api: 'openai-responses', provider: 'fixture', model: 'fixture', stopReason: 'stop', timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  let page: Presentation | undefined; let count = 0; let inspected = false; let snapshotSeen = false; let parts: string[] = [];
  const host = createBrokerMemoryHost({ signal: new AbortController().signal, canOpen: () => true,
    present(value) { if ('remove' in value) page = undefined; else page = value; },
    async request(value): Promise<BrokerOutcome> {
      expect(JSON.stringify(value).length).toBeLessThan(1024);
      if (value.kind !== 'custom' || page?.kind !== 'custom') throw new Error();
      const request = parseMemoryViewRequest(value.data); const chunk = parseMemoryViewChunk(page.data);
      expect(chunk.documentId).toBe(request.documentId); expect(chunk.index).toBe(request.index); count++;
      if (request.index === 0) parts = []; parts.push(chunk.text);
      let action: MemoryViewChoice;
      if (request.index < request.chunks - 1) action = { action: 'chunk', index: request.index + 1 };
      else {
        const document = decodeMemoryDocument(parts.join(''), request.kind);
        if (document.kind === 'snapshot') {
          expect(JSON.stringify(document.messages)).toContain('Retained response'); snapshotSeen = true; action = { action: 'back' };
        } else if (!inspected) { inspected = true; action = { action: 'inspect', key: document.sessions[0]!.key }; }
        else action = { action: 'close' };
      }
      return { state: 'answered', answer: { kind: 'custom', presenter: MEMORY_VIEW_PRESENTER,
        data: { ...action, viewId: request.viewId, sequence: request.sequence } } };
    }, unsupported() { throw new Error('unsupported'); },
  });
  await host.showHistory({ cwd: root, sessionManager: { getSessionDir: () => sessionDir }, ui: { notify: vi.fn() } } as unknown as ExtensionContext,
    join(root, 'agent'), 'Memory ready', new AbortController().signal);
  expect(count).toBeGreaterThan(10); expect(snapshotSeen).toBe(true); expect(page).toBeUndefined();
});

it('requires a present local TUI before opening a canonical directory', async () => {
  const opener = vi.fn(async (_directory: string) => {}); let allowed = false;
  const host = createBrokerMemoryHost({ signal: new AbortController().signal, canOpen: () => allowed,
    present() {}, request: vi.fn(), openDirectory: opener, unsupported() { throw new Error('unsupported'); } });
  await expect(host.openDirectory('/fixture', new AbortController().signal)).rejects.toThrow('unsupported');
  expect(opener).not.toHaveBeenCalled(); allowed = true;
  await host.openDirectory('/fixture', new AbortController().signal);
  expect(opener).toHaveBeenCalledOnce(); expect(opener).toHaveBeenCalledWith('/fixture');
});
