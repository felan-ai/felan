import type { SubagentHost } from '@felan-ai/ext-subagents';
import { describe, expect, it } from 'vitest';
import {
  createLocalExtensionImporter,
  importLocalExtension,
  localExtensionPackages,
  resolveBuiltinExtensionPackages,
} from '../src/extensions.js';

describe('local extension importer', () => {
  it('imports only the source-controlled package list', async () => {
    expect(localExtensionPackages).toEqual([
      '@felan-ai/ext-subagents',
      '@felan-ai/ext-prewalk',
      '@felan-ai/ext-context',
      '@felan-ai/ext-powerline',
    ]);

    for (const packageName of localExtensionPackages) {
      const imported = await importLocalExtension(packageName);
      if (packageName === '@felan-ai/ext-subagents') {
        expect(imported).toMatchObject({ createSubagentsExtension: expect.any(Function) });
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
    const importer = createLocalExtensionImporter(testSubagentHost(), async () => {
      throw new Error('The generic importer must not load the subagent extension');
    });

    await expect(importer('@felan-ai/ext-subagents')).resolves.toMatchObject({
      default: expect.any(Function),
    });
  });

  it('enables only configured built-in extensions', () => {
    expect(resolveBuiltinExtensionPackages({
      subagents: false,
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

function testSubagentHost(): SubagentHost {
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
    steer: async () => ({ ok: false, error: { code: 'not_found', message: 'unused' } }),
    cancel: async () => ({ ok: false, error: { code: 'not_found', message: 'unused' } }),
  };
}
