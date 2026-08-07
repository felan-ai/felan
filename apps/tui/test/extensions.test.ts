import type { ModelRuntime } from '@felan-ai/agent-core';
import type { SubagentHost } from '@felan-ai/ext-subagents';
import { describe, expect, it } from 'vitest';
import {
  createLocalExtensionImporter,
  importLocalExtension,
  localExtensionPackages,
  resolveBuiltinExtensionPackages,
} from '../src/extensions.js';
import type { LocalSubagentNavigatorHost } from '../src/subagents/agent-navigator.js';

describe('local extension importer', () => {
  it('imports only the source-controlled package list', async () => {
    expect(localExtensionPackages).toEqual([
      '@felan-ai/ext-subagents',
      '@felan-ai/ext-ask-user',
      '@felan-ai/ext-tasks',
      '@felan-ai/ext-prewalk',
      '@felan-ai/ext-context',
      '@felan-ai/ext-mcp',
      '@felan-ai/ext-web-access',
      '@felan-ai/ext-background-bash',
      '@felan-ai/ext-codex',
      '@felan-ai/ext-rtk-optimizer',
      '@felan-ai/ext-powerline',
    ]);

    for (const packageName of localExtensionPackages) {
      const imported = await importLocalExtension(packageName);
      if (packageName === '@felan-ai/ext-subagents') {
        expect(imported).toMatchObject({ createSubagentsExtension: expect.any(Function) });
      } else if (packageName === '@felan-ai/ext-ask-user') {
        expect(imported).toMatchObject({ createAskUserExtension: expect.any(Function) });
      } else if (packageName === '@felan-ai/ext-mcp') {
        expect(imported).toMatchObject({ createMcpExtension: expect.any(Function) });
      } else {
        expect(imported).toMatchObject({ default: expect.any(Function) });
      }
    }
    for (const packageName of ['@felan-ai/agent-core', '@felan-ai/ambient']) {
      await expect(importLocalExtension(packageName)).rejects.toThrow(
        `Unknown local extension package: ${packageName}`,
      );
    }
  });

  it('creates the subagent extension without invoking the generic importer', async () => {
    const importer = createLocalExtensionImporter(testSubagentHost(), testModelRuntime(), async () => {
      throw new Error('The generic importer must not load the subagent extension');
    });

    await expect(importer('@felan-ai/ext-subagents')).resolves.toMatchObject({
      default: expect.any(Function),
    });
  });

  it('creates the TUI ask-user extension without invoking the generic importer', async () => {
    const importer = createLocalExtensionImporter(testSubagentHost(), testModelRuntime(), async () => {
      throw new Error('The generic importer must not load the ask-user extension');
    });

    await expect(importer('@felan-ai/ext-ask-user')).resolves.toMatchObject({
      default: expect.any(Function),
    });
  });

  it('creates the local OAuth MCP extension without invoking the generic importer', async () => {
    const importer = createLocalExtensionImporter(testSubagentHost(), testModelRuntime(), async () => {
      throw new Error('The generic importer must not load the MCP extension');
    });

    await expect(importer('@felan-ai/ext-mcp')).resolves.toMatchObject({
      default: expect.any(Function),
    });
  });

  it('creates powerline with the Felan subscription host without invoking the generic importer', async () => {
    const importer = createLocalExtensionImporter(testSubagentHost(), testModelRuntime(), async () => {
      throw new Error('The generic importer must not load the powerline extension');
    });

    await expect(importer('@felan-ai/ext-powerline')).resolves.toMatchObject({
      default: expect.any(Function),
    });
  });

  it('enables only configured built-in extensions', () => {
    expect(resolveBuiltinExtensionPackages({
      subagents: false,
      askUser: false,
      tasks: false,
      mcp: false,
      webAccess: false,
      backgroundBash: false,
      codex: false,
      rtkOptimizer: false,
      powerline: false,
    })).toEqual([
      '@felan-ai/ext-prewalk',
      '@felan-ai/ext-context',
    ]);

    expect(() => resolveBuiltinExtensionPackages({ ambient: true })).toThrow(
      'Unknown built-in extension: ambient',
    );
    expect(() => resolveBuiltinExtensionPackages({ prewalk: 'yes' })).toThrow(
      'Built-in extension prewalk must be a boolean',
    );
  });
});

function testSubagentHost(): SubagentHost & LocalSubagentNavigatorHost {
  return {
    descriptors: [{
      id: 'developer',
      description: 'Implement changes',
      allowNesting: true,
    }],
    policy: {
      maxPromptBytes: 64_000,
      maxDescriptionBytes: 512,
      maxSteerBytes: 16_000,
    },
    attachParent: () => () => {},
    spawn: async () => ({ ok: false, error: { code: 'host_unavailable', message: 'unused' } }),
    list: async () => ({ ok: true, value: [] }),
    getResult: async () => ({ ok: false, error: { code: 'not_found', message: 'unused' } }),
    listLocalSubagents: () => [],
    getLocalSubagent: () => undefined,
    steer: async () => ({ ok: false, error: { code: 'not_found', message: 'unused' } }),
    cancel: async () => ({ ok: false, error: { code: 'not_found', message: 'unused' } }),
  };
}

function testModelRuntime(): ModelRuntime {
  return {} as ModelRuntime;
}
