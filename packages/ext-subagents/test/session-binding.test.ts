import type { AgentSession, SessionManager } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import {
  bindSubagentSession,
  type SubagentCompletionNotice,
  type SubagentHost,
  type SubagentParentPort,
} from '../src/index.js';

describe('subagent session binding', () => {
  it('binds completion delivery to the parent session lifecycle', async () => {
    const harness = sessionHarness();
    let parentPort: SubagentParentPort | undefined;
    const detach = vi.fn();
    const host = hostWithAttachment((port) => {
      parentPort = port;
      return detach;
    });

    bindSubagentSession({ host, session: harness.session });

    const notice = completionNotice('delivery-1');
    await expect(parentPort!.deliverCompletion(notice)).resolves.toBe('queued');
    await settle();
    harness.emit({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'felan-subagent-completion',
        details: { notice },
      },
    });
    harness.persistedEntries.push({
      type: 'custom_message',
      customType: 'felan-subagent-completion',
      details: { notice },
    });
    await settle();
    await expect(parentPort!.deliverCompletion(notice)).resolves.toBe('delivered');
    expect(harness.sendCustomMessage).toHaveBeenCalledOnce();
    expect(harness.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'felan-subagent-completion' }),
      { triggerTurn: true, deliverAs: 'steer' },
    );

    harness.session.dispose();
    harness.session.dispose();
    await expect(parentPort!.deliverCompletion(notice)).resolves.toBe('unavailable');
    expect(detach).toHaveBeenCalledOnce();
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it('keeps streaming delivery queued until the current turn boundary', async () => {
    const harness = sessionHarness(true);
    let parentPort: SubagentParentPort | undefined;
    bindSubagentSession({
      host: hostWithAttachment((port) => {
        parentPort = port;
        return () => {};
      }),
      session: harness.session,
    });
    const notice = completionNotice('delivery-queued');

    await expect(parentPort!.deliverCompletion(notice)).resolves.toBe('queued');
    await expect(parentPort!.deliverCompletion(notice)).resolves.toBe('queued');
    harness.session.clearQueue();
    (harness.session as any).isStreaming = false;
    harness.emit({ type: 'agent_settled' });
    await settle();
    expect(harness.sendCustomMessage).toHaveBeenCalledOnce();
    await expect(parentPort!.deliverCompletion(notice)).resolves.toBe('queued');
    expect(harness.sendCustomMessage).toHaveBeenCalledOnce();
  });

  it('batches completions that arrive before the parent becomes idle', async () => {
    const harness = sessionHarness(true);
    let parentPort: SubagentParentPort | undefined;
    bindSubagentSession({
      host: hostWithAttachment((port) => {
        parentPort = port;
        return () => {};
      }),
      session: harness.session,
    });
    const first = completionNotice('delivery-batch-1');
    const second = completionNotice('delivery-batch-2');

    await expect(parentPort!.deliverCompletion(first)).resolves.toBe('queued');
    await expect(parentPort!.deliverCompletion(second)).resolves.toBe('queued');
    (harness.session as any).isStreaming = false;
    harness.emit({ type: 'turn_end' });
    await settle();

    expect(harness.sendCustomMessage).toHaveBeenCalledOnce();
    expect(harness.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Subagent completions:'),
        details: { notices: [first, second] },
      }),
      { triggerTurn: true, deliverAs: 'steer' },
    );
  });

  it('acknowledges persisted completion delivery', async () => {
    const notice = completionNotice('delivery-persisted');
    const harness = sessionHarness(false, [{
      type: 'custom_message',
      customType: 'felan-subagent-completion',
      details: { notice },
    }]);
    let parentPort: SubagentParentPort | undefined;
    bindSubagentSession({
      host: hostWithAttachment((port) => {
        parentPort = port;
        return () => {};
      }),
      session: harness.session,
    });

    await expect(parentPort!.deliverCompletion(notice)).resolves.toBe('delivered');
    expect(harness.sendCustomMessage).not.toHaveBeenCalled();
  });

  it('closes the parent port and disposes a session when attachment fails', async () => {
    const harness = sessionHarness();
    let parentPort: SubagentParentPort | undefined;
    const host = hostWithAttachment((port) => {
      parentPort = port;
      throw new Error('attachment failed');
    });

    expect(() => bindSubagentSession({
      host,
      session: harness.session,
    })).toThrow('attachment failed');
    await expect(parentPort!.deliverCompletion(completionNotice('delivery-failed'))).resolves.toBe('unavailable');
    expect(harness.dispose).toHaveBeenCalledOnce();
  });
});

function sessionHarness(initialStreaming = false, persistedEntries: unknown[] = []) {
  let streaming = initialStreaming;
  let listener: ((event: any) => void) | undefined;
  const dispose = vi.fn();
  const sendCustomMessage = vi.fn(async () => undefined);
  const clearQueue = vi.fn(() => undefined);
  const session = {
    sessionManager: contextManager(persistedEntries),
    get isStreaming() {
      return streaming;
    },
    set isStreaming(value: boolean) {
      streaming = value;
    },
    clearQueue,
    subscribe: vi.fn((next: (event: any) => void) => {
      listener = next;
      return vi.fn();
    }),
    sendCustomMessage,
    dispose,
  } as unknown as AgentSession;
  return {
    session,
    dispose,
    sendCustomMessage,
    persistedEntries,
    emit: (event: any) => listener?.(event),
  };
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function contextManager(persistedEntries: unknown[] = []): SessionManager {
  return {
    getEntries: () => persistedEntries,
  } as unknown as SessionManager;
}

function hostWithAttachment(
  attachParent: SubagentHost['attachParent'],
): SubagentHost {
  const unavailable = async () => ({
    ok: false as const,
    error: { code: 'host_unavailable' as const, message: 'not used' },
  });
  return {
    descriptors: [{ id: 'general', description: 'General', allowNesting: true }],
    policy: {
      maxPromptBytes: 1,
      maxDescriptionBytes: 1,
      maxSteerBytes: 1,
    },
    attachParent,
    spawn: unavailable,
    list: unavailable,
    getResult: unavailable,
    steer: unavailable,
    cancel: unavailable,
  };
}

function completionNotice(deliveryId: string): SubagentCompletionNotice {
  return {
    deliveryId,
    parentSessionId: 'parent',
    agentId: 'child',
    type: 'general',
    status: 'completed',
    summary: 'done',
  };
}
