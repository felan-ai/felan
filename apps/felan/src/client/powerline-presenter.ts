import { parsePowerlineData, type PowerlineData, type RenderedSegment, type ThemeColorKey } from '@felan-ai/ext-powerline/data';
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
    && item.hint?.id === 'felan.powerline' && item.hint.version === '2.0.0';
}

export function powerlineViewData(presentation: readonly Presentation[]): PowerlineData | undefined {
  const views = presentation.filter((item): item is UiView => item.kind === 'view' && isPowerlinePresentation(item));
  if (!views.length) return undefined;
  const display = new Map<string, string>();
  const rows = new Map<string, UiView['items'][number]>();
  for (const view of views) {
    parseUiPresentation(view);
    for (const item of view.items) {
      const { segment, text } = item.values;
      if (typeof segment !== 'string' || typeof text !== 'string') throw new Error('Invalid Powerline view row.');
      if (segment.startsWith('display.')) {
        const key = segment.slice('display.'.length);
        if (display.has(key)) throw new Error('Ambiguous Powerline display settings.');
        display.set(key, text);
      } else {
        if (rows.has(item.id)) throw new Error('Duplicate Powerline segment.');
        rows.set(item.id, item);
      }
    }
  }
  if (!['style', 'charset', 'autoWrap', 'padding', 'lines'].every(key => display.has(key))) return undefined;
  const count = Number(display.get('lines'));
  const padding = Number(display.get('padding'));
  if (String(count) !== display.get('lines') || String(padding) !== display.get('padding')
    || !Number.isInteger(count) || count < 0 || count > 32 || !['true', 'false'].includes(display.get('autoWrap')!)) {
    throw new Error('Invalid Powerline display settings.');
  }
  const lines: Array<Array<{ name: unknown; colorKey: unknown; align: unknown; text: unknown }>> = Array.from({ length: count }, () => []);
  const positions = [...rows.values()].map(item => {
    const position = /^line-(\d+)-segment-(\d+)$/u.exec(item.id);
    const line = item.values.line;
    if (!position || typeof line !== 'number' || !Number.isInteger(line) || line < 1 || line > count
      || Number(position[1]) !== line - 1) throw new Error('Invalid Powerline segment position.');
    return { item, line, index: Number(position[2]) };
  }).sort((a, b) => a.line - b.line || a.index - b.index);
  for (const { item, line, index } of positions) {
    if (index !== lines[line - 1]!.length) return undefined;
    lines[line - 1]!.push({ name: item.values.segment, colorKey: item.values.color, align: item.values.alignment, text: item.values.text });
  }
  return parsePowerlineData({ style: display.get('style'), charset: display.get('charset'),
    autoWrap: display.get('autoWrap') === 'true', padding, lines });
}

export function createClientPowerlineFooter(
  client: Pick<SessionClient, 'getAttachment' | 'subscribe'>,
  session: string,
  options: Pick<ConstructorParameters<typeof ProjectedPowerlineFooter>[0], 'theme' | 'requestRender' | 'extraRows'> & { onError?(message: string): void },
): ProjectedPowerlineFooter {
  let invalid = false;
  return new ProjectedPowerlineFooter({ ...options, subscribe: listener => client.subscribe(listener), data() {
    const attachment = client.getAttachment(session);
    if (attachment?.state.status !== 'live') return undefined;
    try {
      const presentation = attachment.state.snapshot?.presentation ?? [];
      const result = powerlineViewData(presentation);
      if (result) {
        const colors: ThemeColorKey[] = ['extensionStatus1', 'extensionStatus2', 'extensionStatus3', 'extensionStatus4'];
        const statuses: RenderedSegment[] = presentation.filter(item => item.kind === 'status' && item.id !== 'working' && !isPowerlinePresentation(item))
          .sort((a, b) => a.kind === 'status' && b.kind === 'status' ? a.key.localeCompare(b.key) : 0)
          .map((item, index) => ({ name: 'status', align: 'left', colorKey: colors[index % colors.length]!,
            text: item.kind === 'status' ? statusText(item).replace(/[\r\n\t]+/gu, ' ') : '' }));
        const processes = processStatus(attachment.state.snapshot?.processes ?? []);
        if (processes) statuses.push({ name: 'status', align: 'left', colorKey: 'extensionStatus1', text: processes });
        const lines = result.lines.map(line => line.filter(segment => segment.name !== 'version'));
        let statusLine = lines.findIndex(line => line.some(segment => segment.name === 'status'));
        if (statusLine === -1) {
          statusLine = lines.length && !lines.at(-1)!.length ? lines.length - 1 : lines.length;
          lines[statusLine] ??= [];
        }
        lines[statusLine]!.push(...statuses, { name: 'version', colorKey: 'version', align: 'right', text: `Felan ${FELAN_VERSION}` });
        invalid = false;
        return { ...result, lines };
      }
      invalid = false; return undefined;
    }
    catch {
      if (!invalid) { invalid = true; queueMicrotask(() => options.onError?.('The daemon sent invalid powerline data; the footer is hidden.')); }
      return undefined;
    }
  } });
}
