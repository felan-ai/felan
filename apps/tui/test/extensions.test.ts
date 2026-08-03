import { describe, expect, it } from 'vitest';
import { importLocalExtension, localExtensionPackages } from '../src/extensions.js';

describe('local extension importer', () => {
  it('imports only the source-controlled package list', async () => {
    expect(localExtensionPackages).toEqual([
      '@felan-ai/ext-prewalk',
      '@felan-ai/ext-context',
      '@felan-ai/ext-powerline',
    ]);

    for (const packageName of localExtensionPackages) {
      await expect(importLocalExtension(packageName)).resolves.toMatchObject({
        default: expect.any(Function),
      });
    }
    for (const packageName of ['@felan-ai/agent-core', '@felan-ai/ambient']) {
      await expect(importLocalExtension(packageName)).rejects.toThrow(
        `Unknown local extension package: ${packageName}`,
      );
    }
  });
});
