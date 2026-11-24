import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { CLAUDE_CODE_MODELS, applyLongContext, longContextSettings } from '../src/bridge/models.js';
import { CLAUDE_CODE_PROVIDER_ID, claudeCodeHostProvider } from '../src/provider.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function hostModels() {
  const directory = await mkdtemp(join(tmpdir(), 'claude-code-provider-'));
  directories.push(directory);
  const authPath = join(directory, 'auth.json');
  const models = await ModelRuntime.create({ authPath, modelsPath: join(directory, 'models.json') });
  models.registerProvider(CLAUDE_CODE_PROVIDER_ID, claudeCodeHostProvider());
  const claudeCode = async () => (await models.getAvailable()).filter(model => model.provider === CLAUDE_CODE_PROVIDER_ID);
  return { authPath, claudeCode };
}

describe('Claude Code host provider', () => {
  it('lists the bridge models only while a claude-code credential is stored', async () => {
    const host = await hostModels();
    expect(await host.claudeCode()).toEqual([]);

    await writeFile(host.authPath, JSON.stringify({ [CLAUDE_CODE_PROVIDER_ID]: { type: 'api_key', key: 'sk-ant-oat01-test' } }));
    const available = await host.claudeCode();
    expect(available.map(model => model.id)).toEqual(CLAUDE_CODE_MODELS.map(model => model.id));
    expect(available.every(model => model.api === 'claude-code')).toBe(true);
  });

  it('applies the long-context policy the bridge registers with', () => {
    const settings = { plan: 'max' as const, forceTwoHundredK: ['claude-opus-5-5'] };
    const expected = applyLongContext(CLAUDE_CODE_MODELS, longContextSettings(settings));
    const registered = claudeCodeHostProvider(settings).models as typeof expected;
    expect(registered.map(model => [model.id, model.name, model.contextWindow]))
      .toEqual(expected.map(model => [model.id, model.name, model.contextWindow]));
    expect(registered.find(model => model.id === 'claude-opus-5-5')?.contextWindow).toBe(200_000);
  });

  it('ignores a malformed forceTwoHundredK setting', () => {
    expect(longContextSettings({ forceTwoHundredK: 'claude-opus-5-5' as never })).toEqual({
      plan: 'pro', longContextExtraUsage: false, forceTwoHundredK: undefined,
    });
  });
});
