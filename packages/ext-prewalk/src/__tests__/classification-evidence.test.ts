import { SessionManager, type ExtensionContext, type FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { createPrewalkClassifier } from '../classification.js';

function setup(failed: boolean) {
  const session = SessionManager.inMemory('/workspace');
  session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Fix this build' }], timestamp: 1 });
  session.appendMessage({
    role: 'assistant', timestamp: 2, content: [
      { type: 'toolCall', id: 'edit-1', name: 'apply_patch', arguments: { path: 'src/index.ts' } },
      { type: 'toolCall', id: 'check-1', name: 'bash', arguments: { command: 'pnpm test' } },
    ],
  } as unknown as Parameters<SessionManager['appendMessage']>[0]);
  session.appendMessage({
    role: 'toolResult', toolCallId: 'edit-1', toolName: 'apply_patch', isError: false,
    content: [{ type: 'text', text: 'Patch applied' }], timestamp: 3,
  });
  session.appendMessage({
    role: 'toolResult', toolCallId: 'check-1', toolName: 'bash', isError: failed,
    content: [{ type: 'text', text: failed ? 'Exit code: 1\nPRIVATE_OUTPUT' : 'Exit code: 0\nPRIVATE_OUTPUT' }],
    details: { exitCode: failed ? 1 : 0 }, timestamp: 4,
  });
  const classify = vi.fn().mockResolvedValue({ answers: { verdict: { type: 'choice', choice: 'done' } } });
  const pi = { runtime: { classifier: { classify } } } as unknown as FelanExtensionAPI;
  const ctx = { sessionManager: session } as unknown as ExtensionContext;
  return { classifier: createPrewalkClassifier(pi)!, ctx, classify };
}

describe('Prewalk classifier session evidence', () => {
  it.each([
    [false, 'done', false],
    [true, 'unsure', true],
  ] as const)('retains verification gating when the last test failed=%s', async (failed, verdict, failedVerification) => {
    const { classifier, ctx, classify } = setup(failed);

    expect(await classifier.completion({ request: 'Fix this build', tasks: [] }, 'Done', ctx)).toBe(verdict);
    expect(classify.mock.calls[0]?.[0].session).toMatchObject({
      conversation: [{ role: 'user', text: 'Fix this build' }],
      tool_activity: [
        { tool: 'apply_patch', input: 'src/index.ts', result: 'ok' },
        { tool: 'bash', input: 'pnpm test', result: failed ? 'failed' : 'ok', exit_code: failed ? 1 : 0 },
      ],
      verification_after_last_mutation: !failed,
      failed_verification: failedVerification,
    });
    expect(JSON.stringify(classify.mock.calls[0]?.[0])).not.toContain('PRIVATE_OUTPUT');
  });
});
