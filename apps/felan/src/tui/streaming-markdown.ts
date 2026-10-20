import { Marked, Markdown, type Component, type MarkdownTheme } from '@earendil-works/pi-tui';

const parser = new Marked();
const wholeDocumentSyntax = /(?:^|\n) {0,3}(?:<(?:[!?]|(?:script|pre|style|textarea)(?=[\s>]))|\$\$|\\\[)/giu;

export class StreamingMarkdown implements Component {
  private source = '';
  private normalized = '';
  private settledLength = 0;
  private settledSourceLength = 0;
  private readonly blocks: Markdown[] = [];
  private readonly tail: Markdown;
  private wholeDocument = false;

  constructor(text: string, private readonly padding: number, private readonly theme: MarkdownTheme,
    private readonly transform?: (text: string, width: number) => string) {
    this.tail = this.create('');
    this.setText(text);
  }

  setText(text: string): void {
    if (text === this.source) return;
    let added = text.slice(this.source.length);
    if (text.startsWith(this.source)) {
      if (this.source.endsWith('\r') && added.startsWith('\n')) added = added.slice(1);
    } else {
      this.blocks.length = 0;
      this.settledLength = 0;
      this.settledSourceLength = 0;
      this.wholeDocument = false;
      this.normalized = '';
      added = text;
    }
    this.source = text;
    if (this.wholeDocument) { this.renderWholeDocument(); return; }

    // The longest HTML opener, including indentation and a newline, fits within this overlap.
    wholeDocumentSyntax.lastIndex = Math.max(0, this.normalized.length - 16);
    // Pi expands tabs before lexing; Marked normalizes CRLF and standalone CR to LF.
    this.normalized += added.replace(/\t/g, '   ').replace(/\r\n|\r/g, '\n');
    this.wholeDocument = wholeDocumentSyntax.test(this.normalized);
    if (this.wholeDocument) { this.renderWholeDocument(); return; }

    const pending = this.normalized.slice(this.settledLength);
    const tokens = parser.lexer(pending);
    // A new reference definition can change inline rendering in already-settled blocks.
    if (Object.keys(tokens.links).length) {
      this.wholeDocument = true;
      this.renderWholeDocument();
      return;
    }
    if (tokens.map(token => token.raw).join('') !== pending) {
      this.tail.setText(this.source.slice(this.settledSourceLength));
      return;
    }

    let offset = 0;
    let start = 0;
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index]!;
      // Keep incomplete multiline labels in the tail until they cannot become reference definitions.
      if (token.type === 'paragraph' && /^ {0,3}\[(?:\\[\s\S]|[^\[\]\\])*(?:\\?$|\](?::|$))/u.test(pending.slice(offset))) break;
      offset += token.raw.length;
      // Keep the separator with its block: Pi's spacing depends on the next token being "space".
      // Finish the next block's first line before settling, since "1" can still become "1. item".
      if (index === 0 || token.type !== 'space' || !tokens[index + 1] || pending.indexOf('\n', offset) < 0) continue;
      const sourceEnd = this.sourceOffset(offset - start);
      this.blocks.push(this.create(this.source.slice(this.settledSourceLength, sourceEnd)));
      this.settledSourceLength = sourceEnd;
      start = offset;
    }
    this.settledLength += start;
    this.tail.setText(this.source.slice(this.settledSourceLength));
  }

  render(width: number): string[] {
    const lines: string[] = [];
    for (const block of this.blocks) lines.push(...block.render(width));
    lines.push(...this.tail.render(width));
    return lines;
  }

  invalidate(): void {
    for (const block of this.blocks) block.invalidate();
    this.tail.invalidate();
  }

  private create(text: string): Markdown {
    // Mermaid operates on top-level blocks; whole-document transforms must use a single Markdown.
    return new Markdown(text, this.padding, 0, this.theme, undefined, this.transform ? { transform: this.transform } : undefined);
  }

  private sourceOffset(normalizedLength: number): number {
    // Transforms run before Pi's normalization, so render the original source slices.
    let offset = this.settledSourceLength;
    for (let length = 0; length < normalizedLength; offset++) {
      const character = this.source[offset];
      length += character === '\t' ? 3 : 1;
      if (character === '\r' && this.source[offset + 1] === '\n') offset++;
    }
    return offset;
  }

  private renderWholeDocument(): void {
    this.blocks.length = 0;
    this.settledLength = 0;
    this.settledSourceLength = 0;
    this.tail.setText(this.source);
  }
}
