import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SettingsManager } from '@felan-ai/agent-core';
import { stripTerminalSequences, type TUI } from '@earendil-works/pi-tui';
import { DaemonConfiguration } from '../src/providers/configuration.js';
import { ClientThemes } from '../src/tui/theme-config.js';
import { ClientPreferencesStore } from '../src/tui/preferences-store.js';
import { TerminalPreferences } from '../src/tui/preferences.js';
import type { TuiSessionController } from '../src/tui/controller.js';
import { AgentTranscript } from '../src/subagents/agent-transcript.js';
import { startupHeader } from '../src/tui/startup-header.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { defaultClientTheme } from '../src/tui/theme.js';
import { localSessionConfiguration } from '../src/providers/session-configuration.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), 'general-settings-'))); roots.push(agentDir);
  const file = join(agentDir, 'settings.json');
  await writeFile(file, JSON.stringify({ compaction: { reserveTokens: 1234 }, markdown: { codeBlockIndent: ' ' }, keep: true }));
  const configuration = new DaemonConfiguration({ agentDir, definitions: [], assertCurrent() {} });
  const display = new ClientPreferencesStore(agentDir);
  const controller = { notice: '', setNotice(value: string) { this.notice = value; }, perform: vi.fn(async (op: string, params: any) => {
    if (op === 'config.get') return { outcome: 'accepted', result: await configuration.get(params.scope) };
    if (op === 'config.set') await configuration.set(params.scope, params.values);
    return { outcome: 'accepted', result: {} };
  }) };
  const preferences = new TerminalPreferences(controller as unknown as TuiSessionController, {}, async () => {}, new ClientThemes(agentDir));
  return { agentDir, file, configuration, display, preferences, controller };
}

it('restores meaningful execution controls, persists Pi defaults and never applies them to the current session', async () => {
  const f = await fixture();
  const choices = { autoCompact: 'false', skillCommands: 'false', steeringMode: 'all', followUpMode: 'all', transport: 'sse',
    cacheWarming: 'idle', modelThinkingLevels: '{"offline/model":"high"}', httpIdleTimeoutMs: '0' };
  expect(await f.preferences.open({ settings: async entries => {
    const general = entries.find(entry => entry.id === 'general')!.children!;
    for (const value of ['', ' ', '0.5', '-1']) await expect(general.find(entry => entry.id === 'httpIdleTimeoutMs')!.change!(value)).rejects.toThrow();
    for (const [id, value] of Object.entries(choices)) {
      const entry = general.find(entry => entry.id === id)!;
      expect(entry, id).toBeDefined();
      expect(entry.description).toContain(id === 'httpIdleTimeoutMs' ? 'restart the daemon' : 'new sessions or /reload');
      await entry.change!(value);
    }
  } })).toBe(true);
  expect(f.controller.notice).toContain('Restart the daemon');
  const values = (await f.configuration.get('global')).values;
  expect(values).toMatchObject({ autoCompact: false, skillCommands: false, steeringMode: 'all', followUpMode: 'all', transport: 'sse',
    cacheWarming: 'idle', modelThinkingLevels: { 'offline/model': 'high' }, httpIdleTimeoutMs: 0 });
  for (const key of Object.keys(choices)) expect(() => f.configuration.sessionOverrides({ [key]: values[key as keyof typeof values] })).toThrow('global');
  const settings = SettingsManager.create(f.agentDir, f.agentDir, { projectTrusted: false });
  expect(settings.getCompactionEnabled()).toBe(false); expect(settings.getEnableSkillCommands()).toBe(false);
  expect(settings.getSteeringMode()).toBe('all'); expect(settings.getFollowUpMode()).toBe('all');
  expect(settings.getTransport()).toBe('sse'); expect(settings.getCacheWarmingMode()).toBe('idle');
  expect(settings.getModelThinkingLevel('offline', 'model')).toBe('high');
  expect(JSON.parse(await readFile(f.file, 'utf8'))).toMatchObject({ compaction: { enabled: false, reserveTokens: 1234 }, keep: true });
  expect(f.controller.perform.mock.calls.every(([op]) => !['session.set_model', 'session.set_thinking'].includes(op))).toBe(true);
});

