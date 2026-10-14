import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { DaemonConfiguration } from '../../src/providers/configuration.js';
import { createDaemonSettingsManager } from '../../src/providers/global-settings.js';

const paths: string[] = [];
afterEach(async () => { await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(settings: object = {}) {
  const root = await mkdtemp(join(tmpdir(), 'thinking-default-')); paths.push(root);
  const agent = join(root, 'agent'); await mkdir(agent);
  const agentDir = await realpath(agent); const path = join(agentDir, 'settings.json');
  await writeFile(path, JSON.stringify(settings), { mode: 0o600 });
  return { agentDir, path, config: new DaemonConfiguration({ agentDir, definitions: [], assertCurrent() {} }) };
}

it('resolves the requested model override before the global default, without inventing one', async () => {
  const { config } = await fixture();
  expect((await config.get('global', { provider: 'p', id: 'm' })).values.defaultThinking).toBeUndefined();
  await config.set('global', { defaultThinking: 'medium', modelThinkingLevels: { 'p/m': 'xhigh' } });
  expect((await config.get('global', { provider: 'p', id: 'm' })).values.defaultThinking).toBe('xhigh');
  expect((await config.get('global', { provider: 'p', id: 'other' })).values.defaultThinking).toBe('medium');
  expect((await config.get('global')).values.defaultThinking).toBe('medium');
});

it('preserves daemon defaults across subsequent writes from a stale Pi SettingsManager', async () => {
  const { config, agentDir, path } = await fixture({ theme: 'felan-dark', defaultThinkingLevel: 'low', custom: { retained: true } });
  const manager = createDaemonSettingsManager(agentDir, agentDir);
  manager.setTheme('felan-light'); await manager.flush();
  await config.set('global', { defaultThinking: 'xhigh', defaultModel: 'p/m' });
  manager.setTheme('felan-dark'); await manager.flush();
  expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ theme: 'felan-dark', defaultThinkingLevel: 'xhigh',
    defaultProvider: 'p', defaultModel: 'm', custom: { retained: true } });
  expect(manager.getDefaultThinkingLevel()).toBe('low');
  expect(createDaemonSettingsManager(agentDir, agentDir).getDefaultThinkingLevel()).toBe('xhigh');
});
