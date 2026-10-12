import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('keeps subagent and tool presentation in the client, with an injected daemon registration port', async () => {
  const daemon = await readFile(new URL('../../daemon/src/extensions.ts', import.meta.url), 'utf8');
  expect(daemon).not.toContain("from './subagents/agent-navigator.js'");
  expect(daemon).toContain('uiHosts.subagents?.register');
  const port = await readFile(new URL('../../daemon/src/subagents/presentation.ts', import.meta.url), 'utf8');
  expect(port).not.toContain('@earendil-works/pi-tui'); expect(port).not.toContain('apps/felan');
  const client = await readFile(new URL('../src/runtime.ts', import.meta.url), 'utf8');
  expect(client).toContain('subagents: createLocalSubagentPresentation()');
  expect(client).not.toContain('@felan-ai/daemon/internal/tool-activity');
  const memory = await readFile(new URL('../src/memory/history-renderer.ts', import.meta.url), 'utf8');
  expect(memory).toContain("from '../subagents/agent-transcript.js'");
});
