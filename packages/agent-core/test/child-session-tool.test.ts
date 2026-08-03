import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { describe, expect, it } from 'vitest';
import {
  createChildSessionTool,
  type AgentChildSessionRequest,
  type AgentSessionHost,
} from '../src/index.js';

describe('portable child session tool', () => {
  it('maps spawn_agent input and session identity onto the host boundary', async () => {
    const requests: AgentChildSessionRequest[] = [];
    const host: AgentSessionHost = {
      createChildSession: async (request) => {
        requests.push(request);
        return {
          ok: true,
          sessionId: 'child-1',
          status: 'completed',
          result: 'child output',
        };
      },
    };
    const tool = createChildSessionTool(host);
    const context = {
      sessionManager: { getSessionId: () => 'parent-1' },
    } as ExtensionContext;

    const result = await tool.execute(
      'call-1',
      {
        personaId: 'reviewer',
        prompt: 'Review the change',
        block: true,
        model: 'provider/model',
        timeoutMinutes: 5,
        metadata: { lane: 'review' },
      },
      undefined,
      undefined,
      context,
    );

    expect(requests).toEqual([{
      rootSessionId: 'parent-1',
      parentSessionId: 'parent-1',
      personaId: 'reviewer',
      prompt: 'Review the change',
      block: true,
      model: 'provider/model',
      timeoutMinutes: 5,
      metadata: { lane: 'review' },
    }]);
    expect(result).toEqual({
      content: [{ type: 'text', text: 'child output' }],
      details: {
        ok: true,
        sessionId: 'child-1',
        status: 'completed',
        result: 'child output',
      },
    });
  });

  it('surfaces host failures as tool errors', async () => {
    const tool = createChildSessionTool({
      createChildSession: async () => ({
        ok: false,
        sessionId: 'child-2',
        status: 'failed',
        error: 'child failed',
      }),
    });
    const context = {
      sessionManager: { getSessionId: () => 'parent-1' },
    } as ExtensionContext;

    await expect(tool.execute(
      'call-2',
      { personaId: 'worker', prompt: 'Work', block: true },
      undefined,
      undefined,
      context,
    )).rejects.toThrow('child failed');
  });

  it('inherits the active parent model when no override is supplied', async () => {
    const requests: AgentChildSessionRequest[] = [];
    const tool = createChildSessionTool({
      createChildSession: async (request) => {
        requests.push(request);
        return { ok: true, sessionId: 'child-3', status: 'running' };
      },
    });
    const context = {
      sessionManager: { getSessionId: () => 'parent-2' },
      model: { provider: 'anthropic', id: 'claude-test' },
    } as ExtensionContext;

    await tool.execute(
      'call-3',
      { personaId: 'worker', prompt: 'Work', block: false },
      undefined,
      undefined,
      context,
    );

    expect(requests).toEqual([expect.objectContaining({
      model: 'anthropic/claude-test',
      block: false,
    })]);
  });
});
