import { SESSIONS_HISTORY_SERVICE, createExtensionServiceAccess, createFelanServiceRegistry, createUnavailableExtensionUi, getExtensionConfigDefinition, type FelanExtensionAPI, type SessionsHistory } from '@felan-ai/agent-core';
import { expect, it, vi } from 'vitest';
import extension, { PROMPT_HISTORY_CONFIG } from '../src/extension.js';

it('requires shared Sessions but no feature-specific presentation service', () => {
  expect(getExtensionConfigDefinition(extension)).toBe(PROMPT_HISTORY_CONFIG);
  expect(extension.serviceRequirements).toEqual({ required: [SESSIONS_HISTORY_SERVICE] });
  const services = createFelanServiceRegistry();
  const registerCommand = vi.fn(); const registerShortcut = vi.fn(); const on = vi.fn();
  const pi = { config: { displayMode: 'overlay' }, ui: createUnavailableExtensionUi(),
    services: createExtensionServiceAccess(services, extension.serviceRequirements!),
    registerCommand, registerShortcut, on } as unknown as FelanExtensionAPI;
  expect(() => extension(pi)).toThrow('Required service felan.sessions.history@1 has no configured provider.');
  expect(registerCommand).not.toHaveBeenCalled();
  const history = {
    current: { id: 'current', root: 'current' },
    list: vi.fn<SessionsHistory['list']>().mockResolvedValue({ items: [] }),
    history: vi.fn<SessionsHistory['history']>().mockResolvedValue({ sessionId: 'current', revision: 'r', branch: null, entries: [] }),
    checkpoint: vi.fn<SessionsHistory['checkpoint']>().mockResolvedValue({ sessionId: 'current', revision: 'r', branch: null, byteLength: 0, transcriptDigest: 'empty' }),
  } satisfies SessionsHistory;
  services.set(SESSIONS_HISTORY_SERVICE, history);
  extension(pi);
  expect(registerCommand).toHaveBeenCalledWith('prompt-history', expect.any(Object));
  expect(registerShortcut).toHaveBeenCalledTimes(2);
  expect(history).not.toHaveProperty('create');
  expect(history).not.toHaveProperty('steer');
});
