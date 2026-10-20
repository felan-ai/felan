import type { AgentSession, SessionManager } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { bindExecutionSession } from '../../src/providers/execution-binding.js';
import type { ExecutionCompletionNotice, ExecutionParentPort, SessionExecutionPort } from '@felan-ai/daemon/provider';

describe('subagent session binding', () => {
  it('binds completion delivery to the parent session lifecycle', async () => {
    const harness = sessionHarness();
    let parentPort: ExecutionParentPort | undefined;
    const detach = vi.fn();
    const host = hostWithAttachment((port) => {
      parentPort = port;
      return detach;
    });

    bindExecutionSession({ port: host, session: harness.session });

    const notice = completionNotice('delivery-1');
    await expect(parentPort!.deliverCompletion(notice)).resolves.toBe('queued');
    await settle();
    harness.emit({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'felan-execution-completion',
        details: { notice },
      },
    });
    harness.persistedEntries.push({
      type: 'custom_message',
      customType: 'felan-execution-completion',
      details: { notice },
    });
    await settle();
    await expect(parentPort!.deliverCompletion(notice)).resolves.toBe('delivered');
    expect(harness.sendCustomMessage).toHaveBeenCalledOnce();
    expect(harness.sendCustomMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: 'felan-execution-completion' }),
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
    let parentPort: ExecutionParentPort | undefined;
    bindExecutionSession({
      port: hostWithAttachment((port) => {
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
    harness.emit({ type: 'agent_settled', aborted: true });
    await settle();
    expect(harness.sendCustomMessage).toHaveBeenCalledOnce();
    await expect(parentPort!.deliverCompletion(notice)).resolves.toBe('queued');
    expect(harness.sendCustomMessage).toHaveBeenCalledOnce();
  });

  it('batches completions that arrive before the parent becomes idle', async () => {
    const harness = sessionHarness(true);
    let parentPort: ExecutionParentPort | undefined;
    bindExecutionSession({
      port: hostWithAttachment((port) => {
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
        content: expect.stringContaining('Execution completions:'),
        details: { notices: [first, second] },
      }),
      { triggerTurn: true, deliverAs: 'steer' },
    );
  });

  it('acknowledges persisted completion delivery', async () => {
    const notice = completionNotice('delivery-persisted');
    const harness = sessionHarness(false, [{
      type: 'custom_message',
      customType: 'felan-execution-completion',
      details: { notice },
    }]);
    let parentPort: ExecutionParentPort | undefined;
    bindExecutionSession({
      port: hostWithAttachment((port) => {
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
    let parentPort: ExecutionParentPort | undefined;
    const host = hostWithAttachment((port) => {
      parentPort = port;
      throw new Error('attachment failed');
    });

    expect(() => bindExecutionSession({
      port: host,
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

function hostWithAttachment(attachExecutionParent: SessionExecutionPort['attachExecutionParent']): Pick<SessionExecutionPort, 'attachExecutionParent'> {
  return { attachExecutionParent };
}

function completionNotice(deliveryId: string): ExecutionCompletionNotice {
  return {
    deliveryId,
    parentSessionId: 'parent',
    executionId: 'child',
    label: 'general',
    status: 'completed',
    summary: 'done',
  };
}
