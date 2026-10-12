import { convertToPng, type AgentSession, type Theme, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Box, Container, Image, Markdown, MouseRegion, Spacer, Text, getCapabilities, stripTerminalSequences, type Component, type MarkdownTheme, type TUI } from '@earendil-works/pi-tui';
import { renderThinkingGroupMarkdown } from '../thinking-groups.js';

type AssistantMessage = Extract<AgentSession['messages'][number], { role: 'assistant' }>;
type CompactionMessage = Extract<AgentSession['messages'][number], { role: 'compactionSummary' }>;
type Renderers = Pick<ToolDefinition<any, any, any>, 'renderCall' | 'renderResult' | 'renderShell'>;
type ToolResult = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; details?: unknown; isError: boolean; durationMs?: number };

export class TranscriptAssistant extends Container {
  private message: AssistantMessage;
  private readonly thinking = new Map<number, boolean>();
  constructor(message: AssistantMessage, private hidden: boolean, private readonly markdown: MarkdownTheme,
    private readonly padding: number, private readonly theme: () => Theme) { super(); this.message = message; this.updateContent(message); }
  setHideThinkingBlock(hidden: boolean): void { this.hidden = hidden; this.thinking.clear(); this.updateContent(this.message); }
  updateContent(message: AssistantMessage): void {
    this.message = message; this.clear();
    if (message.content.some(part => part.type === 'text' && part.text.trim() || part.type === 'thinking' && part.thinking.trim())) this.addChild(new Spacer(1));
    let run = 0;
    for (let index = 0; index < message.content.length; index++) {
      const part = message.content[index]!;
      if (part.type === 'text' && part.text.trim()) this.addChild(new Markdown(part.text.trim(), this.padding, 0, this.markdown));
      else if (part.type === 'thinking') {
        const parts = [part.thinking];
        while (message.content[index + 1]?.type === 'thinking') parts.push((message.content[++index] as typeof part).thinking);
        const text = parts.filter(value => value.trim()).join('\n\n'); if (!text) continue;
        const at = run++; const hidden = this.thinking.get(at) ?? this.hidden;
        const component = hidden ? new Text(this.theme().fg('thinkingText', this.theme().italic('Thinking...')), this.padding, 0)
          : new Markdown(text, this.padding, 0, this.markdown, { color: value => this.theme().fg('thinkingText', value), italic: true }, {
            transform: (value, width) => renderThinkingGroupMarkdown(value, { messageType: 'assistant-thinking', isStreaming: false, availableWidth: width }),
          });
        this.addChild(new MouseRegion(component, event => {
          if (event.type !== 'click' || event.button !== 'left') return undefined;
          this.thinking.set(at, !hidden); this.updateContent(this.message); return { handled: true };
        }));
        if (message.content.slice(index + 1).some(value => value.type === 'text' && value.text.trim() || value.type === 'thinking' && value.thinking.trim())) this.addChild(new Spacer(1));
      }
    }
    const hasTools = message.content.some(part => part.type === 'toolCall');
    const error = message.stopReason === 'length' ? 'Response was truncated before completion.' : hasTools ? undefined
      : message.stopReason === 'aborted' ? message.errorMessage || 'Operation aborted'
        : message.stopReason === 'error' ? `Error: ${message.errorMessage || 'Unknown error'}` : undefined;
    if (error) { this.addChild(new Spacer(1)); this.addChild(new Text(this.theme().fg('error', stripTerminalSequences(error)), this.padding, 0)); }
  }
  override invalidate(): void { this.updateContent(this.message); super.invalidate(); }
}

export class TranscriptCompaction extends Box {
  private expanded = false;
  constructor(private readonly message: CompactionMessage, private readonly markdown: MarkdownTheme,
    private readonly theme: () => Theme, private padding: number, private readonly hint: () => string, private readonly method?: string) {
    super(padding, 1, text => theme().bg('customMessageBg', text)); this.update();
  }
  setExpanded(value: boolean): void { this.expanded = value; this.update(); }
  setOutputPad(value: number): void { this.padding = value; this.setPaddingX(value); this.update(); }
  override invalidate(): void { this.update(); super.invalidate(); }
  private update(): void {
    this.clear(); const content = new Container();
    content.addChild(new Text(this.theme().fg('customMessageLabel', `Context compacted${this.method ? ` · ${this.method}` : ''} · ${this.hint()} ${this.expanded ? 'hide details' : 'details'}`), 0, 0));
    if (this.expanded) content.addChild(new Markdown(`**Compacted from ${this.message.tokensBefore.toLocaleString()} tokens**\n\n${this.message.summary}`, 0, 0, this.markdown));
    this.addChild(new MouseRegion(content, event => {
      if (event.type !== 'click' || event.button !== 'left') return undefined;
      this.setExpanded(!this.expanded); return { handled: true };
    }));
  }
}

