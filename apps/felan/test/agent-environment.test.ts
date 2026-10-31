import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { daemonTargetAgentDir, loadAgentEnvironment } from '../src/agent-environment.js';
import { createLocalPlatformService } from '../src/providers/platform.js';

const paths: string[] = [];

afterEach(async () => {
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function agentDirectory() {
  const agentDir = await mkdtemp(join(tmpdir(), 'felan-env-'));
  paths.push(agentDir);
  return agentDir;
}

describe('agent directory .env', () => {
  it('overrides inherited variables and keeps the rest of the environment', async () => {
    const agentDir = await agentDirectory();
    await writeFile(join(agentDir, '.env'), '# key\nFELAN_API_KEY="from-file"\nFELAN_TEAM_SLUG=acme\n');
    const environment: NodeJS.ProcessEnv = { FELAN_API_KEY: 'inherited', PATH: '/bin' };

    expect(loadAgentEnvironment(agentDir, environment)).toBe(true);

    expect(environment).toEqual({ FELAN_API_KEY: 'from-file', FELAN_TEAM_SLUG: 'acme', PATH: '/bin' });
    expect(createLocalPlatformService(environment)).toBeDefined();
  });

  it('ignores a missing file and reports an unreadable one', async () => {
    const agentDir = await agentDirectory();
    const environment: NodeJS.ProcessEnv = { PATH: '/bin' };
    expect(loadAgentEnvironment(agentDir, environment)).toBe(true);
    await mkdir(join(agentDir, '.env'));
    expect(loadAgentEnvironment(agentDir, environment)).toBe(false);
    expect(environment).toEqual({ PATH: '/bin' });
  });

  it('resolves the agent directory from the daemon launch target', () => {
    expect(daemonTargetAgentDir(JSON.stringify({ kind: 'production', agentDir: '/home/u/.felan', storeRoots: [] }))).toBe('/home/u/.felan');
    expect(daemonTargetAgentDir(JSON.stringify({ kind: 'isolated', directory: '/tmp/fixture', namespaceId: 'n' }))).toBe('/tmp/fixture/agent');
    expect(daemonTargetAgentDir('not json')).toBeUndefined();
    expect(daemonTargetAgentDir(undefined)).toBeUndefined();
  });
});
