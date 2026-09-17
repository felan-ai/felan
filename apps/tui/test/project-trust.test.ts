import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFelanProjectTrustStore,
  felanProjectTrustPath,
} from '../src/project-trust.js';
import { createLocalSettingsManager } from '../src/settings.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('Felan project trust store', () => {
  it('stores decisions under the Felan agent directory and inherits parent paths', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    const parent = join(root, 'workspace');
    const child = join(parent, 'nested');
    const sibling = join(root, 'other');
    await Promise.all([agentDir, child, sibling].map((path) => mkdir(path, { recursive: true })));

    const store = createFelanProjectTrustStore(agentDir);
    expect(store.get(parent)).toBeNull();
    expect(store.get(child)).toBeNull();

    store.set(parent, true);
    expect(store.get(parent)).toBe(true);
    expect(store.get(child)).toBe(true);
    expect(store.get(sibling)).toBeNull();

    store.set(parent, false);
    expect(store.get(parent)).toBe(false);
    expect(store.get(child)).toBe(false);
    expect(store.get(sibling)).toBeNull();

    const trustPath = felanProjectTrustPath(agentDir);
    expect(trustPath).toBe(join(agentDir, 'trust.json'));
    const persisted = JSON.parse(await readFile(trustPath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(persisted)).toHaveLength(1);
    expect(Object.values(persisted)).toEqual([false]);
    expect(Object.keys(persisted)[0]).toContain('workspace');
    expect(Object.keys(persisted)[0]).not.toContain('.pi');
  });

  it('does not un-stub the TUI settings manager project-trust hooks', async () => {
    const root = await temporaryDirectory();
    const cwd = join(root, 'workspace');
    const agentDir = join(root, '.felan');
    await Promise.all([cwd, agentDir].map((path) => mkdir(path, { recursive: true })));

    createFelanProjectTrustStore(agentDir).set(cwd, false);
    const settings = createLocalSettingsManager(cwd, agentDir);
    expect(settings.isProjectTrusted()).toBe(true);
    settings.setProjectTrusted(false);
    expect(settings.isProjectTrusted()).toBe(true);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-project-trust-'));
  temporaryPaths.push(path);
  return path;
}
