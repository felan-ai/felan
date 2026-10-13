import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { configField, defineExtensionConfig, getExtensionConfigCliOptions } from '@felan-ai/agent-core';
import { ConfigValuesSchema } from '@felan-ai/session-protocol';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { acquireLocalFileLock } from '../../daemon/src/lock.js';
import { mergeDaemonGlobalSettings } from '../src/providers/global-settings.js';

const definition = defineExtensionConfig({ id: 'codex', title: 'Synthetic configuration', fields: {
  fast: configField.boolean({ default: false, description: 'Synthetic option' }),
  priority: configField.enum(['normal', 'fast', 'ultrafast'], { default: 'normal', description: 'Synthetic priority' }),
} });
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(initial: unknown = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 's7-config-'))); directories.push(directory);
  const agentDir = join(directory, 'agent'); await mkdir(agentDir, { mode: 0o700 });
  const path = join(agentDir, 'settings.json'); await writeFile(path, JSON.stringify(initial), { mode: 0o600 });
  let guard = () => {};
  const assertCurrent = () => guard();
  const config = new DaemonConfiguration({ agentDir, definitions: [definition], assertCurrent });
  return { directory, agentDir, path, config, assertCurrent, setGuard: (next: () => void) => { guard = next; },
    read: async () => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown> };
}

