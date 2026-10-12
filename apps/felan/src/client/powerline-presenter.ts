import { POWERLINE_PRESENTER, parsePowerlineData } from '@felan-ai/ext-powerline/view';
import { ProjectedPowerlineFooter } from '@felan-ai/ext-powerline/tui';
import type { SessionClient } from './client.js';

export { POWERLINE_PRESENTER } from '@felan-ai/ext-powerline/view';

export function createClientPowerlineFooter(
  client: Pick<SessionClient, 'getAttachment' | 'subscribe'>,
  session: string,
  options: Pick<ConstructorParameters<typeof ProjectedPowerlineFooter>[0], 'theme' | 'requestRender' | 'extraRows'> & { onError?(message: string): void },
): ProjectedPowerlineFooter {
  let invalid = false;
  return new ProjectedPowerlineFooter({ ...options, subscribe: listener => client.subscribe(listener), data() {
    const attachment = client.getAttachment(session);
    if (attachment?.state.status !== 'live') return undefined;
    const value = attachment.state.snapshot?.presentation.find(item => item.id === POWERLINE_PRESENTER.id);
    if (!value || value.kind !== 'custom' || value.presenter.id !== POWERLINE_PRESENTER.id || value.presenter.version !== POWERLINE_PRESENTER.version) return undefined;
    try { const result = parsePowerlineData(value.data); invalid = false; return result; }
    catch {
      if (!invalid) { invalid = true; queueMicrotask(() => options.onError?.('The daemon sent invalid powerline data; the footer is hidden.')); }
      return undefined;
    }
  } });
}
