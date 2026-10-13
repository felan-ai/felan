import { SettingsManager, type ExtensionConfigDefinition } from '@felan-ai/agent-core';
import { expect, it } from 'vitest';
import { localSessionConfiguration } from '../src/providers/session-configuration.js';

function fixture(): Parameters<typeof localSessionConfiguration>[0] {
  return { settings: SettingsManager.inMemory({ compaction: { enabled: true } }), packages: ['example'],
    definitions: [], configs: new Map(), models: [{ provider: 'offline', id: 'model' }], paths: [], skills: [], append: undefined };
}

it('fingerprints resolved execution settings, model scope and append instructions', () => {
  const base = fixture(); const original = localSessionConfiguration(base);
  expect(localSessionConfiguration({ ...base, settings: SettingsManager.inMemory({ compaction: { enabled: false } }) })).not.toEqual(original);
  expect(localSessionConfiguration({ ...base, models: [] })).not.toEqual(original);
  expect(localSessionConfiguration({ ...base, append: 'Additional instructions' })).not.toEqual(original);
  expect(JSON.stringify(original)).not.toContain('Additional instructions');
});

it('ignores configuration object key order but detects changed values', () => {
  const base = fixture();
  const a = localSessionConfiguration({ ...base, configs: new Map([['example', { enabled: true, size: 2 }]]) });
  const b = localSessionConfiguration({ ...base, configs: new Map([['example', { size: 2, enabled: true }]]) });
  expect(a).toEqual(b);
  expect(localSessionConfiguration({ ...base, configs: new Map([['example', { size: 3, enabled: true }]]) })).not.toEqual(a);
});

it('does not retain or fingerprint sensitive extension fields', () => {
  const base = fixture();
  base.definitions = [{ id: 'example', fields: { credential: { sensitive: true } } } as unknown as ExtensionConfigDefinition];
  const a = localSessionConfiguration({ ...base, configs: new Map([['example', { credential: 'first-secret' }]]) });
  const b = localSessionConfiguration({ ...base, configs: new Map([['example', { credential: 'second-secret' }]]) });
  expect(a).toEqual(b);
  expect(JSON.stringify(a)).not.toContain('secret');
});