describe('daemon locked configuration', () => {
  it('prepares session-only field merges without writing global settings', async () => {
    const f = await fixture(); const before = await readFile(f.path);
    const first = f.config.sessionOverrides({ 'codex-fast': true });
    const second = f.config.sessionOverrides({ 'codex-priority': 'fast' }, first);
    expect(second).toEqual([{ extensionId: 'codex', source: 'CLI', values: { fast: true, priority: 'fast' } }]);
    expect((await f.config.sessionValues(second)).values).toMatchObject({ 'codex-fast': true, 'codex-priority': 'fast' });
    expect((await f.config.get('global')).values).toMatchObject({ 'codex-fast': false, 'codex-priority': 'normal' });
    expect(await readFile(f.path)).toEqual(before);
    expect(() => f.config.sessionOverrides({ defaultModel: 'offline/model' })).toThrow('global');
  });
  it('merges unrelated concurrent fields and preserves unknown settings and extension fields', async () => {
    const f = await fixture({ untouched: { future: true }, extensionConfig: { codex: { future: 'preserved' }, other: { enabled: true } } });
    await Promise.all([f.config.set('global', { 'codex-fast': true }), f.config.set('global', { 'codex-priority': 'fast' })]);
    expect(await f.read()).toEqual({ untouched: { future: true }, extensionConfig: { codex: { future: 'preserved', fast: true, priority: 'fast' }, other: { enabled: true } } });
    expect(await f.config.get('global')).toMatchObject({ values: { 'codex-fast': true, 'codex-priority': 'fast' } });
  });

  it('accepts two serialized writes to one field with last-writer-wins, without CAS', async () => {
    const f = await fixture();
    await f.config.set('global', { 'codex-priority': 'fast' });
    await f.config.set('global', { 'codex-priority': 'ultrafast' });
    expect((await f.config.get('global')).values['codex-priority']).toBe('ultrafast');
  });

  it('uses the existing model default fields without changing a live session or reloading settings', async () => {
    const f = await fixture({ keep: true });
    await f.config.set('global', { scopedModels: ['offline/model', 'other/*'], defaultModel: 'offline/model', defaultThinking: 'high' });
    expect(await f.read()).toEqual({ keep: true, enabledModels: ['offline/model', 'other/*'], defaultProvider: 'offline', defaultModel: 'model', defaultThinkingLevel: 'high' });
    expect((await f.config.get('global')).values).toMatchObject({ scopedModels: ['offline/model', 'other/*'], defaultModel: 'offline/model', defaultThinking: 'high' });
  });

  it('validates the entire update before touching an absent file or applying an earlier valid field', async () => {
    const f = await fixture(); await rm(f.path);
    await expect(f.config.set('global', { 'codex-fast': true, defaultModel: 'not-qualified' })).rejects.toThrow('exact provider/model-id');
    expect(existsSync(f.path)).toBe(false);
    await expect(f.config.set('global', { 'codex-fast': true, password: 'synthetic' })).rejects.toThrow();
    expect(existsSync(f.path)).toBe(false);
    await expect(mergeDaemonGlobalSettings(f.agentDir, { extensions: [
      { definition, field: 'fast', value: true }, { definition, field: 'priority', value: 'wrong' },
    ] }, f.assertCurrent)).rejects.toThrow();
    expect(existsSync(f.path)).toBe(false);
  });

  it('persists classifier and builtin patches without overwriting unrelated settings', async () => {
    const f = await fixture({ felanClassifier: { model: 'auto', future: true }, builtinExtensions: { memory: false }, keep: true });
    await Promise.all([
      f.config.set('global', { classifierModel: 'offline/classifier', builtinExtensions: { memory: true } }),
      f.config.set('global', { builtinExtensions: { contextView: false } }),
    ]);
    expect(await f.read()).toEqual({ felanClassifier: { model: 'offline/classifier', future: true },
      builtinExtensions: { memory: true, contextView: false }, keep: true });
    expect((await f.config.get('global')).values).toMatchObject({ classifierModel: 'offline/classifier', builtinExtensions: { memory: true, contextView: false } });
    await f.config.set('global', { classifierModel: 'auto' });
    expect((await f.config.get('global')).values.classifierModel).toBe('auto');
    for (const values of [{ classifierModel: 'auto' }, { builtinExtensions: { memory: false } }]) {
      expect(() => f.config.sessionOverrides(values)).toThrow('global');
    }
  });

  it('rejects invalid classifier and builtin values before writing any fields', async () => {
    const f = await fixture(); const before = await readFile(f.path);
    for (const values of [{ classifierModel: 'not-qualified' }, { classifierModel: 'auto\n' },
      { builtinExtensions: { memory: 'false' } }, { builtinExtensions: { '../memory': false } }]) {
      await expect(f.config.set('global', { 'codex-fast': true, ...values })).rejects.toThrow();
      expect(await readFile(f.path)).toEqual(before);
    }
  });

  it.each(['', '{broken', 'null', '[]', '"text"'])('rejects malformed/non-object global data %j without overwriting it', async content => {
    const f = await fixture(); await writeFile(f.path, content);
    await expect(f.config.set('global', { 'codex-fast': true })).rejects.toThrow();
    await expect(f.config.get('global')).rejects.toThrow();
    expect(await readFile(f.path, 'utf8')).toBe(content);
  });

  it('rejects malformed UTF-8 and excessive file bytes before a merge', async () => {
    const f = await fixture();
    for (const content of [Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]), Buffer.alloc(1024 * 1024 + 1, 32)]) {
      await writeFile(f.path, content);
      await expect(f.config.set('global', { 'codex-fast': true })).rejects.toThrow();
      expect(await readFile(f.path)).toEqual(content);
    }
  });

  it('rejects malformed extension containers without replacing their content', async () => {
    for (const initial of [{ extensionConfig: [] }, { extensionConfig: { codex: 'invalid' } }]) {
      const f = await fixture(initial); const original = await readFile(f.path);
      await expect(f.config.set('global', { 'codex-fast': true })).rejects.toThrow('must be an object');
      expect(await readFile(f.path)).toEqual(original);
    }
  });

  it('rejects project and other session configuration without inventing a target or store', async () => {
    const f = await fixture(); const original = await readFile(f.path);
    for (const scope of ['project', 'session'] as const) {
      await expect(f.config.get(scope)).rejects.toMatchObject({ code: 'unavailable' });
      await expect(f.config.set(scope, { 'codex-fast': true })).rejects.toMatchObject({ code: 'unavailable' });
    }
    expect(await readFile(f.path)).toEqual(original);
  });

  it('rechecks ownership after acquiring the settings lock and before rename', async () => {
    const f = await fixture(); const original = await readFile(f.path);
    let calls = 0; f.setGuard(() => { if (++calls === 3) throw new Error('ownership lost under lock'); });
    await expect(f.config.set('global', { 'codex-fast': true })).rejects.toThrow('ownership lost under lock');
    expect(await readFile(f.path)).toEqual(original);
    f.setGuard(() => { if (readdirSync(f.agentDir).some(name => name.endsWith('.tmp'))) throw new Error('ownership lost before rename'); });
    await expect(f.config.set('global', { 'codex-fast': true })).rejects.toThrow('ownership lost before rename');
    expect(await readFile(f.path)).toEqual(original);
    expect(readdirSync(f.agentDir).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('surfaces ownership loss after rename instead of claiming the write failed before effect', async () => {
    const f = await fixture();
    f.setGuard(() => { if (readFileSync(f.path, 'utf8').includes('"fast": true')) throw new Error('ownership lost after rename'); });
    await expect(f.config.set('global', { 'codex-fast': true })).rejects.toThrow('ownership lost after rename');
    expect(await f.read()).toEqual({ extensionConfig: { codex: { fast: true } } });
  });

  it('surfaces a held lock without overwriting settings', async () => {
    const f = await fixture(); const original = await readFile(f.path);
    const lock = await acquireLocalFileLock(f.path, { realpath: false });
    try { await expect(f.config.set('global', { 'codex-fast': true })).rejects.toMatchObject({ code: 'ELOCKED' }); }
    finally { await lock.release(); }
    expect(await readFile(f.path)).toEqual(original);
  });

  it('refuses symlink/hardlink targets and noncanonical agent aliases', async () => {
    const f = await fixture(); const outside = join(f.directory, 'untouched.json'); await writeFile(outside, '{"keep":true}');
    await rm(f.path); await symlink(outside, f.path);
    await expect(f.config.set('global', { 'codex-fast': true })).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('{"keep":true}');
    await rm(f.path); await link(outside, f.path);
    await expect(f.config.set('global', { 'codex-fast': true })).rejects.toThrow('Unsafe daemon settings file');
    const alias = join(f.directory, 'alias'); await symlink(f.agentDir, alias);
    await expect(new DaemonConfiguration({ agentDir: alias, definitions: [definition], assertCurrent() {} }).set('global', { 'codex-fast': true })).rejects.toThrow('canonical');
  });

  it('surfaces file I/O errors and permits a subsequent validated update', async () => {
    const f = await fixture(); await rm(f.path); await mkdir(f.path);
    await expect(f.config.set('global', { 'codex-fast': true })).rejects.toThrow();
    await rm(f.path, { recursive: true });
    await mergeDaemonGlobalSettings(f.agentDir, { extensions: [{ definition, field: 'fast', value: true }] }, () => {});
    expect(await f.read()).toEqual({ extensionConfig: { codex: { fast: true } } });
  });

  it('publishes generic metadata and values for fields outside the fixed CLI schema', async () => {
    const f = await fixture();
    const custom = defineExtensionConfig({ id: 'custom', title: 'Custom', fields: {
      active: configField.boolean({ default: false, description: 'Enable it', label: 'Active', cliName: false }),
      hidden: configField.string({ default: 'secret', description: 'Private', sensitive: true }),
      old: configField.boolean({ default: false, description: 'Old', deprecated: 'Use active' }),
    } });
    const config = new DaemonConfiguration({ agentDir: f.agentDir, definitions: [custom], assertCurrent: f.assertCurrent });
    const first = await config.get('global');
    expect(first.extensions).toEqual([{ id: 'custom', title: 'Custom', fields: [
      { id: 'active', label: 'Active', description: 'Enable it', type: 'boolean' },
      { id: 'hidden', label: 'hidden', description: 'Private', type: 'string', sensitive: true },
    ] }]);
    expect(first.values.extensionConfig).toEqual({ custom: { active: false } });
    expect(JSON.stringify(first)).not.toContain('secret');
    await config.set('global', { extensionConfig: { custom: { active: true } } });
    expect((await config.get('global')).values.extensionConfig).toEqual({ custom: { active: true } });
    const overrides = config.sessionOverrides({ extensionConfig: { custom: { active: false } } });
    expect((await config.sessionValues(overrides)).values.extensionConfig).toEqual({ custom: { active: false } });
    for (const values of [{ custom: { active: 'bad' } }, { custom: { hidden: 'bad' } }, { custom: { old: true } }, { missing: { active: true } }]) {
      await expect(config.set('global', { extensionConfig: values })).rejects.toThrow();
    }
  });

  it('persists code mode without replacing other code mode settings', async () => {
    const f = await fixture({ codemode: { mode: 'on', inlineBudget: 42 } });
    await f.config.set('global', { codemode: 'only' });
    expect((await f.read()).codemode).toEqual({ mode: 'only', inlineBudget: 42 });
    expect((await f.config.get('global')).values.codemode).toBe('only');
    expect(() => f.config.sessionOverrides({ codemode: 'off' })).toThrow('global');
  });
});
