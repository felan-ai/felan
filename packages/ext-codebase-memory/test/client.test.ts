import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostAgentRuntime } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { CbmClient } from '../src/client.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('CbmClient stdio transport', () => {
  it('initializes once, reuses one frontend, and closes it cleanly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'felan-cbm-client-'));
    temporaryRoots.push(root);
    const workspace = join(root, 'workspace');
    const session = join(root, 'session');
    const agent = join(root, 'agent');
    const script = join(root, 'cbm-fixture.mjs');
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(session, { recursive: true }),
      mkdir(agent, { recursive: true }),
      writeFile(script, `#!/usr/bin/env node
process.stdin.setEncoding('utf8');
let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk;
  for (;;) {
    const newline = pending.indexOf('\\n');
    if (newline < 0) break;
    const message = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    if (message.id === undefined) continue;
    const result = message.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
      : { content: [{ type: 'text', text: JSON.stringify({ projects: [{ name: 'fixture', root_path: '/work/repo', size_bytes: 7 }] }) }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
`),
      writeFile(join(workspace, 'answer.ts'), 'export const answer = 42;'),
    ]);
    await chmod(script, 0o700);
    const runtime = new HostAgentRuntime(workspace, { sessionStorageRoot: session, agentStorageRoot: agent });
    const client = new CbmClient(runtime, { command: script, version: '0.10.8', source: 'managed' });

    await expect(client.call('list_projects', {})).resolves.toMatchObject({
      data: { projects: [{ name: 'fixture' }] },
    });
    await expect(client.call('list_projects', {})).resolves.toMatchObject({
      data: { projects: [{ size_bytes: 7 }] },
    });
    await client.close();
    await expect(client.call('list_projects', {})).rejects.toThrow('closed');
  });
});
