import { getExtensionConfigDefinition } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { createPrewalkExtension } from '../../../../packages/ext-prewalk/src/index.js';

describe('Prewalk entrypoint boundary', () => {

  it('associates configuration with each host-bound factory result', () => {
    expect(getExtensionConfigDefinition(createPrewalkExtension({ review: async () => undefined }))?.id).toBe('prewalk');
  });
});
