import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadComposition, runScenario } from './run.mjs';

const composition = await loadComposition(
  fileURLToPath(new URL('../../../../../packages/agent-core/dist/index.js', import.meta.url)),
  fileURLToPath(new URL('../../../../../apps/tui/dist/index.js', import.meta.url)),
);

for (const mode of ['off', 'on', 'only']) {
  test(`fixture uses shipped code-mode config ${mode}`, async (t) => {
    t.mock.method(console, 'log', () => {});
    const root = await mkdtemp(join(tmpdir(), 'felan-eval-codemode-'));
    try {
      const agentDir = join(root, 'agent');
      const core = composition.core;
      const modelRuntime = await core.ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null });
      const model = modelRuntime.getModel('openai-codex', 'gpt-6.1-sol');
      assert.ok(model);
      const declarations = [];
      modelRuntime.hasConfiguredAuth = () => true;
      modelRuntime.streamSimple = (active, context) => {
        declarations.push(core.getCurrentTools(context.messages).map(tool => tool.name));
        const stream = core.createAssistantMessageEventStream();
        queueMicrotask(() => stream.push({ type: 'done', reason: 'stop', message: {
          role: 'assistant', content: [{ type: 'text', text: '{}' }],
          api: active.api, provider: active.provider, model: active.id, timestamp: Date.now(), stopReason: 'stop',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } }));
        return stream;
      };
      const result = await runScenario({ composition, modelRuntime, model, mode, thinking: 'off',
        id: 'listening-summary', cwd: join(root, 'workspace'), agentDir });
      assert.equal(result.executionError, false);
      assert.equal(result.providerError, false);
      assert.equal(result.mode, mode);
      assert.equal(JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')).codemode.mode, mode);
      assert.equal(declarations.length, 1);
      assert.equal(declarations[0].includes('codemode'), mode !== 'off');
      if (mode === 'only') assert.deepEqual(declarations[0], ['codemode']);
      else assert.ok(declarations[0].length > 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
