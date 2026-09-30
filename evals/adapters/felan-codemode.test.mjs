import { strict as assert } from 'node:assert';
import { codemodePlan, felanCodemodeAdapter } from './felan-codemode.mjs';

const input = { testCase: { id: 'codemode-listening-summary' },
  agent: { provider: 'openai-codex', model: 'gpt-6.1-sol', thinking: 'xhigh', config: { settings: { codemode: { mode: 'only' } } } } };
const plan = codemodePlan(input, { cwd: '/workspace', envNames: ['FELAN_AGENT_DIR'], configMounts: [] });
assert.deepEqual(plan.argv, ['node', '/workspace/run.mjs', 'listening-summary', 'only', 'openai-codex', 'gpt-6.1-sol', 'xhigh']);
assert.deepEqual(plan.envNames, ['FELAN_AGENT_DIR']);
assert.throws(() => codemodePlan({ ...input, testCase: { id: 'unknown' } }, {}), /Unknown/);
assert.throws(() => codemodePlan({ ...input, agent: { ...input.agent, config: {} } }, {}), /Unknown/);
for (const mode of ['off', 'on', 'only']) {
  const configured = { ...input, agent: { ...input.agent, config: { settings: { codemode: { mode } } } } };
  assert.equal(codemodePlan(configured, {}).argv[3], mode);
}
assert.throws(() => codemodePlan({ ...input, agent: { ...input.agent, config: { codemodeArm: 'only' } } }, {}), /Unknown/);
assert.equal(plan.parser, 'pi-jsonl');
const events = await felanCodemodeAdapter.parseEvents({ plan, stderr: '', stdout: JSON.stringify({ type: 'message_end', message: {
  role: 'assistant', provider: 'openai-codex', model: 'gpt-6.1-sol', content: [{ type: 'text', text: '{}' }],
  usage: { input: 4, output: 2, cacheRead: 4, cacheWrite: 0, totalTokens: 10, cost: { total: 0.01 } }, stopReason: 'stop',
} }) });
assert.equal(events.cost.totalCost, 0.01);
assert.equal(events.cost.usage[0].totalTokens, 10);
assert.equal(events.cost.usage[0].promptTokens, 8);
assert.equal(events.cost.usage[0].requests, 1);
assert.equal(events.finalOutput, '{}');
assert.deepEqual(events.errors, []);
console.log('code-mode harness adapter passed');
