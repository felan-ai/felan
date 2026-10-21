import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadHostConfig, resolveHostComposition, validPackageSpecifier, type HostConfig } from '../src/daemon/host-config.js';

const roots: string[] = [];
const config = (extensions: string[] = []) => JSON.stringify({ version: 1, services: [], extensions: extensions.map(packageName => ({ package: packageName })), policy: { projectTrust: 'ask' } });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(process.cwd(), '.host-config-test-'));
  roots.push(root);
  await mkdir(join(root, 'agent'), { mode: 0o700 });
  await mkdir(join(root, 'manager'), { mode: 0o700 });
  return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('trusted host configuration', () => {
  it('accepts an optional positive integer interaction hold in seconds', async () => {
    const root = await fixture(); const agentDir = join(root, 'agent');
    const save = (policy: unknown) => writeFile(join(agentDir, 'host.json'), JSON.stringify({
      version: 1, services: [], extensions: [], policy,
    }), { mode: 0o600 });
    await save({});
    expect((await loadHostConfig({ agentDir })).config.policy?.interactionHoldSeconds).toBeUndefined();
    for (const interactionHoldSeconds of [1, 600]) {
      await save({ interactionHoldSeconds });
      expect((await loadHostConfig({ agentDir })).config.policy?.interactionHoldSeconds).toBe(interactionHoldSeconds);
    }
    for (const interactionHoldSeconds of [0, -1, 0.5, '600', null, Number.MAX_SAFE_INTEGER + 1]) {
      await save({ interactionHoldSeconds });
      await expect(loadHostConfig({ agentDir })).rejects.toMatchObject({ code: 'invalid_host_config' });
    }
  });

  it('loads optional authoritative remote settings and rejects malformed or duplicate projects', async () => {
    const root = await fixture(); const agentDir = join(root, 'agent');
    const remote = { share: 'all', projects: [{ id: 'workspace', name: 'Team workspace', path: '/home/agent/workspace' }] };
    const save = (value: unknown) => writeFile(join(agentDir, 'host.json'), JSON.stringify({ version: 1, services: [], extensions: [], remote: value }), { mode: 0o600 });
    await save(remote);
    expect((await loadHostConfig({ agentDir })).config.remote).toEqual(remote);
    await save({ share: 'on-request', projects: [] });
    expect((await loadHostConfig({ agentDir })).config.remote).toEqual({ share: 'on-request', projects: [] });
    for (const value of [
      { ...remote, share: 'none' }, { ...remote, token: 'secret' },
      { ...remote, projects: [{ ...remote.projects[0], path: 'relative' }] },
      { ...remote, projects: [{ ...remote.projects[0], path: '/a/../b' }] },
      { ...remote, projects: [remote.projects[0], { ...remote.projects[0], path: '/other' }] },
      { ...remote, projects: [remote.projects[0], { ...remote.projects[0], id: 'other' }] },
    ]) {
      await save(value);
      await expect(loadHostConfig({ agentDir })).rejects.toMatchObject({ code: 'invalid_host_config' });
    }
  });

  it('uses explicit, agent-directory and launcher-supplied defaults in order without writing files', async () => {
    const root = await fixture();
    const explicit = join(root, 'explicit.json');
    const agent = join(root, 'agent', 'host.json');
    const packaged = join(root, 'manager', 'host.json');
    await writeFile(explicit, config(['@felan-ai/explicit']), { mode: 0o600 });
    await writeFile(agent, config(['@felan-ai/agent']), { mode: 0o600 });
    await writeFile(packaged, config(['@felan-ai/packaged']), { mode: 0o600 });
    const selected = await loadHostConfig({ agentDir: join(root, 'agent'), explicitPath: explicit, packagedDefaultPath: packaged });
    expect(selected.source).toMatchObject({ kind: 'explicit', path: explicit });
    expect(selected.config.extensions[0]?.package).toBe('@felan-ai/explicit');
    const fromAgent = await loadHostConfig({ agentDir: join(root, 'agent'), packagedDefaultPath: packaged });
    expect(fromAgent.source.kind).toBe('agent-directory');
    const fallback = await fixture();
    const fromPackage = await loadHostConfig({ agentDir: join(fallback, 'agent'), packagedDefaultPath: packaged });
    expect(fromPackage.source.kind).toBe('packaged-default');
    expect(fromPackage.config.extensions[0]?.package).toBe('@felan-ai/packaged');
    await expect(loadHostConfig({ agentDir: join(root, 'missing-agent') })).rejects.toThrow('no default configuration');
  });

  it('rejects writable or malformed input, duplicate providers and unknown keys', async () => {
    const root = await fixture();
    const agentDir = join(root, 'agent');
    const target = join(root, 'target.json');
    const link = join(root, 'link.json');
    await writeFile(target, config(), { mode: 0o600 });
    await symlink(target, link);
    expect((await loadHostConfig({ agentDir, explicitPath: link })).source.path).toBe(link);
    await expect(loadHostConfig({ agentDir, explicitPath: 'relative.json' })).rejects.toThrow('absolute path');
    await writeFile(join(agentDir, 'host.json'), JSON.stringify({ version: 1, services: [], extensions: [], unexpected: true }), { mode: 0o600 });
    await expect(loadHostConfig({ agentDir })).rejects.toThrow('Schema validation failed');
    await writeFile(join(agentDir, 'host.json'), JSON.stringify({ version: 1, services: [
      { id: 'felan.models', major: 1, use: '@test/provider' }, { id: 'felan.models', major: 1, use: '@test/other' },
    ], extensions: [] }), { mode: 0o600 });
    await expect(loadHostConfig({ agentDir })).rejects.toThrow('more than one configured provider');
    await writeFile(join(agentDir, 'host.json'), config());
    await chmod(join(agentDir, 'host.json'), 0o664);
    await expect(loadHostConfig({ agentDir })).rejects.toThrow('not group or world writable');
    await chmod(join(agentDir, 'host.json'), 0o644);
    await writeFile(join(agentDir, 'host.json'), 'x'.repeat(64), { mode: 0o600 });
    await expect(loadHostConfig({ agentDir })).rejects.toThrow('not valid JSON');
  });

  it('accepts package export specifiers and refuses paths, URLs and traversal', () => {
    for (const specifier of ['@felan-ai/ext-browser', '@felan-ai/felan/providers/chrome', 'provider-name/subpath']) expect(validPackageSpecifier(specifier)).toBe(true);
    for (const specifier of ['./provider.js', '../provider', '/tmp/provider.js', 'file:///tmp/provider.js', 'https://example.test/provider', 'node:fs', '@scope/package/../provider', '@scope']) expect(validPackageSpecifier(specifier)).toBe(false);
  });

  it('rejects credential-looking provider options instead of persisting secrets in host.json', async () => {
    const root = await fixture();
    const agentDir = join(root, 'agent');
    await writeFile(join(agentDir, 'host.json'), JSON.stringify({ version: 1, services: [{ id: 'felan.platform', major: 1,
      use: '@felan-ai/felan/providers/platform', options: { apiKey: 'synthetic-secret' } }], extensions: [] }), { mode: 0o600 });
    await expect(loadHostConfig({ agentDir })).rejects.toThrow('cannot contain credential values');
    await writeFile(join(agentDir, 'host.json'), JSON.stringify({ version: 1, services: [{ id: 'felan.platform', major: 1,
      use: '@felan-ai/felan/providers/platform', options: { maxTokens: 4096, tokenizer: 'default' } }], extensions: [] }), { mode: 0o600 });
    await expect(loadHostConfig({ agentDir })).resolves.toMatchObject({ config: { services: [{ options: { maxTokens: 4096 } }] } });
  });

  it('validates extension grants as bounded service contract references', async () => {
    const root = await fixture();
    const agentDir = join(root, 'agent');
    await writeFile(join(agentDir, 'host.json'), JSON.stringify({ version: 1, services: [], extensions: [
      { package: '@felan-ai/ext-browser', grants: ['not a contract'] },
    ] }), { mode: 0o600 });
    await expect(loadHostConfig({ agentDir })).rejects.toThrow('invalid service grant');
  });

  it('resolves only configured exports from the manager installation anchor and fingerprints the composition', async () => {
    const root = await fixture();
    const packaged = join(root, 'manager', 'host.json');
    await writeFile(packaged, config(), { mode: 0o600 });
    const hostPath = join(root, 'agent', 'host.json');
    await writeFile(hostPath, JSON.stringify({ version: 1, services: [{ id: 'felan.models', major: 1, use: '@felan-ai/agent-core' }], extensions: [] }), { mode: 0o600 });
    const loaded = await loadHostConfig({ agentDir: join(root, 'agent') });
    const manager = { packageName: '@felan-ai/felan', version: '0.29.0', resolveFrom: new URL('../../felan/src/daemon-entrypoint.js', import.meta.url).href };
    const composition = await resolveHostComposition(loaded, manager);
    expect(composition.providers).toHaveLength(1);
    expect(composition.providers[0]?.moduleUrl).toMatch(/^file:/u);
    expect(composition.managerPackage).toBe('@felan-ai/felan');
    expect(composition.configDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(composition.configDigest).toBe((await resolveHostComposition(loaded, manager)).configDigest);
    const policyChanged = { ...loaded, config: { ...loaded.config, policy: { projectTrust: 'deny' as const } } };
    const policyComposition = await resolveHostComposition(policyChanged, manager);
    expect(policyComposition.providerDigest).toBe(composition.providerDigest);
    expect(policyComposition.configDigest).not.toBe(composition.configDigest);
    const providerChanged = { ...loaded, config: { ...loaded.config, services: [{ id: 'felan.models', major: 1, use: '@felan-ai/session-protocol' }] } };
    const providerComposition = await resolveHostComposition(providerChanged, manager);
    expect(providerComposition.providerDigest).not.toBe(composition.providerDigest);
    await expect(resolveHostComposition(loaded, { ...manager, resolveFrom: 'https://example.invalid/host.js' })).rejects.toThrow('file URL');
    const unavailable = await loadHostConfig({ agentDir: join(root, 'missing-agent'), packagedDefaultPath: packaged });
    const altered = { ...unavailable, config: { ...unavailable.config, services: [{ id: 'felan.models', major: 1, use: '@not-installed/provider' }] } as HostConfig };
    await expect(resolveHostComposition(altered, manager)).rejects.toThrow('not exported by the managing installation');
  });
});
