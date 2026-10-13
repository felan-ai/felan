import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveInstalledDaemonEntrypoint } from '../src/daemon-entrypoint.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('client distribution wiring', () => {
  it('retains the binary and uses the exact installed daemon version', () => {
    const daemonEntrypoint = fileURLToPath(import.meta.resolve('@felan-ai/daemon'));
    const daemon = JSON.parse(readFileSync(join(dirname(daemonEntrypoint), '..', 'package.json'), 'utf8'));
    const entrypoint = fileURLToPath(import.meta.resolve('@felan-ai/felan/daemon-host'));
    expect(manifest.name).toBe('@felan-ai/felan');
    expect(manifest.bin).toEqual({ felan: './dist/cli.js' });
    expect(manifest.dependencies['@felan-ai/daemon']).toBe(`workspace:${daemon.version}`);
    expect(manifest.exports).not.toHaveProperty('./daemon-profile');
    expect(manifest.exports['./daemon-host']).toEqual({ types: './dist/daemon-host.d.ts', import: './dist/daemon-host.js' });
    expect(manifest.exports['./providers/runtime']).toEqual({ types: './dist/providers/runtime.d.ts', import: './dist/providers/runtime.js' });
    expect(manifest.exports['./providers/models']).toEqual({ types: './dist/providers/models.d.ts', import: './dist/providers/models.js' });
    expect(manifest.exports['./providers/secrets']).toEqual({ types: './dist/providers/secrets.d.ts', import: './dist/providers/secrets.js' });
    expect(readFileSync(join(root, 'src/daemon-host.ts'), 'utf8')).not.toMatch(/tui|acp|presenter/iu);
    expect(readFileSync(join(root, 'src/providers/runtime.ts'), 'utf8')).not.toMatch(/tui|acp|presenter/iu);
    const host = JSON.parse(readFileSync(join(root, 'src/host.json'), 'utf8'));
    expect(host.services).toContainEqual({ id: 'felan.runtime', major: 1, use: '@felan-ai/felan/providers/runtime' });
    expect(host.services).toContainEqual({ id: 'felan.models', major: 1, use: '@felan-ai/felan/providers/models' });
    expect(host.services).toContainEqual({ id: 'felan.secrets', major: 1, use: '@felan-ai/felan/providers/secrets' });
    expect(realpathSync(resolveInstalledDaemonEntrypoint())).toBe(realpathSync(entrypoint));
  });

  it('resolves the installed entrypoint independently of the launch cwd', () => {
    const module = new URL('../dist/daemon-entrypoint.js', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval',
      `import { resolveInstalledDaemonEntrypoint } from ${JSON.stringify(module)}; process.stdout.write(resolveInstalledDaemonEntrypoint());`,
    ], { cwd: tmpdir(), encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(realpathSync(result.stdout)).toBe(realpathSync(resolveInstalledDaemonEntrypoint()));
  });
});
