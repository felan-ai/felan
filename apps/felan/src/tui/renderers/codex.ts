import type { AgentToolPresentation } from '../../subagents/agent-transcript.js';
import { Text } from '@earendil-works/pi-tui';

export function createCodexToolRenderers(): { apply_patch: AgentToolPresentation } {
  return { apply_patch: { renderCall(_params, theme, context) {
    const title = context.isError ? 'Patch failed' : context.isPartial ? 'Patching' : 'Patched';
    const heading = theme.bold(title);
    return new Text(`${theme.fg('dim', '•')} ${context.isError ? theme.fg('error', heading) : heading}`, 0, 0);
  } } };
}
