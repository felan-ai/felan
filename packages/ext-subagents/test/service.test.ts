import { expect, it, vi } from 'vitest';
import { SESSIONS_SERVICE, type SessionsService, type FelanExtensionAPI, type ToolDefinition } from '@felan-ai/agent-core';
import extension from '../src/extension.js';
import { createSubagentsExtension } from '../src/index.js';

it('requires only the core Sessions contract', () => {
  expect(extension.serviceRequirements?.required).toEqual([SESSIONS_SERVICE]);
  expect(extension.serviceRequirements?.optional).toBeUndefined();
});
it('uses provider admission without scanning session history and retains definition restrictions', async () => {
  const create = vi.fn(async () => ({ id: 'child', state: 'queued' }));
  const list = vi.fn();
  const sessions = { create, list } as unknown as SessionsService;
  const tools = new Map<string, ToolDefinition<any, any, any>>();
  createSubagentsExtension(sessions, [{ descriptor: { id: 'explore', description: 'Inspect', allowNesting: false }, prompt: 'Inspect only', toolProfile: 'inspection' }])({
    registerTool: (tool: ToolDefinition<any, any, any>) => tools.set(tool.name, tool), registerCapability() {}, getThinkingLevel: () => 'off',
  } as unknown as FelanExtensionAPI);
  const result = await tools.get('Agent')!.execute('call', { subagent_type: 'explore', prompt: 'Find it', description: 'Inspect', max_turns: 3, timeout_seconds: 10 }, undefined, undefined, {} as Parameters<ToolDefinition['execute']>[4]);
  expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('status: queued') })]);
  expect(list).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ label: 'explore', appendSystemPrompt: 'Inspect only', allowChildren: false,
    notifyOnCompletion: true, excludedTools: expect.arrayContaining(['bash', 'write']), maxTurns: 3, timeoutMs: 10_000 }), undefined);
});
