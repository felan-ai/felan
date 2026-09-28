import { describe, expect, it } from 'vitest';
import { collectClassifierSessionEvidence, SessionManager } from '../src/index.js';

describe('classifier session evidence', () => {
  it('projects only the active summary and recent messages without exposing credentials or images', () => {
    const session = SessionManager.inMemory('/workspace');
    session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Obsolete request' }], timestamp: 1 });
    session.appendCompaction('Earlier task summary', null, 100);
    session.appendMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'Investigate this bug with token sk-abcdefghijklmnopqrstuvwxyz' },
        { type: 'image', mimeType: 'image/png', data: 'PRIVATE_IMAGE_DATA' },
      ],
      timestamp: 2,
    });

    const evidence = collectClassifierSessionEvidence(session, {
      maxConversationItems: 2,
      maxTextBytes: 160,
      maxTotalBytes: 512,
    });

    expect(evidence.conversation).toMatchObject([
      { role: 'summary', text: 'Earlier task summary' },
      { role: 'user', text: expect.stringContaining('Investigate this bug') },
    ]);
    expect(JSON.stringify(evidence)).not.toMatch(/Obsolete request|sk-abcdefghijklmnopqrstuvwxyz|PRIVATE_IMAGE_DATA/u);
  });

  it('uses only the active branch and correlates bounded tool metadata without result bodies', () => {
    const session = SessionManager.inMemory('/workspace');
    const forkPoint = session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Fix a build' }], timestamp: 1 });
    session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'Abandoned branch' }], timestamp: 2 });
    session.branch(forkPoint);
    session.appendMessage({
      role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'pnpm test' } }],
      timestamp: 3,
    } as unknown as Parameters<SessionManager['appendMessage']>[0]);
    session.appendMessage({
      role: 'toolResult', toolCallId: 'call-1', toolName: 'bash', isError: false,
      content: [{ type: 'text', text: 'PRIVATE_TOOL_OUTPUT' }], timestamp: 4,
    });

    const evidence = collectClassifierSessionEvidence(session, {
      maxConversationItems: 3, maxToolActivities: 2,
      maxTextBytes: 80, maxToolInputBytes: 80, maxTotalBytes: 512,
    });

    expect(evidence.conversation[0]).toMatchObject({ role: 'user', text: 'Fix a build' });
    expect(evidence.tool_activity).toMatchObject([{ tool: 'bash', input: 'pnpm test', result: 'ok' }]);
    expect(JSON.stringify(evidence)).not.toMatch(/Abandoned branch|PRIVATE_TOOL_OUTPUT/u);
  });

  it('bounds Unicode text and total output while tolerating malformed tool arguments', () => {
    const session = SessionManager.inMemory('/workspace');
    const argumentsWithCycle: Record<string, unknown> = { command: 'test 🔑 --token Bearer abcdefghijklmnopqrstuvwxyz' };
    argumentsWithCycle.self = argumentsWithCycle;
    session.appendMessage({ role: 'user', content: [{ type: 'text', text: 'é'.repeat(200) }], timestamp: 1 });
    session.appendMessage({
      role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: argumentsWithCycle }],
      timestamp: 2,
    } as unknown as Parameters<SessionManager['appendMessage']>[0]);

    const evidence = collectClassifierSessionEvidence(session, {
      maxConversationItems: 2, maxToolActivities: 2, maxTextBytes: 33,
      maxToolInputBytes: 80, maxTotalBytes: 180,
    });
    expect(new TextEncoder().encode(JSON.stringify(evidence)).byteLength).toBeLessThanOrEqual(180);
    expect(evidence.conversation[0]?.text).toBe('é'.repeat(16));
    expect(JSON.stringify(evidence)).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });
});
