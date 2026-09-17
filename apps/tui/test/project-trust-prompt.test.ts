import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import {
  applyProjectTrustChoice,
  createFelanProjectTrustStore,
  felanProjectTrustPath,
} from '../src/project-trust.js';
import {
  ProjectTrustPrompt,
  projectTrustPromptOptions,
  promptProjectTrust,
} from '../src/project-trust-prompt.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('project trust prompt', () => {
  it('persists trust, deny, parent, and skip decisions', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    const parent = join(root, 'workspace');
    const cwd = join(parent, 'nested');
    const sibling = join(root, 'other');
    await Promise.all([agentDir, cwd, sibling].map((path) => mkdir(path, { recursive: true })));

    const trusted = createFelanProjectTrustStore(agentDir);
    expect(applyProjectTrustChoice(trusted, cwd, 'trust')).toBe(true);
    expect(trusted.get(cwd)).toBe(true);

    const denied = createFelanProjectTrustStore(join(root, 'denied-agent'));
    expect(applyProjectTrustChoice(denied, cwd, 'deny')).toBe(false);
    expect(denied.get(cwd)).toBe(false);

    const parentStore = createFelanProjectTrustStore(join(root, 'parent-agent'));
    expect(applyProjectTrustChoice(parentStore, cwd, 'trust-parent')).toBe(true);
    expect(parentStore.get(cwd)).toBe(true);
    expect(parentStore.get(parent)).toBe(true);
    expect(parentStore.get(sibling)).toBeNull();

    const skipped = createFelanProjectTrustStore(join(root, 'skip-agent'));
    expect(applyProjectTrustChoice(skipped, cwd, 'skip')).toBeNull();
    await expect(readFile(felanProjectTrustPath(join(root, 'skip-agent')), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('selects the highlighted option and treats escape as skip', () => {
    const cwd = '/tmp/felan-project/nested';
    const done = vi.fn();
    const prompt = new ProjectTrustPrompt({ requestRender: vi.fn() }, projectTrustPromptOptions(cwd), done);

    const lines = prompt.render(80).join('\n');
    expect(lines).toContain('Trust this folder');
    expect(lines).toContain('Trust parent folder');
    expect(lines).toContain('Do not trust');
    expect(lines).toContain(dirname(cwd));

    prompt.handleInput('\u001b[B');
    prompt.handleInput('\r');
    expect(done).toHaveBeenCalledExactlyOnceWith('trust-parent');

    const skipped = vi.fn();
    new ProjectTrustPrompt({ requestRender: vi.fn() }, projectTrustPromptOptions(cwd), skipped)
      .handleInput('\u001b');
    expect(skipped).toHaveBeenCalledExactlyOnceWith('skip');
  });

  it('injects the prompt without starting a TUI and truncates to width', async () => {
    const root = await temporaryDirectory();
    const agentDir = join(root, '.felan');
    const cwd = join(root, 'workspace', 'nested');
    await Promise.all([agentDir, cwd].map((path) => mkdir(path, { recursive: true })));
    const store = createFelanProjectTrustStore(agentDir);

    await expect(promptProjectTrust({
      cwd,
      agentDir,
      store,
      prompt: async () => 'trust',
    })).resolves.toBe(true);
    expect(store.get(cwd)).toBe(true);

    const prompt = new ProjectTrustPrompt(
      { requestRender: vi.fn() },
      projectTrustPromptOptions(cwd),
      vi.fn(),
    );
    expect(prompt.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-tui-project-trust-prompt-'));
  temporaryPaths.push(path);
  return path;
}
