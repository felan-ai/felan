import { describe, expect, it } from 'vitest';
import { configField, defineExtensionConfig } from '@felan-ai/agent-core';
import { resolveExtensionConfigSettings } from '../src/settings.js';

// A synthetic definition with one user-scoped and one session-scoped field, so
// the behaviour is checked without coupling to any real extension's internals.
const DEMO_CONFIG = defineExtensionConfig({
  id: 'demo',
  title: 'Demo',
  fields: {
    endpoint: configField.string({
      default: '', scope: 'user', description: 'Service endpoint',
    }),
    secret: configField.string({
      default: '', scope: 'session', sensitive: true, description: 'API token',
    }),
  },
});

describe('resolveExtensionConfigSettings scope handling', () => {
  it('applies a user-scoped field and drops a session-scoped one with a warning', () => {
    const result = resolveExtensionConfigSettings(
      {
        extensionConfig: {
          demo: { endpoint: 'https://svc.example', secret: 'sk-live-xxxx' },
        },
      },
      [DEMO_CONFIG],
    );

    const applied = result.configs.get('demo');
    expect(applied?.endpoint).toBe('https://svc.example'); // user-scoped -> applied
    expect(applied?.secret).toBe('');                       // session-scoped -> left at default

    // A warning that names the dropped field and says it is session-scoped.
    expect(
      result.warnings.some((w) => w.includes('session') && w.includes('secret')),
    ).toBe(true);

    // No override is emitted for the dropped field; the user-scoped one is.
    const override = result.overrides.find((o) => o.extensionId === 'demo');
    expect(override?.values.endpoint).toBe('https://svc.example');
    expect(override?.values.secret).toBeUndefined();
  });

  it('does not warn or drop anything when no session-scoped field is configured', () => {
    const result = resolveExtensionConfigSettings(
      { extensionConfig: { demo: { endpoint: 'https://ok.example' } } },
      [DEMO_CONFIG],
    );
    expect(result.configs.get('demo')?.endpoint).toBe('https://ok.example');
    expect(result.warnings.some((w) => w.includes('session'))).toBe(false);
  });
});
