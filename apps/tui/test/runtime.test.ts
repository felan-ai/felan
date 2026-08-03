import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AGENT_CORE_VERSION,
  HostAgentRuntime,
  SessionManager,
  createAgentSessionRuntime,
} from '@felan-ai/agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalModelRuntime,
  createLocalSessionRuntimeFactory,
} from '../src/runtime.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('local Agent Core lifecycle', () => {
  it('recreates cwd-bound host runtime and services for fork, new, resume, and import', async () => {
    const root = await temporaryDirectory();
    const cwdA = join(root, 'workspace-a');
    const cwdB = join(root, 'workspace-b');
    const cwdC = join(root, 'workspace-c');
    const agentDir = join(root, 'agent');
    const sessionDir = join(root, 'sessions');
    const importDir = join(root, 'imports');
    await Promise.all([cwdA, cwdB, cwdC, agentDir, sessionDir, importDir].map(
      (path) => mkdir(path, { recursive: true }),
    ));

    const createdHostRuntimes: HostAgentRuntime[] = [];
    const modelRuntime = await createLocalModelRuntime(agentDir);
    const createRuntime = createLocalSessionRuntimeFactory({
      agentDir,
      modelRuntime,
      extensionPackages: [],
      importExtension: async () => {
        throw new Error('No extensions should be imported');
      },
      runtimeFactory: (cwd) => {
        const hostRuntime = new HostAgentRuntime(cwd);
        createdHostRuntimes.push(hostRuntime);
        return hostRuntime;
      },
    });
    const initialSessionManager = SessionManager.create(cwdA, sessionDir);
    const entryId = initialSessionManager.appendMessage({
      role: 'user',
      content: 'initial prompt',
      timestamp: Date.now(),
    });
    initialSessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'initial response' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'test-model',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: cwdA,
      agentDir,
      sessionManager: initialSessionManager,
    });
    const reboundCwds: string[] = [];
    runtime.setRebindSession(async (session) => {
      reboundCwds.push(session.sessionManager.getCwd());
    });

    const initialServices = runtime.services;
    expect(runtime.diagnostics).toContainEqual({
      type: 'info',
      message: `Agent Core version: ${AGENT_CORE_VERSION}`,
    });
    expect(runtime.session.agent.state.tools.map((tool) => tool.name)).toEqual([
      'read',
      'bash',
      'edit',
      'write',
      'grep',
      'find',
      'ls',
      'spawn_agent',
    ]);

    await runtime.fork(entryId, { position: 'at' });
    const forkServices = runtime.services;
    expect(forkServices).not.toBe(initialServices);
    expect(runtime.cwd).toBe(cwdA);

    await runtime.newSession();
    const newServices = runtime.services;
    expect(newServices).not.toBe(forkServices);
    expect(runtime.cwd).toBe(cwdA);

    const resumedSession = SessionManager.create(cwdB, sessionDir);
    resumedSession.appendMessage({ role: 'user', content: 'resume', timestamp: Date.now() });
    resumedSession.appendMessage(completedAssistantMessage('resumed'));
    const resumedPath = resumedSession.getSessionFile();
    expect(resumedPath).toBeDefined();
    await runtime.switchSession(resumedPath!);
    const resumedServices = runtime.services;
    expect(resumedServices).not.toBe(newServices);
    expect(runtime.cwd).toBe(cwdB);

    const importedSession = SessionManager.create(cwdC, importDir);
    importedSession.appendMessage({ role: 'user', content: 'imported', timestamp: Date.now() });
    importedSession.appendMessage(completedAssistantMessage('imported'));
    const importPath = importedSession.getSessionFile();
    expect(importPath).toBeDefined();
    await runtime.importFromJsonl(importPath!);
    expect(runtime.services).not.toBe(resumedServices);
    expect(runtime.cwd).toBe(cwdC);

    expect(createdHostRuntimes).toHaveLength(5);
    expect(new Set(createdHostRuntimes).size).toBe(5);
    expect(createdHostRuntimes.map((hostRuntime) => hostRuntime.cwd)).toEqual([
      cwdA,
      cwdA,
      cwdA,
      cwdB,
      cwdC,
    ]);
    expect(reboundCwds).toEqual([cwdA, cwdA, cwdB, cwdC]);

    await runtime.dispose();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-runtime-'));
  temporaryPaths.push(path);
  return path;
}

function completedAssistantMessage(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'anthropic-messages' as const,
    provider: 'anthropic',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  };
}
