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
    await expect(importLocalExtension('@felan-ai/ambient')).rejects.toThrow(
      'Unknown local extension package: @felan-ai/ambient',
    );
  });
});
