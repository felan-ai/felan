import {
  getSelectListTheme,
  keyText,
  type AgentSession,
  type CompactionEntry,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import {
  DETAILS_NAMESPACE,
  DETAILS_SCHEMA_VERSION,
} from '@felan-ai/ext-session-compaction';
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

export type CompactionMethodLabel = 'Classifier' | 'Summary' | 'Native';

export function compactionMethodForEntry(
  entry: Pick<CompactionEntry, 'details' | 'fromHook'>,
): CompactionMethodLabel | undefined {
  const method = felanCompactionMethod(entry.details);
  if (method !== undefined) return method;
  return entry.fromHook === true ? undefined : 'Native';
}

export function compactionMethodForMessage(
  entries: readonly SessionEntry[],
  message: CompactionSummaryMessage,
): CompactionMethodLabel | undefined {
  const matchingEntries = entries.filter((entry): entry is CompactionEntry => (
    entry.type === 'compaction'
    && entry.summary === message.summary
    && entry.tokensBefore === message.tokensBefore
  ));
  let closestEntry = matchingEntries[0];
  let closestDistance = closestEntry === undefined
    ? Number.POSITIVE_INFINITY
    : Math.abs(new Date(closestEntry.timestamp).getTime() - message.timestamp);
  for (const entry of matchingEntries.slice(1)) {
    const distance = Math.abs(new Date(entry.timestamp).getTime() - message.timestamp);
    if (distance >= closestDistance) continue;
    closestEntry = entry;
    closestDistance = distance;
  }
  return closestEntry === undefined ? undefined : compactionMethodForEntry(closestEntry);
}

export class CompactionMethodMessageComponent extends Container {
  #expanded = false;

  constructor(
    private readonly message: CompactionSummaryMessage,
    private readonly method: CompactionMethodLabel,
    private readonly markdownTheme: MarkdownTheme,
  ) {
    super();
    this.#updateDisplay();
  }

  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
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
      0,
      0,
    ));
    if (this.#expanded) {
      const tokenCount = this.message.tokensBefore.toLocaleString();
      content.addChild(new Spacer(1));
      content.addChild(new Markdown(
        `**Compacted from ${tokenCount} tokens**\n\n${this.message.summary}`,
        0,
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

function felanCompactionMethod(details: unknown): CompactionMethodLabel | undefined {
  if (!isRecord(details)
    || details.namespace !== DETAILS_NAMESPACE
    || details.schemaVersion !== DETAILS_SCHEMA_VERSION) return undefined;
  if (details.method === 'classifier') return 'Classifier';
  if (details.method === 'summary') return 'Summary';
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
