import { getExtensionConfigDefinition } from '@felan-ai/agent-core';
import { expect, it } from 'vitest';
import extension from '../src/extension.js';
it('declares no host presentation settings', () => { expect(getExtensionConfigDefinition(extension)).toBeUndefined(); });
