import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { felanAdapter } from 'harness-evals';
import { policy, scenarios } from '../fixtures/turn-classification/v1/source/.eval-setup/scenarios.mjs';
export function turnClassificationPlan(input, plan, provenance) {
  const id = input.testCase.id.replace(/^turn-classification-/, '');
  const mode = input.agent.config?.turnClassificationMode;
  if (!Object.hasOwn(scenarios, id) || !['disabled','shared','separated'].includes(mode)
    || input.agent.provider !== policy.provider || !policy.models.includes(input.agent.model)) throw new Error('Invalid turn-classification case or arm');
  if (!provenance?.imageId || !provenance?.source?.commit || !provenance?.digest) throw new Error('Current-source provenance is required');
  const source = { image: provenance.image, imageId: provenance.imageId, source: provenance.source, digest: provenance.digest,
    packages: provenance.packages.map(({ name, version, sha256 }) => ({ name, version, sha256 })) };
  return { ...plan, argv: ['node', '/workspace/.eval-setup/run.mjs', id, mode, input.agent.model, Buffer.from(JSON.stringify(source)).toString('base64url')],
    envNames: plan.envNames.filter(name => mode !== 'disabled' || !['TYPESAFE_API_KEY','OPENROUTER_API_KEY'].includes(name)),
    parser: 'text', metadata: { turnClassification: { id, mode } } };
}
export const felanTurnClassificationAdapter = {
  name: 'felan', authEnvNames: felanAdapter.authEnvNames,
  getInstallRecipe: input => felanAdapter.getInstallRecipe(input),
  async prepareStep(input) {
    const provenance = JSON.parse(await readFile(join(input.projectRoot, 'source-image.json'), 'utf8'));
    return turnClassificationPlan(input, await felanAdapter.prepareStep(input), provenance);
  },
  async parseEvents(input) {
    const events = await felanAdapter.parseEvents(input);
    const result = JSON.parse(events.finalOutput);
    if (result.schemaVersion !== 1 || result.id !== input.plan.metadata.turnClassification.id || result.mode !== input.plan.metadata.turnClassification.mode) throw new Error('Invalid result identity');
    const usage = ['classifier','agent'].map(kind => {
      const value = result.usage[kind];
      return { provider: kind === 'classifier' ? 'typesafe' : 'openai-codex', model: kind === 'classifier' ? 'jev-latest' : 'scoped-agent-models',
        ...(value.inputTokens === null ? {} : { promptTokens: value.inputTokens }),
        ...(value.outputTokens === null ? {} : { outputTokens: value.outputTokens }),
        ...(value.costUsd === null ? {} : { totalCost: value.costUsd }),
        ...(kind === 'classifier' ? { requests: result.counts.classifierProviderRequests } : {}) };
    });
    return { ...events, cost: { available: result.usage.combined.costUsd !== null, usage,
      ...(result.usage.combined.costUsd === null ? {} : { totalCost: result.usage.combined.costUsd }),
      metadata: { unknownCost: result.usage.combined.costUsd === null } } };
  },
};
export default felanTurnClassificationAdapter;
