import { builtinProviders } from '@felan-ai/agent-core';

// Claude Code's model list when it offers every Anthropic catalog model.
export const catalogModelRows = builtinProviders()
  .find((provider) => provider.id === 'anthropic')
  .getModels()
  .map(({ id }) => ({ value: id }));
