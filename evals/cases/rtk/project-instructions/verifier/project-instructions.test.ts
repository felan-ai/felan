import { join } from 'node:path';
import {
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentCoreSession,
} from '../src/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { TestAgentRuntime } from './test-agent-runtime.js';

const sessions: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
});

describe('root project instructions', () => {
  it('loads AGENTS.md through AgentRuntime and prefers it over CLAUDE.md', async () => {
    const cwd = '/virtual/project';
    const runtime = new TestAgentRuntime(cwd);
    await runtime.writeFile('AGENTS.md', new TextEncoder().encode('Primary project guidance'));
    await runtime.writeFile('CLAUDE.md', new TextEncoder().encode('Fallback project guidance'));
    await runtime.mkdir('packages');
    await runtime.writeFile('packages/AGENTS.md', new TextEncoder().encode('Nested project guidance'));

    const systemPrompt = await composeSystemPrompt(runtime);
    const normalizedPath = join(cwd, 'AGENTS.md').replace(/\\/gu, '/');
    expect(systemPrompt).toContain(`<project_instructions path="${normalizedPath}">`);
    expect(systemPrompt).toContain('Primary project guidance');
    expect(systemPrompt).not.toContain('Fallback project guidance');
    expect(systemPrompt).not.toContain('Nested project guidance');
    expect(systemPrompt.indexOf('Primary project guidance')).toBeLessThan(
      systemPrompt.indexOf('Current working directory:'),
    );
  });

  it('uses CLAUDE.md when AGENTS.md cannot be read', async () => {
    const cwd = '/virtual/fallback';
    const runtime = new TestAgentRuntime(cwd);
    await runtime.writeFile('CLAUDE.md', new TextEncoder().encode('\nFallback instructions\n'));

    const systemPrompt = await composeSystemPrompt(runtime);
    const normalizedPath = join(cwd, 'CLAUDE.md').replace(/\\/gu, '/');
    expect(systemPrompt).toContain(`<project_instructions path="${normalizedPath}">`);
    expect(systemPrompt).toContain('Fallback instructions');
  });

  it('keeps missing and empty instruction files nonfatal', async () => {
    const missingRuntime = new TestAgentRuntime('/virtual/missing');
    const missingPrompt = await composeSystemPrompt(missingRuntime);
    expect(missingPrompt).not.toContain('<project_instructions');

    const emptyRuntime = new TestAgentRuntime('/virtual/empty');
    await emptyRuntime.writeFile('AGENTS.md', new TextEncoder().encode(' \n\t'));
    await emptyRuntime.writeFile('CLAUDE.md', new TextEncoder().encode('Ignored after empty AGENTS.md'));
    const emptyPrompt = await composeSystemPrompt(emptyRuntime);
    expect(emptyPrompt).not.toContain('<project_instructions');
    expect(emptyPrompt).not.toContain('Ignored after empty AGENTS.md');
  });
});

async function composeSystemPrompt(runtime: TestAgentRuntime): Promise<string> {
  const agentDir = join(runtime.cwd, '.agent');
  const result = await createAgentCoreSession({
    runtime,
    extensionPackages: [],
    importExtension: async () => {
      throw new Error('No extension package should be imported');
    },
    modelRuntime: await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
    }),
    settingsManager: SettingsManager.inMemory(),
    sessionManager: SessionManager.inMemory(runtime.cwd),
    agentDir,
  });
  sessions.push(result.session);
  return result.session.systemPrompt;
}
