import { expect, it } from 'vitest';
import { CommandCatalogEntrySchema, parseSchema } from '../src/index.js';

it('preserves explicit command and skill source scopes', () => {
  for (const kind of ['extension', 'skill']) for (const scope of ['temporary', 'project', 'user']) {
    const entry = { name: 'example', description: 'Example', source: '/unrelated/path', kind, scope };
    expect(parseSchema(CommandCatalogEntrySchema, entry)).toEqual(entry);
  }
  expect(() => parseSchema(CommandCatalogEntrySchema, {
    name: 'example', description: '', source: 'inline', kind: 'extension', scope: 'guessed',
  })).toThrow();
});
