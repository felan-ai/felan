import type { AgentSession, Theme } from '@earendil-works/pi-coding-agent';
import type { SessionSnapshot } from '@felan-ai/session-protocol';
import { Container, Text, getKeybindings, type Component } from '@earendil-works/pi-tui';

import { uiText } from '../client/ui.js';

type ShellMessage = Extract<AgentSession['messages'][number], { role: 'bashExecution' }>;

export function shellExecutionMessage(element: SessionSnapshot['presentation'][number]): ShellMessage | undefined {
  if (element.kind !== 'document' || element.hint?.id !== 'shell.execution' || element.hint.version !== '1.0.0') return undefined;
  const { commandLength, excludeFromContext } = element.data ?? {};
  if (typeof commandLength !== 'number' || !Number.isSafeInteger(commandLength) || commandLength < 0 || typeof excludeFromContext !== 'boolean') return undefined;
  const fence = /^(`{3,})\n\$ /u.exec(element.markdown)?.[1];
  if (!fence || !element.markdown.endsWith(`\n${fence}`)) return undefined;
  const content = element.markdown.slice(fence.length + 3, -fence.length - 1);
  if (content[commandLength] !== '\n') return undefined;
  return { role: 'bashExecution', command: content.slice(0, commandLength), output: content.slice(commandLength + 1), excludeFromContext,
    exitCode: undefined, cancelled: false, truncated: false, timestamp: 0 };
}

export class ShellExecution implements Component {
  private expanded = false;
  constructor(private readonly message: ShellMessage, private readonly running: boolean,
    private readonly padding: number, private readonly theme: () => Theme) {}
  setExpanded(value: boolean): void { this.expanded = value; }
  invalidate(): void {}
  render(width: number): string[] {
    if (width <= 0) return [];
    const theme = this.theme(); const color = this.message.excludeFromContext ? 'dim' : 'bashMode';
    const content = new Container();
    content.addChild(new Text(theme.fg(color, theme.bold(`$ ${uiText(this.message.command)}`)), this.padding, 0));
    const output = uiText(this.message.output).trimEnd();
    const lines = output ? new Text(theme.fg('muted', output), this.padding, 0).render(width) : [];
    const visible = this.expanded ? lines : lines.slice(-20);
    if (visible.length) content.addChild({ render: () => ['', ...visible], invalidate() {} });
    const status: string[] = [];
    const keys = getKeybindings();
    const interrupt = keys.getKeys('app.interrupt').join('/') || 'unbound';
    const expand = keys.getKeys('app.tools.expand').join('/') || 'unbound';
    if (this.running) status.push(theme.fg('muted', `Running... (${interrupt} to cancel)`));
    if (lines.length > visible.length) status.push(theme.fg('muted', `... ${lines.length - visible.length} more lines (${expand} to expand)`));
    if (this.message.cancelled) status.push(theme.fg('warning', '(cancelled)'));
    else if (this.message.exitCode !== undefined && this.message.exitCode !== 0) status.push(theme.fg('error', `(exit ${this.message.exitCode})`));
    if (this.message.truncated) status.push(theme.fg('warning', `Output truncated.${this.message.fullOutputPath ? ` Full output: ${uiText(this.message.fullOutputPath)}` : ''}`));
    if (status.length) content.addChild(new Text(`\n${status.join('\n')}`, this.padding, 0));
    const border = theme.fg(color, '─'.repeat(width));
    return ['', border, ...content.render(width), border];
  }
}
