import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SESSION_RUNTIME_SERVICE, DAEMON_VERSION } from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('daemon distribution boundary', () => {
  it('owns the runtime and provider contracts and independent package version', () => {
    expect(manifest.name).toBe('@felan-ai/daemon');
    expect(DAEMON_VERSION).toBe(manifest.version);
    expect(SESSION_RUNTIME_SERVICE.key).toBe('felan.session-runtime@1');
    expect(manifest.exports['./session-runtime']).toEqual({
      types: './dist/daemon/session-runtime.d.ts', import: './dist/daemon/session-runtime.js',
    });
    expect(manifest.exports['./provider']).toEqual({
      types: './dist/daemon/provider.d.ts', import: './dist/daemon/provider.js',
    });
    expect(manifest.exports).not.toHaveProperty('./daemon-profile');
  });

  it('publishes lightweight version and host configuration entrypoints with matching types', async () => {
    expect(manifest.exports['./version']).toEqual({
      types: './dist/version.d.ts', import: './dist/version.js',
    });
    expect(manifest.exports['./host-config']).toEqual({
      types: './dist/daemon/host-config.d.ts', import: './dist/daemon/host-config.js',
    });
    expect(import.meta.resolve('@felan-ai/daemon/version')).toBe(new URL('../dist/version.js', import.meta.url).href);
    expect(import.meta.resolve('@felan-ai/daemon/host-config')).toBe(new URL('../dist/daemon/host-config.js', import.meta.url).href);
    const version = await import('@felan-ai/daemon/version');
    const config = await import('@felan-ai/daemon/host-config');
    expect(manifest.exports['./host-token']).toEqual({ types: './dist/host-token.d.ts', import: './dist/host-token.js' });
    const hostToken = await import('@felan-ai/daemon/host-token');
    expect(hostToken.HostTokenSource).toBeTypeOf('function');
    expect(hostToken.HostTokenExchangeError).toBeTypeOf('function');
    expect(version.DAEMON_VERSION).toBe(manifest.version);
    expect(config.loadHostConfig).toBeTypeOf('function');
    expect(config.resolveHostComposition).toBeTypeOf('function');
  });

  it('keeps native ownership without direct feature or renderer dependencies', () => {
    expect(manifest.dependencies.koffi).toBe('3.3.2');
    expect(manifest.dependencies).not.toHaveProperty('@earendil-works/pi-tui');
    expect(Object.keys(manifest.dependencies).filter(name => name.startsWith('@felan-ai/ext-'))).toEqual([]);
  });
});