it('restores client-only controls, preserves unrelated settings and reads them after reopening', async () => {
  const f = await fixture();
  const expected = { mermaid: 'final', quietStartup: 'header', fullscreenScrollbar: 'hidden', fullscreenCopyOnSelect: false, fullscreenWheelScrollLines: 5 };
  await f.preferences.open({ settings: async entries => {
    const general = entries.find(entry => entry.id === 'general')!.children!;
    for (const [id, value] of Object.entries(expected)) {
      const entry = general.find(entry => entry.id === id)!;
      expect(entry.description).toContain('Display only'); await entry.change!(String(value));
    }
  } });
  const reopened = new ClientPreferencesStore(f.agentDir); await reopened.load(); expect(reopened.values).toMatchObject(expected);
  expect(f.preferences.settings.mermaid).toBe('final');
  expect(JSON.parse(await readFile(f.file, 'utf8'))).toMatchObject({ markdown: { codeBlockIndent: ' ' }, keep: true });
  expect(f.controller.perform.mock.calls.some(([op]) => op === 'config.set')).toBe(false);
});

it('rejects invalid execution and display settings before changing any file', async () => {
  const f = await fixture(); const original = await readFile(f.file, 'utf8');
  for (const value of [{ autoCompact: 'true' }, { transport: 'invalid' }, { cacheWarming: 'always' }, { httpIdleTimeoutMs: -1 },
    { httpIdleTimeoutMs: 0.5 }, { modelThinkingLevels: { unqualified: 'high' } }, { modelThinkingLevels: { 'p/m': 'invalid' } }]) {
    await expect(f.configuration.set('global', value)).rejects.toThrow();
  }
  for (const value of [{ mermaid: 'always' }, { fullscreenWheelScrollLines: 0 }, { fullscreenWheelScrollLines: 101 }, { quietStartup: 'yes' }]) {
    await expect(f.display.update(value as never)).rejects.toThrow();
  }
  expect(await readFile(f.file, 'utf8')).toBe(original);
});

it('fingerprints execution defaults but not client display preferences', () => {
  const input = { packages: [], definitions: [], configs: new Map(), models: [], paths: [], skills: [], append: undefined };
  const fingerprint = (settings: object) => localSessionConfiguration({ ...input, settings: SettingsManager.inMemory(settings) });
  const baseline = fingerprint({});
  expect(fingerprint({ enableSkillCommands: false })).not.toEqual(baseline);
  expect(fingerprint({ cacheWarming: 'idle' })).not.toEqual(baseline);
  expect(fingerprint({ quietStartup: true, fullscreenScrollbar: 'hidden', markdown: { mermaid: 'off' } })).toEqual(baseline);
});

it('keeps quiet startup separate from command execution and displays only the requested header', () => {
  const theme = defaultClientTheme(); const keys = createClientKeybindings();
  expect(startupHeader(theme, keys, false, true)).toBe('');
  const header = stripTerminalSequences(startupHeader(theme, keys, false, 'header'));
  expect(header).toContain('Felan Code'); expect(header).not.toContain('commands');
  expect(stripTerminalSequences(startupHeader(theme, keys))).toContain('commands');
});

it.each(['off', 'final', 'streaming'] as const)('applies Mermaid %s to retained and streaming transcript rendering', mode => {
  const transcript = new AgentTranscript({ requestRender() {} } as unknown as TUI, { matches: () => false });
  const content = '```mermaid\ngraph TD\nA[Start] --> B[End]\n```';
  const base = { agentId: 'fixture', cwd: '/fixture', pendingTools: [], settings: { hideThinking: false, showImages: false, imageWidthCells: 60, outputPad: 1, toolMode: 'grouped' as const, mermaid: mode } };
  transcript.showProjection({ ...base, messages: [], streamingContent: [{ type: 'text', text: content }] });
  const streaming = stripTerminalSequences(transcript.render(80).join('\n'));
  expect(streaming.includes('graph TD')).toBe(mode !== 'streaming');
  transcript.showProjection({ ...base, messages: [{ role: 'assistant', content: [{ type: 'text', text: content }],
    api: 'openai-responses', provider: 'offline', model: 'model', stopReason: 'stop', timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }] });
  const final = stripTerminalSequences(transcript.render(80).join('\n'));
  expect(final).toContain('Start'); expect(final).toContain('End'); expect(final.includes('graph TD')).toBe(mode === 'off');
  transcript.dispose();
});
