import type { ModelRuntime } from '@felan-ai/agent-core';
import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import { createEmptyMemoryArtifact, createMemorySnapshot, type MemoryHost } from '@felan-ai/ext-memory';
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
      '@felan-ai/ext-mcp',
      '@felan-ai/ext-felan-api',
      '@felan-ai/ext-web-access',
      '@felan-ai/ext-browser',
      '@felan-ai/ext-background-bash',
      '@felan-ai/ext-codex',
      '@felan-ai/ext-rtk-optimizer',
      '@felan-ai/ext-markitdown',
      '@felan-ai/ext-context',
      '@felan-ai/ext-memory',
      '@felan-ai/ext-powerline',
      '@felan-ai/ext-output-style',
    ]);

    for (const packageName of localExtensionPackages) {
      const imported = await importLocalExtension(packageName);
      if (packageName === '@felan-ai/ext-subagents') {
        expect(imported).toMatchObject({ createSubagentsExtension: expect.any(Function) });
      } else if (packageName === '@felan-ai/ext-ask-user') {
        expect(imported).toMatchObject({ createAskUserExtension: expect.any(Function) });
      } else if (packageName === '@felan-ai/ext-mcp') {
        expect(imported).toMatchObject({ createMcpExtension: expect.any(Function) });
      } else if (packageName === '@felan-ai/ext-memory') {
        expect(imported).toMatchObject({ createMemoryExtension: expect.any(Function) });
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

  it('binds the selected output style without invoking the generic importer', async () => {
    const importer = createLocalExtensionImporter(
      testSubagentHost(),
      testModelRuntime(),
      async () => { throw new Error('The generic importer must not load output style'); },
      undefined,
      undefined,
      'explanatory',
    );
    const imported = await importer('@felan-ai/ext-output-style') as {
      default: (pi: FelanExtensionAPI) => void;
    };
    let handler: ((event: { systemPrompt: string }) => { systemPrompt: string } | undefined) | undefined;
    imported.default({
      on: ((event: string, registered: typeof handler) => {
        if (event === 'before_agent_start') handler = registered;
      }) as FelanExtensionAPI['on'],
    } as FelanExtensionAPI);

    expect(handler?.({ systemPrompt: 'Base prompt' })?.systemPrompt).toContain(
      'Explain the reasoning and important tradeoffs',
    );
  });

  it('binds caveman output style for local root sessions', async () => {
    const importer = createLocalExtensionImporter(
      testSubagentHost(),
      testModelRuntime(),
      async () => { throw new Error('The generic importer must not load output style'); },
      undefined,
      undefined,
      'caveman',
    );
    const imported = await importer('@felan-ai/ext-output-style') as {
      default: (pi: FelanExtensionAPI) => void;
    };
    let handler: ((event: { systemPrompt: string }) => { systemPrompt: string } | undefined) | undefined;
    imported.default({
      on: ((event: string, registered: typeof handler) => {
        if (event === 'before_agent_start') handler = registered;
      }) as FelanExtensionAPI['on'],
    } as FelanExtensionAPI);

    expect(handler?.({ systemPrompt: 'Base prompt' })?.systemPrompt).toContain(
      'Use the fewest words that preserve correctness',
    );
  });

  it('forwards custom output-style instructions for local root sessions', async () => {
    const importer = createLocalExtensionImporter(
      testSubagentHost(),
      testModelRuntime(),
      async () => { throw new Error('The generic importer must not load output style'); },
    );
    const imported = await importer('@felan-ai/ext-output-style') as {
      default: (pi: FelanExtensionAPI) => void;
    };
    let handler: ((event: { systemPrompt: string }) => { systemPrompt: string } | undefined) | undefined;
    imported.default({
      config: {
        style: 'custom',
        instructions: 'Custom benchmark instructions.',
      },
      on: ((event: string, registered: typeof handler) => {
        if (event === 'before_agent_start') handler = registered;
      }) as FelanExtensionAPI['on'],
    } as FelanExtensionAPI);

    expect(handler?.({ systemPrompt: 'Base prompt' })?.systemPrompt).toContain(
      '<output_style>\nCustom benchmark instructions.\n</output_style>',
    );
  });

  it('binds memory as root or reader without sharing checkpoint behavior', async () => {
    const host = memoryHost();
    const rootImporter = createLocalExtensionImporter(
      testSubagentHost(),
      testModelRuntime(),
      async () => { throw new Error('Memory must be host-bound'); },
      undefined,
      { role: 'root', host },
    );
    const readerImporter = createLocalExtensionImporter(
      testSubagentHost(),
      testModelRuntime(),
      async () => { throw new Error('Memory must be host-bound'); },
      undefined,
      { role: 'reader', host },
    );
    const rootHandlers: string[] = [];
    const readerHandlers: string[] = [];
    const root = await rootImporter('@felan-ai/ext-memory') as { default: (pi: FelanExtensionAPI) => void };
    const reader = await readerImporter('@felan-ai/ext-memory') as { default: (pi: FelanExtensionAPI) => void };
    root.default(extensionApi(rootHandlers));
    reader.default(extensionApi(readerHandlers));
    expect(rootHandlers).toContain('agent_settled');
    expect(readerHandlers).not.toContain('agent_settled');
    expect(rootHandlers).toEqual(expect.arrayContaining(['session_start', 'session_compact', 'session_tree']));
    expect(readerHandlers).toEqual(expect.arrayContaining(['session_start', 'session_compact', 'session_tree']));
    expect(rootHandlers).not.toContain('context');
    expect(readerHandlers).not.toContain('context');
  });

  it('enables only configured built-in extensions', () => {
    expect(resolveBuiltinExtensionPackages({
      subagents: false,
      askUser: false,
      tasks: false,
      markitdown: false,
      mcp: false,
      webAccess: false,
      browser: false,
      backgroundBash: false,
      codex: false,
      rtkOptimizer: false,
      memory: false,
      felanApi: false,
      powerline: false,
      outputStyle: false,
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

function memoryHost(): MemoryHost {
  return {
    readCurrent: async () => createMemorySnapshot(createEmptyMemoryArtifact('.memory'), '.memory'),
    recordCheckpoint: async () => {},
    status: async () => ({ enabled: true, state: 'idle', pendingCheckpoints: 0 }),
  };
}

function extensionApi(handlers: string[]): FelanExtensionAPI {
  return {
    on: ((event: string) => handlers.push(event)) as FelanExtensionAPI['on'],
    registerCapability: () => {},
  } as unknown as FelanExtensionAPI;
}
