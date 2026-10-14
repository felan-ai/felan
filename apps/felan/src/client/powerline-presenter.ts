import { parsePowerlineData, type PowerlineData } from '@felan-ai/ext-powerline/data';
import { DEFAULT_CONFIG, type PowerlineConfig } from '../tui/renderers/powerline/config.js';
import { renderSegments } from '../tui/renderers/powerline/segments.js';
import { getSymbols } from '../tui/renderers/powerline/symbols.js';
import { ProjectedPowerlineFooter } from '../tui/renderers/powerline.js';
import { parseUiPresentation, type Presentation, type UiView, type SessionSnapshot } from '@felan-ai/session-protocol';
import type { SessionClient } from './client.js';
import { statusText } from './ui.js';
import { FELAN_VERSION } from '../version.js';


export function processStatus(processes: SessionSnapshot['processes']): string | undefined {
  const running = processes.filter(process => process.kind !== 'foreground' && process.state === 'running').length;
  return running ? `● ${running} ${running === 1 ? 'process' : 'processes'}` : undefined;
}

export function isPowerlinePresentation(item: Presentation): boolean {
  return (item.kind === 'status' || item.kind === 'view')
    && item.hint?.id === 'felan.powerline' && item.hint.version === '3.0.0';
}

export function powerlineViewData(presentation: readonly Presentation[]): PowerlineData | undefined {
  const views = presentation.filter((item): item is UiView => item.kind === 'view' && isPowerlinePresentation(item));
  if (!views.length) return undefined;
  const segments: unknown[] = [];
  for (const view of views) {
    parseUiPresentation(view);
    for (const item of view.items) {
      const { segment, data, color } = item.values;
      if (typeof data !== 'string') throw new Error('Invalid Powerline view row.');
      segments.push({ name: segment, colorKey: color, values: JSON.parse(data) });
    }
  }
  return parsePowerlineData({ segments });
}

export function createClientPowerlineFooter(
  client: Pick<SessionClient, 'getAttachment' | 'subscribe'>,
  session: string,
  options: Pick<ConstructorParameters<typeof ProjectedPowerlineFooter>[0], 'theme' | 'requestRender' | 'extraRows'> & { onError?(message: string): void; preferences?(): PowerlineConfig['display'] },
): ProjectedPowerlineFooter {
  let invalid = false;
  return new ProjectedPowerlineFooter({ ...options, subscribe: listener => client.subscribe(listener), data() {
    const attachment = client.getAttachment(session);
    if (attachment?.state.status !== 'live') return undefined;
    try {
      const presentation = attachment.state.snapshot?.presentation ?? [];
      const result = powerlineViewData(presentation);
      if (result) {
        const statuses = presentation.filter(item => item.kind === 'status' && item.id !== 'working' && !isPowerlinePresentation(item))
          .sort((a, b) => a.kind === 'status' && b.kind === 'status' ? a.key.localeCompare(b.key) : 0)
          .map(item => item.kind === 'status' ? statusText(item) : '');
        const processes = processStatus(attachment.state.snapshot?.processes ?? []);
        if (processes) statuses.push(processes);
        const display = options.preferences?.() ?? DEFAULT_CONFIG.display;
        const data: PowerlineData = { segments: [...result.segments.filter(segment => segment.name !== 'version'), { name: 'version', colorKey: 'version', values: { version: FELAN_VERSION } }] };
        const lines = display.lines.map(line => renderSegments(line, { data, symbols: getSymbols(display.charset), statuses }));
        invalid = false;
        return { ...display, lines };
      }
      invalid = false; return undefined;
    }
    catch {
      if (!invalid) { invalid = true; queueMicrotask(() => options.onError?.('The daemon sent invalid powerline data; the footer is hidden.')); }
      return undefined;
    }
  } });
}
