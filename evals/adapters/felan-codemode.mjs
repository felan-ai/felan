import { felanAdapter } from 'harness-evals';
import { scenarioIds } from '../fixtures/codemode/v1/source/scenarios.mjs';

export function codemodePlan(input, plan) {
  const id = input.testCase.id.replace(/^codemode-/u, '');
  const mode = input.agent.config?.settings?.codemode?.mode;
  if (!scenarioIds.includes(id) || !['off', 'on', 'only'].includes(mode)) throw new Error('Unknown code-mode case or mode');
  if (!input.agent.provider || !input.agent.model) throw new Error('An explicit model and provider are required');
  return { ...plan, argv: ['node', '/workspace/run.mjs', id, mode, input.agent.provider, input.agent.model, input.agent.thinking ?? 'xhigh'],
    parser: 'pi-jsonl', metadata: { ...(plan.metadata ?? {}), codemode: { id, mode } } };
}

export const felanCodemodeAdapter = {
  name: 'felan', authEnvNames: felanAdapter.authEnvNames,
  getInstallRecipe: input => felanAdapter.getInstallRecipe(input),
  prepareStep: async input => codemodePlan(input, await felanAdapter.prepareStep(input)),
  parseEvents: input => felanAdapter.parseEvents(input),
};

export default felanCodemodeAdapter;
