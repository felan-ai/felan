import { createCodemodeExtension, type InlineExtension } from '@felan-ai/agent-core';
import type { LocalCodemodeMode } from './settings.js';

export function createLocalCodemodeExtension(mode: LocalCodemodeMode): InlineExtension | undefined {
  if (mode === 'off') return undefined;
  const nativeExtension = createCodemodeExtension({ mode, models: false });
  return {
    name: '@felan-ai/felan/codemode',
    factory: async (pi) => {
      await nativeExtension(pi);
      pi.on('session_start', () => {
        pi.setActiveTools([...pi.getActiveTools(), 'codemode']);
      });
    },
  };
}
