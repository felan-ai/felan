import {
  getSelectListTheme,
  keyText,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { COMPACTION_MESSAGE_TYPE, parseCompactionPresentation, type CompactionMethodLabel } from '@felan-ai/ext-session-compaction/view';
export { compactionMethodForEntry, compactionMethodForMessage } from '@felan-ai/ext-session-compaction/view';
export type { CompactionMethodLabel } from '@felan-ai/ext-session-compaction/view';
import type { Message } from '@felan-ai/session-protocol';
import {
  Container,
  Markdown,
  MouseRegion,
  Spacer,
  Text,
  type MarkdownTheme,
} from '@earendil-works/pi-tui';

export type CompactionSummaryMessage = Extract<
  AgentSession['messages'][number],
  { role: 'compactionSummary' }
>;

export function projectedCompactionComponent(message: Message, theme: MarkdownTheme, outputPad: number): CompactionMethodMessageComponent | undefined {
  if (message.customType !== COMPACTION_MESSAGE_TYPE) return undefined;
  const details = parseCompactionPresentation(message.details);
  if (!details.method) return undefined;
  return new CompactionMethodMessageComponent({ role: 'compactionSummary',
    summary: message.content.filter(item => item.type === 'text').map(item => item.text).join('\n'),
    tokensBefore: details.tokensBefore, timestamp: message.timestamp }, details.method, theme, outputPad);
}

export class CompactionMethodMessageComponent extends Container {
  #expanded = false;
  #outputPad: number;

  constructor(
    private readonly message: CompactionSummaryMessage,
    private readonly method: CompactionMethodLabel,
    private readonly markdownTheme: MarkdownTheme,
    outputPad: number,
  ) {
    super();
    this.#outputPad = Math.max(0, outputPad);
    this.#updateDisplay();
  }

  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
    this.#updateDisplay();
  }

  setOutputPad(outputPad: number): void {
    this.#outputPad = Math.max(0, outputPad);
    this.#updateDisplay();
  }

  override invalidate(): void {
    super.invalidate();
    this.#updateDisplay();
  }

  #updateDisplay(): void {
    this.clear();
    const content = new Container();
    const theme = getSelectListTheme();
    const action = this.#expanded ? 'hide details' : 'details';
    content.addChild(new Text(
      theme.description(`Context compacted · ${this.method} · ${keyText('app.tools.expand')} ${action}`),
      this.#outputPad,
      0,
    ));
    if (this.#expanded) {
      const tokenCount = this.message.tokensBefore.toLocaleString();
      content.addChild(new Spacer(1));
      content.addChild(new Markdown(
        `**Compacted from ${tokenCount} tokens**\n\n${this.message.summary}`,
        this.#outputPad,
        0,
        this.markdownTheme,
      ));
    }
    this.addChild(new MouseRegion(content, (event) => {
      if (event.type !== 'click' || event.button !== 'left') return undefined;
      this.setExpanded(!this.#expanded);
      return { handled: true };
    }));
  }
}

