import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTheme } from '@earendil-works/pi-coding-agent';
import type { SettingsManager } from '@felan-ai/agent-core';
import type { Component } from '@earendil-works/pi-tui';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createClassifierModelSettings } from '../src/classifier-settings.js';
import { installFelanSettingsCommand } from '../src/extension-settings.js';
import { createLocalSettingsManager, getClassifierModelSetting, setClassifierModelSetting } from '../src/settings.js';
import type { LocalClassifierModel } from '../src/classifier.js';

const paths: string[] = [];
beforeAll(() => initTheme('dark', false));
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
const model = { type: 'classifier', provider: 'openrouter', id: 'typesafe/jev-1.13' } as LocalClassifierModel;

async function setup(saved = 'auto') {
  const agentDir = await mkdtemp(join(tmpdir(), 'felan-classifier-settings-'));
  paths.push(agentDir);
  await setClassifierModelSetting(agentDir, saved);
  const settingsManager = createLocalSettingsManager(agentDir, agentDir);
  const modelRuntime = { getAvailableOfType: vi.fn().mockResolvedValue([model]) };
  const close = vi.fn();
  const render = vi.fn();
  return { agentDir, settingsManager, modelRuntime, close, render };
}

describe('classifier model settings', () => {
  it('shows loading, supports searching exact classifier references, and saves without changing the coding model', async () => {
    const h = await setup();
    h.settingsManager.setDefaultModel('coding-model');
    await h.settingsManager.flush();
    let release!: (models: LocalClassifierModel[]) => void;
    h.modelRuntime.getAvailableOfType.mockReturnValue(new Promise(resolve => { release = resolve; }));
    const component = createClassifierModelSettings(h, h.close, h.render);
    expect(component.render(120).join('\n')).toContain('Loading authenticated');
    expect(component.render(120).join('\n')).toContain('next new root session/restart');
    release([model]);
    await vi.waitFor(() => expect(component.render(120).join('\n')).toContain('openrouter/typesafe/jev-1.13'));
    component.handleInput?.('openrouter');
    component.handleInput?.('\r');
    component.handleInput?.('\r');
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledWith('openrouter/typesafe/jev-1.13'));
    expect(h.close).toHaveBeenCalledOnce();
    expect(h.render).toHaveBeenCalledTimes(3);
    expect(getClassifierModelSetting(h.settingsManager)).toBe('openrouter/typesafe/jev-1.13');
    expect(h.settingsManager.getDefaultModel()).toBe('coding-model');
    expect(h.modelRuntime.getAvailableOfType).toHaveBeenCalledWith('classifier');
  });

  it('preserves an unavailable saved model until Auto is explicitly chosen', async () => {
    const h = await setup('missing/model');
    h.modelRuntime.getAvailableOfType.mockResolvedValue([]);
    const component = createClassifierModelSettings(h, h.close, h.render);
    await vi.waitFor(() => expect(component.render(120).join('\n')).toContain('No authenticated classifier models'));
    expect(component.render(120).join('\n')).toContain('Saved: missing/model');
    expect(h.close).not.toHaveBeenCalled();
    expect(getClassifierModelSetting(h.settingsManager)).toBe('missing/model');
    component.handleInput?.('\r');
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledWith('auto'));
    expect(getClassifierModelSetting(h.settingsManager)).toBe('auto');
  });

  it('reports lookup failure without exposing provider text and Escape retains the saved choice', async () => {
    const h = await setup('missing/model');
    h.modelRuntime.getAvailableOfType.mockRejectedValue(new Error('secret-key'));
    const component = createClassifierModelSettings(h, h.close, h.render);
    await vi.waitFor(() => expect(component.render(120).join('\n')).toContain('lookup failed'));
    expect(component.render(120).join('\n')).not.toContain('secret-key');
    component.handleInput?.('\x1b');
    expect(h.close).toHaveBeenCalledWith();
    expect(getClassifierModelSetting(h.settingsManager)).toBe('missing/model');
  });

  it('ignores a late lookup after keyboard cancellation or disposal', async () => {
    for (const cancel of ['keyboard', 'dispose']) {
      const h = await setup();
      let release!: (models: LocalClassifierModel[]) => void;
      h.modelRuntime.getAvailableOfType.mockReturnValue(new Promise(resolve => { release = resolve; }));
      const component = createClassifierModelSettings(h, h.close, h.render);
      if (cancel === 'keyboard') component.handleInput?.('\x1b');
      else component.dispose();
      release([model]);
      await Promise.resolve();
      expect(h.render).not.toHaveBeenCalled();
      expect(getClassifierModelSetting(h.settingsManager)).toBe('auto');
    }
  });

  it('rolls back displayed selection when the atomic save fails', async () => {
    const h = await setup();
    const invalid = join(h.agentDir, 'file');
    await writeFile(invalid, 'not a directory');
    const manager = { getGlobalSettings: () => ({ felanClassifier: { model: 'auto' } }), reload: vi.fn() } as unknown as SettingsManager;
    const component = createClassifierModelSettings({ ...h, agentDir: invalid, settingsManager: manager }, h.close, h.render);
    await vi.waitFor(() => expect(component.render(120).join('\n')).toContain('openrouter/typesafe/jev-1.13'));
    component.handleInput?.('openrouter');
    component.handleInput?.('\r');
    await vi.waitFor(() => expect(component.render(120).join('\n')).toContain('Save failed'));
    expect(component.render(120).join('\n')).toContain('Saved: auto');
    expect(h.close).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(join(h.agentDir, 'settings.json'), 'utf8')).felanClassifier.model).toBe('auto');
    component.handleInput?.('\x1b');
    expect(h.close).toHaveBeenCalledWith();
  });

  it('adds the control to /settings and updates its value after returning from the picker', async () => {
    const h = await setup();
    let component: Component | undefined;
    const mode = {
      showSettingsSelector() {},
      showSelector(create: (done: () => void) => { component: Component }) { component = create(() => {}).component; },
      ui: { requestRender: h.render },
    };
    installFelanSettingsCommand(mode, { ...h, definitions: [] });
    mode.showSettingsSelector();
    expect(component!.render(120).join('\n')).toContain('Classifier model');
    component!.handleInput?.('classifier');
    component!.handleInput?.('\r');
    await vi.waitFor(() => expect(component!.render(120).join('\n')).toContain('openrouter/typesafe/jev-1.13'));
    component!.handleInput?.('openrouter');
    component!.handleInput?.('\r');
    await vi.waitFor(() => {
      const text = component!.render(120).join('\n');
      expect(text).not.toContain('Saved:');
      expect(text).toContain('Classifier model');
      expect(text).toContain('openrouter/typesafe/jev-1.13');
    });
  });
});
