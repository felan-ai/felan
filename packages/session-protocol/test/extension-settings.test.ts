import { expect, it } from 'vitest';
import { ConfigValuesSchema, parseOperationResult, parseSchema } from '../src/index.js';

it('accepts generic extension values and a renderer-neutral settings catalog', () => {
  const values = { extensionConfig: { thirdParty: { enabled: true, nested: { paths: ['a'] } } }, codemode: 'only' };
  expect(parseSchema(ConfigValuesSchema, values)).toEqual(values);
  const result = { writable: false, values, extensions: [{ id: 'thirdParty', title: 'Third party', fields: [
    { id: 'enabled', label: 'Enabled', description: 'Enable this extension', type: 'boolean' },
    { id: 'nested', label: 'Paths', description: 'Configuration', type: 'json' },
    { id: 'credential', label: 'Credential', description: 'Protected', type: 'string', sensitive: true },
  ] }] };
  expect(parseOperationResult('config.get', result)).toEqual(result);
});

it('rejects invalid generic settings data at the protocol boundary', () => {
  for (const value of [{ codemode: 'invalid' }, { extensionConfig: { thirdParty: { number: Infinity } } },
    { extensionConfig: JSON.parse('{"thirdParty":{"__proto__":true}}') }]) {
    expect(() => parseSchema(ConfigValuesSchema, value)).toThrow();
  }
  expect(() => parseOperationResult('config.get', { values: {}, extensions: [{ id: 'example', title: 'Example', fields: [
    { id: 'enabled', label: 'Enabled', description: '', type: 'executable' },
  ] }] })).toThrow();
});

it('requires explicit writability for the requested scope', () => {
  expect(() => parseOperationResult('config.get', { values: {} })).toThrow();
  for (const writable of [true, false]) expect(parseOperationResult('config.get', { values: {}, writable }).writable).toBe(writable);
});