export class TranscriptTool extends Container {
  private expanded = false;
  private started = false;
  private argsComplete = false;
  private partial = false;
  private result: ToolResult | undefined;
  private callComponent: Component | undefined;
  private resultComponent: Component | undefined;
  private readonly state = {};
  private readonly images = new Map<string, Image>();
  private readonly converting = new Set<string>();
  private disposed = false;
  constructor(private readonly name: string, private readonly id: string, private args: unknown,
    private readonly options: { showImages: boolean; imageWidthCells: number; outputPad: number },
    private readonly definition: Renderers | undefined, private readonly tui: TUI, private readonly cwd: string,
    private readonly theme: () => Theme, private readonly hint: () => string) { super(); this.update(); }
  updateArgs(args: unknown): void { this.args = args; this.update(); }
  markExecutionStarted(): void { this.started = true; this.update(); }
  setArgsComplete(): void { this.argsComplete = true; this.update(); }
  updateResult(result: ToolResult, partial = false): void { this.result = result; this.partial = partial; this.update(); }
  setExpanded(value: boolean): void { this.expanded = value; this.update(); }
  override invalidate(): void { this.update(); super.invalidate(); }
  dispose(): void { this.disposed = true; this.images.clear(); }
  private context(lastComponent: Component | undefined) {
    return { args: this.args, toolCallId: this.id, invalidate: () => { this.invalidate(); this.tui.requestRender(); }, lastComponent, state: this.state,
      cwd: this.cwd, executionStarted: this.started, argsComplete: this.argsComplete, isPartial: this.partial,
      expanded: this.expanded, showImages: this.options.showImages, isError: this.result?.isError ?? false,
      durationMs: this.partial ? undefined : this.result?.durationMs, outputPad: this.options.outputPad };
  }
  private callFallback(): Component {
    const args = JSON.stringify(this.args, null, 2);
    return new Text(`${this.theme().fg('toolTitle', this.theme().bold(this.name))}${args && args !== '{}' ? `\n${stripTerminalSequences(args)}` : ''}`, 0, 0);
  }
  private resultFallback(): Component | undefined {
    const output = this.result?.content.flatMap(part => part.type === 'text' ? [part.text ?? '']
      : part.type === 'image' && (!this.options.showImages || !getCapabilities().images) ? [`[Image: ${part.mimeType ?? 'unknown'}]`] : []).join('\n');
    if (!output) return undefined;
    const lines = stripTerminalSequences(output).split('\n'); const shown = this.expanded ? lines : lines.slice(0, 10);
    return new Text(`${this.theme().fg('toolOutput', shown.join('\n'))}${shown.length < lines.length ? this.theme().fg('muted', `\n... (${lines.length - shown.length} more lines, ${this.hint()} to expand)`) : ''}`, 0, 0);
  }
  private region(component: Component): Component {
    return new MouseRegion(component, event => {
      if (!this.result || event.type !== 'click' || event.button !== 'left') return undefined;
      this.setExpanded(!this.expanded); return { handled: true };
    });
  }
  private update(): void {
    this.clear(); const ownShell = this.definition?.renderShell === 'self';
    const content = ownShell ? new Container() : new Box(this.options.outputPad, 1, text => this.theme().bg(
      !this.result || this.partial ? 'toolPendingBg' : this.result.isError ? 'toolErrorBg' : 'toolSuccessBg', text));
    let call: Component;
    try { call = this.definition?.renderCall?.(this.args, this.theme(), this.context(this.callComponent)) ?? this.callFallback(); this.callComponent = call; }
    catch { this.callComponent = undefined; call = this.callFallback(); }
    content.addChild(this.region(call));
    if (this.result) {
      let result: Component | undefined;
      try {
        result = this.definition?.renderResult?.(this.result as Parameters<NonNullable<Renderers['renderResult']>>[0],
          { expanded: this.expanded, isPartial: this.partial }, this.theme(), this.context(this.resultComponent)) ?? this.resultFallback();
        this.resultComponent = result;
      } catch { this.resultComponent = undefined; result = this.resultFallback(); }
      if (result) content.addChild(this.region(result));
    }
    if (ownShell) this.addChild({
      render: width => { const lines = content.render(width); return lines.length ? ['', ...lines] : []; },
      invalidate: () => content.invalidate(),
      handleMouse: event => event.y > 0 ? content.handleMouse({ ...event, y: event.y - 1 }) : undefined,
    });
    else { this.addChild(new Spacer(1)); this.addChild(content); }
    if (this.options.showImages && getCapabilities().images) {
      const retained = new Set<string>();
      for (const part of this.result?.content ?? []) {
        if (part.type !== 'image' || !part.data || !part.mimeType) continue;
        const key = `${part.mimeType}:${part.data}`; retained.add(key);
        let image = this.images.get(key);
        if (!image) { image = new Image(part.data, part.mimeType, { fallbackColor: text => this.theme().fg('toolOutput', text) }, { maxWidthCells: this.options.imageWidthCells }); this.images.set(key, image); }
        if (part.mimeType !== 'image/png' && getCapabilities().images === 'kitty' && !this.converting.has(key)) {
          this.converting.add(key);
          void convertToPng(part.data, part.mimeType).then(converted => {
            if (!converted || this.disposed || !this.images.has(key)) return;
            this.images.set(key, new Image(converted.data, converted.mimeType, { fallbackColor: text => this.theme().fg('toolOutput', text) }, { maxWidthCells: this.options.imageWidthCells }));
            this.update(); this.tui.requestRender();
          }).catch(() => {});
        }
        this.addChild(new Spacer(1)); this.addChild(image);
      }
      for (const key of this.images.keys()) if (!retained.has(key)) { this.images.delete(key); this.converting.delete(key); }
    }
  }
}
