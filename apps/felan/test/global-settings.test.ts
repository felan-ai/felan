import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { isDependencyOnboardingComplete, mergeDaemonGlobalSettings, readDaemonGlobalSettings } from '../src/providers/global-settings.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(settings: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-approvals-')); directories.push(directory);
  await writeFile(join(directory, 'settings.json'), JSON.stringify(settings));
  return directory;
}

it('keeps numeric onboarding checks compatible and requires an exact runtime version when supplied', () => {
  const settings = { felanTui: { onboarding: { schemaVersion: 1, extensions: { claudeCode: 1 }, runtimeVersions: { claudeCode: '0.3.322' } } } };
  expect(isDependencyOnboardingComplete(settings, 'claudeCode', 1)).toBe(true);
  expect(isDependencyOnboardingComplete(settings, 'claudeCode', 1, '0.3.322')).toBe(true);
  expect(isDependencyOnboardingComplete(settings, 'claudeCode', 1, '0.3.323')).toBe(false);
  expect(isDependencyOnboardingComplete(settings, 'claudeCode', 2, '0.3.322')).toBe(false);
  for (const runtimeVersions of [undefined, null, [], '0.3.322', {}, { claudeCode: 322 }]) {
    const withoutVersion = { felanTui: { onboarding: { schemaVersion: 1, extensions: { claudeCode: 1 }, runtimeVersions } } };
    expect(isDependencyOnboardingComplete(withoutVersion, 'claudeCode', 1)).toBe(true);
    expect(isDependencyOnboardingComplete(withoutVersion, 'claudeCode', 1, '0.3.322')).toBe(false);
  }
});

it('preserves other dependency versions and unrelated settings when saving versioned or numeric decisions', async () => {
  const directory = await fixture({ defaultModel: 'model', felanTui: { toolDisplay: 'full', onboarding: {
    schemaVersion: 1, extensions: { browser: 2 }, runtimeVersions: { browser: '1.0.0' },
  } } });
  await Promise.all([
    mergeDaemonGlobalSettings(directory, { extensions: [], dependencyDecisions: [{ extension: 'claudeCode', revision: 1, enabled: true, version: '0.3.322' }] }, () => {}),
    mergeDaemonGlobalSettings(directory, { extensions: [], dependencyDecisions: [{ extension: 'markitdown', revision: 1, enabled: false }] }, () => {}),
  ]);
  await mergeDaemonGlobalSettings(directory, { extensions: [], dependencyDecisions: [{ extension: 'claudeCode', revision: 2, enabled: true }] }, () => {});
  expect(await readDaemonGlobalSettings(directory, () => {})).toEqual({
    defaultModel: 'model', builtinExtensions: { claudeCode: true, markitdown: false },
    felanTui: { toolDisplay: 'full', onboarding: { schemaVersion: 1,
      extensions: { browser: 2, claudeCode: 2, markitdown: 1 }, runtimeVersions: { browser: '1.0.0', claudeCode: '0.3.322' } } },
  });
});

it('does not add an empty runtime version map to numeric onboarding decisions', async () => {
  const directory = await fixture();
  await mergeDaemonGlobalSettings(directory, { extensions: [], dependencyDecisions: [{ extension: 'browser', revision: 2, enabled: false }] }, () => {});
  expect(await readDaemonGlobalSettings(directory, () => {})).toEqual({
    builtinExtensions: { browser: false }, felanTui: { onboarding: { schemaVersion: 1, extensions: { browser: 2 } } },
  });
});

it.each(['', '  ', '0.3.322\n', '\u001b[31m0.3.322', '0.3.322\u0085', 'v'.repeat(129), 322, null])('rejects invalid runtime approval version %j without changing settings', async version => {
  const directory = await fixture({ defaultModel: 'unchanged' });
  const before = await readFile(join(directory, 'settings.json'), 'utf8');
  await expect(mergeDaemonGlobalSettings(directory, { extensions: [], dependencyDecisions: [
    { extension: 'claudeCode', revision: 1, enabled: true, version: version as string },
  ] }, () => {})).rejects.toThrow('Invalid dependency decisions.');
  expect(await readFile(join(directory, 'settings.json'), 'utf8')).toBe(before);
  expect(isDependencyOnboardingComplete({ felanTui: { onboarding: {
    schemaVersion: 1, extensions: { claudeCode: 1 }, runtimeVersions: { claudeCode: version },
  } } }, 'claudeCode', 1, version as string)).toBe(false);
});
