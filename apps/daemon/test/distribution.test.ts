import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DAEMON_PROFILE_API_VERSION, DAEMON_VERSION } from '../src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('daemon distribution boundary', () => {
  it('owns the profile contract and independent package version', () => {
    expect(manifest.name).toBe('@felan-ai/daemon');
    expect(DAEMON_VERSION).toBe(manifest.version);
    expect(DAEMON_PROFILE_API_VERSION).toBe(1);
    expect(manifest.exports['./daemon-profile']).toEqual({
      types: './dist/daemon/profile.d.ts', import: './dist/daemon/profile.js',
    });
  });

  it('has no dependency or source import back into the client application', () => {
    for (const dependencies of [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies]) {
      expect(dependencies ?? {}).not.toHaveProperty('@felan-ai/felan');
    }
    for (const path of sourceFiles(join(root, 'src'))) {
      const source = readFileSync(path, 'utf8');
      expect(source, path).not.toMatch(/(?:from\s*|import\s*\()\s*['"][^'"]*(?:@felan-ai\/felan(?:\/|['"])|felan\/src\/)/u);
    }
  });

  it('keeps native ownership and the current mixed presenters in the daemon', () => {
    expect(manifest.dependencies.koffi).toBe('3.3.2');
    expect(manifest.dependencies['@earendil-works/pi-tui']).toBe('catalog:pi');
  });
});
