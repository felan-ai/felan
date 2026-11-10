import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createToolServer } from '../src/bridge/mcp-server.js';
import type { ClaudeAgentSdk, McpRequest } from '../src/sdk/types.js';
import {
  CLAUDE_AGENT_SDK_ENTRY_FILE,
  claudeAgentSdk,
  loadClaudeAgentSdk,
  setClaudeAgentSdk,
} from '../src/sdk/runtime.js';

const directories: string[] = [];
const fakeEntrySource = `
export function query() {
  return { async *[Symbol.asyncIterator]() {}, async interrupt() {}, close() {} };
}
export class McpServer {}
export const CallToolRequestSchema = {};
export const ListToolsRequestSchema = {};
`;

async function entry(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'felan-claude-sdk-'));
  directories.push(directory);
  const path = join(directory, CLAUDE_AGENT_SDK_ENTRY_FILE);
  await writeFile(path, source);
  return path;
}

afterEach(async () => {
  setClaudeAgentSdk(undefined);
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('Claude Agent SDK runtime', () => {
  it('loads a managed ESM entry without installing it as the active SDK', async () => {
    const sdk = await loadClaudeAgentSdk(await entry(fakeEntrySource));
    expect(sdk.query).toBeTypeOf('function');
    expect(sdk.McpServer).toBeTypeOf('function');
    expect(sdk.CallToolRequestSchema).toEqual({});
    expect(sdk.ListToolsRequestSchema).toEqual({});
    expect(() => claudeAgentSdk()).toThrow('Claude Agent SDK is not installed; run /claude-code install');
    setClaudeAgentSdk(sdk);
    expect(claudeAgentSdk()).toBe(sdk);
    await expect(sdk.query({ prompt: 'test' }).interrupt()).resolves.toBeUndefined();
  });

  it.each(['query', 'McpServer', 'CallToolRequestSchema', 'ListToolsRequestSchema'])(
    'rejects an entry missing %s',
    async (name) => {
      const declaration = name === 'query' ? 'function' : name === 'McpServer' ? 'class' : 'const';
      const source = fakeEntrySource.replace(`export ${declaration} ${name}`, `${declaration} ${name}`);
      await expect(loadClaudeAgentSdk(await entry(source)))
        .rejects.toThrow(`Invalid Claude Agent SDK: missing ${name} export; run /claude-code install`);
    },
  );

  it('rejects invalid export values', async () => {
    await expect(loadClaudeAgentSdk(await entry(fakeEntrySource.replace('CallToolRequestSchema = {}', 'CallToolRequestSchema = null'))))
      .rejects.toThrow('missing CallToolRequestSchema export');
  });

  it('reports a failed import with an actionable error and the original cause', async () => {
    await expect(loadClaudeAgentSdk(await entry('throw new Error("broken entry");')))
      .rejects.toMatchObject({
        message: 'Could not load Claude Agent SDK; run /claude-code install',
        cause: expect.objectContaining({ message: 'broken entry' }),
      });
  });

  it('clears an injected SDK', async () => {
    setClaudeAgentSdk(await loadClaudeAgentSdk(await entry(fakeEntrySource)));
    setClaudeAgentSdk(undefined);
    expect(() => claudeAgentSdk()).toThrow('Claude Agent SDK is not installed; run /claude-code install');
  });

  it('uses an injected MCP server and request schemas', async () => {
    const handlers = new Map<object, (request: McpRequest) => unknown>();
    const sdk: ClaudeAgentSdk = {
      ...await loadClaudeAgentSdk(await entry(fakeEntrySource)),
      McpServer: class {
        server = { setRequestHandler: (schema: object, handler: (request: McpRequest) => unknown) => {
          handlers.set(schema, handler);
        } };
      },
    };
    setClaudeAgentSdk(sdk);
    const server = createToolServer('test', [{
      name: 'read',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: {} },
      handler: async (toolCallId) => ({ content: [{ type: 'text', text: toolCallId }] }),
    }]);
    expect(server.instance).toBeInstanceOf(sdk.McpServer);
    expect(handlers.get(sdk.ListToolsRequestSchema)?.({ params: { name: '' } }))
      .toMatchObject({ tools: [{ name: 'read' }] });
    await expect(handlers.get(sdk.CallToolRequestSchema)?.({
      params: { name: 'read', _meta: { 'claudecode/toolUseId': 'call-1' } },
    })).resolves.toMatchObject({ content: [{ type: 'text', text: 'call-1' }] });
  });

});
