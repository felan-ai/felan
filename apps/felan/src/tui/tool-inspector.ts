import { Key, matchesKey, Text, type Component } from '@earendil-works/pi-tui';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Message, SessionSnapshot } from '@felan-ai/session-protocol';
import { uiText } from '../client/ui.js';
import { projectedStreamingMessage } from '../client/message-display.js';

export interface InspectedTool { id: string; name: string; arguments: unknown; result: string; state: string }

export function inspectTools(history: readonly Message[], snapshot: SessionSnapshot | undefined): InspectedTool[] {
  const calls = new Map<string, InspectedTool>();
  for (const part of history.flatMap(message => message.content)) {
    if (part.type === 'tool_call') calls.set(part.id, { id: part.id, name: part.name, arguments: part.arguments, result: '', state: 'pending' });
    if (part.type === 'tool_result') {
      const call = calls.get(part.id);
      if (call) { call.result = part.text + (part.details === undefined ? '' : `\n\nDetails\n${JSON.stringify(part.details, null, 2)}`); call.state = part.isError ? 'failed' : 'completed'; }
    }
  }
  let streaming: ReturnType<typeof projectedStreamingMessage>;
  try { streaming = snapshot && projectedStreamingMessage(snapshot); } catch { streaming = undefined; }
  if (streaming?.role === 'assistant') for (const part of streaming.content) {
    if (part.type === 'toolCall' && !calls.has(part.id)) calls.set(part.id, { id: part.id, name: part.name, arguments: part.arguments, result: '', state: 'pending' });
  }
  for (const tool of snapshot?.tools ?? []) {
    const call = calls.get(tool.id) ?? { id: tool.id, name: tool.name, arguments: '(Arguments unavailable in loaded history)', result: '', state: tool.state };
    if (!call.result || tool.state === 'running') call.result = tool.output + (tool.truncated ? '\n[Tool output truncated]' : '')
      + (tool.details === undefined ? '' : `\n\nDetails\n${JSON.stringify(tool.details, null, 2)}`);
    call.state = tool.state;
    calls.set(tool.id, call);
  }
  return [...calls.values()];
}

export class ToolInspector implements Component {
  private selected = 0;
  private offset = 0;
  constructor(private readonly tools: () => InspectedTool[], private readonly theme: () => Theme,
    private readonly renderRequest: () => void, private readonly close: () => void) {}
  render(width: number): string[] {
    const tools = this.tools(); this.selected = Math.min(this.selected, Math.max(0, tools.length - 1));
    const tool = tools[this.selected];
    const heading = new Text(this.theme().fg('accent', 'Tool Activity'), 1, 1).render(width);
    const hints = new Text('↑↓ calls · PgUp/PgDn details · Esc close', 1, 0).render(width);
    if (!tool) return [...heading, ...hints, ...new Text('No tool calls in this session.', 1, 1).render(width)];
    const body = new Text(uiText(`${this.selected + 1}/${tools.length} · ${tool.name} · ${tool.state}\nCall: ${tool.id}\n\nArguments\n${JSON.stringify(tool.arguments, null, 2)}\n\nResult\n${tool.result || '(No result yet)'}`), 1, 1).render(width);
    this.offset = Math.min(this.offset, Math.max(0, body.length - 16));
    return [...heading, ...hints, ...body.slice(this.offset, this.offset + 16)];
  }
  invalidate(): void {}
  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) { this.close(); return; }
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      this.selected = Math.max(0, Math.min(this.tools().length - 1, this.selected + (matchesKey(data, Key.up) ? -1 : 1))); this.offset = 0;
    }
    if (matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - 12);
    if (matchesKey(data, Key.pageDown)) this.offset += 12;
    this.renderRequest();
  }
}
