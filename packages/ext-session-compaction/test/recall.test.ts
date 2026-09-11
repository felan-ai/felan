import { describe, expect, it } from 'vitest';
import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import { registerSessionRecall } from '../src/recall.js';

describe('active-lineage session recall', () => {
  it('searches only the branch supplied by SessionManager and returns bounded sources', async () => {
    let tool: any;
    const pi = { registerTool: (value: unknown) => { tool = value; } } as unknown as FelanExtensionAPI;
    registerSessionRecall(pi);
    expect(tool.description).toContain('Do not use this tool to search recent, prior, or other sessions');
    expect(tool.promptSnippet).toContain('never use it for prior or other sessions');
    const branch = [
      { type: 'message', id: 'root', parentId: null, timestamp: '1', message: { role: 'user', content: 'Choose the auth approach' } },
      { type: 'message', id: 'active', parentId: 'root', timestamp: '2', message: { role: 'assistant', content: [{ type: 'text', text: 'We chose tokens.' }] } },
    ];
    const result = await tool.execute('recall-1', { query: 'auth' }, undefined, undefined, {
      sessionManager: { getBranch: () => branch, getSessionId: () => 'session-1' },
    });
    expect(result.content[0].text).toContain('entry=root');
    expect(result.content[0].text).not.toContain('sibling');
    expect(result.details).toMatchObject({ bounded: true, scope: 'active-lineage' });
    expect(result.details.sources).toEqual([{ entryId: 'root', type: 'message', timestamp: '1' }]);
  });

  it('treats query metacharacters literally and rejects out-of-lineage expansion', async () => {
    let tool: any;
    const pi = { registerTool: (value: unknown) => { tool = value; } } as unknown as FelanExtensionAPI;
    registerSessionRecall(pi);
    const branch = [{ type: 'message', id: 'entry', parentId: null, timestamp: '1', message: { role: 'user', content: 'Use a [literal] value' } }];
    const ctx = { sessionManager: { getBranch: () => branch, getSessionId: () => 'session-1' } };
    const search = await tool.execute('recall-1', { query: '[literal]' }, undefined, undefined, ctx);
    expect(search.content[0].text).toContain('entry=entry');
    const expansion = await tool.execute('recall-2', { expand: ['sibling'] }, undefined, undefined, ctx);
    expect(expansion.content[0].text).toContain('current active lineage snapshot');
  });
});
