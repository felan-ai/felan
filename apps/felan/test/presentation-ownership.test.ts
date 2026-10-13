import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('keeps subagent presentation in the client and the daemon execution port generic', async () => {
  const daemon = await readFile(new URL('../../daemon/src/daemon/session-execution.ts', import.meta.url), 'utf8');
  expect(daemon).not.toMatch(/Subagent|AgentView|Navigator/);
  const client = await readFile(new URL('../src/client/agents-presenter.ts', import.meta.url), 'utf8');
  expect(client).toContain('new ClientAgentHost(client, parent, settings, toolPresentation)');
  expect(client).not.toContain('registerCustom');
  const host = await readFile(new URL('../src/client/agent-host.ts', import.meta.url), 'utf8');
  expect(host).toContain("'executions.list'");
  expect(host).not.toContain('createLocalFelanRuntime');
  const memory = await readFile(new URL('../src/memory/history-renderer.ts', import.meta.url), 'utf8');
  expect(memory).toContain("from '../subagents/agent-transcript.js'");
});
