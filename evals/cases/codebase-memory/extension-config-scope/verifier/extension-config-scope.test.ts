import { describe, expect, it } from 'vitest';
import {
  configField,
  defineExtensionConfig,
  getPersistableExtensionConfig,
} from '../src/index.js';

const definition = defineExtensionConfig({
  id: 'scoped',
  title: 'Scoped',
  fields: {
    theme: configField.enum(['dark', 'light'], {
      default: 'dark', description: 'UI theme', scope: 'user',
    }),
    layout: configField.json({
      default: { rows: 1 }, description: 'Layout blob', scope: 'project',
    }),
    token: configField.string({
      default: '', description: 'API token', scope: 'session', sensitive: true,
    }),
    dryRun: configField.boolean({
      default: false, description: 'One-off dry run', scope: 'session',
    }),
  },
});

describe('extension config scope', () => {
  it('keeps the scope on the resolved field descriptor', () => {
    expect(definition.fields.theme.scope).toBe('user');
    expect(definition.fields.layout.scope).toBe('project');
    expect(definition.fields.token.scope).toBe('session');
    expect(definition.fields.dryRun.scope).toBe('session');
  });

  it('rejects a sensitive field that is not session-scoped', () => {
    for (const scope of ['user', 'project']) {
      expect(() => defineExtensionConfig({
        id: 'bad',
        title: 'Bad',
        fields: {
          secret: configField.string({
            default: '', description: 'secret', scope, sensitive: true,
          }),
        },
      })).toThrow();
    }
  });

  it('accepts a sensitive field that is session-scoped', () => {
    expect(() => defineExtensionConfig({
      id: 'ok',
      title: 'Ok',
      fields: {
        secret: configField.string({
          default: '', description: 'secret', scope: 'session', sensitive: true,
        }),
      },
    })).not.toThrow();
  });

  it('getPersistableExtensionConfig returns only fields matching the target', () => {
    expect(getPersistableExtensionConfig([definition], [], 'user').get('scoped'))
      .toEqual({ theme: 'dark' });
    expect(getPersistableExtensionConfig([definition], [], 'project').get('scoped'))
      .toEqual({ layout: { rows: 1 } });
  });

  it('getPersistableExtensionConfig never includes session-scoped fields', () => {
    for (const target of ['user', 'project']) {
      const keys = Object.keys(
        getPersistableExtensionConfig([definition], [], target).get('scoped') ?? {},
      );
      expect(keys).not.toContain('token');
      expect(keys).not.toContain('dryRun');
    }
  });

  it('getPersistableExtensionConfig applies overrides and freezes its output', () => {
    const project = getPersistableExtensionConfig([definition], [
      { extensionId: 'scoped', values: { layout: { rows: 3 } }, source: 'settings' },
    ], 'project');
    expect(project.get('scoped')).toEqual({ layout: { rows: 3 } });
    expect(Object.isFrozen(project.get('scoped'))).toBe(true);
  });
});
