export interface LayoutQuestionOption {
  readonly title: string;
  readonly description?: string;
}

export interface AnnotatedRow {
  readonly line: string;
  readonly selected: boolean;
}

export interface RenderSingleSelectRowsParams {
  readonly options: readonly LayoutQuestionOption[];
  readonly selectedIndex: number;
  readonly width: number;
  readonly allowFreeform: boolean;
  readonly allowComment?: boolean;
  readonly commentEnabled?: boolean;
  readonly maxRows?: number;
  readonly hideDescriptions?: boolean;
}

interface ItemBlock {
  readonly itemIndex: number;
  readonly lines: string[];
}

export function renderSingleSelectRows({
  options,
  selectedIndex,
  width,
  allowFreeform,
  allowComment = false,
  commentEnabled = false,
  maxRows,
  hideDescriptions = false,
}: RenderSingleSelectRowsParams): AnnotatedRow[] {
  const blocks = buildBlocks(
    options,
    width,
    allowFreeform,
    allowComment,
    commentEnabled,
    selectedIndex,
    hideDescriptions,
  );
  const allRows = flatten(blocks, selectedIndex);
  if (!maxRows || maxRows <= 0 || allRows.length <= maxRows) return allRows;

  const limit = Math.max(1, Math.floor(maxRows));
  const selected = blocks[selectedIndex] ?? blocks[0];
  if (!selected) return [];
  const itemCount = blocks.length;
  const available = limit > 1 ? limit - 1 : 1;
  if (selected.lines.length >= available) {
    const rows = selected.lines.slice(0, available).map((line) => ({ line, selected: true }));
    if (limit > 1) rows.push({ line: `  (${selectedIndex + 1}/${itemCount})`, selected: false });
    return rows.slice(0, limit);
  }

  let start = selectedIndex;
  let end = selectedIndex + 1;
  let used = selected.lines.length;
  while (true) {
    if (end < blocks.length && used + blocks[end]!.lines.length <= available) {
      used += blocks[end]!.lines.length;
      end += 1;
      continue;
    }
    if (start > 0 && used + blocks[start - 1]!.lines.length <= available) {
      start -= 1;
      used += blocks[start]!.lines.length;
      continue;
    }
    break;
  }
  return [
    ...flatten(blocks.slice(start, end), selectedIndex),
    { line: `  (${selectedIndex + 1}/${itemCount})`, selected: false },
  ].slice(0, limit);
}

function buildBlocks(
  options: readonly LayoutQuestionOption[],
  width: number,
  allowFreeform: boolean,
  allowComment: boolean,
  commentEnabled: boolean,
  selectedIndex: number,
  hideDescriptions: boolean,
): ItemBlock[] {
  const items = [
    ...options.map((option) => ({ kind: 'option' as const, option })),
    ...(allowComment
      ? [{ kind: 'action' as const, option: { title: `${commentEnabled ? '[✓]' : '[ ]'} Add extra context after selection` } }]
      : []),
    ...(allowFreeform
      ? [{ kind: 'action' as const, option: { title: 'Type something. — Enter a custom response' } }]
      : []),
  ];
  const normalizedWidth = Math.max(12, width);
  return items.map((item, itemIndex) => {
    const pointer = itemIndex === selectedIndex ? '→' : ' ';
    if (item.kind === 'action') {
      const prefix = `${pointer}   `;
      return {
        itemIndex,
        lines: wrapText(item.option.title, Math.max(8, normalizedWidth - prefix.length))
          .map((line, index) => `${index === 0 ? prefix : ' '.repeat(prefix.length)}${line}`.trimEnd()),
      };
    }
    const prefix = `${pointer} ${itemIndex + 1}. `;
    const lines = wrapText(item.option.title, Math.max(8, normalizedWidth - prefix.length))
      .map((line, index) => `${index === 0 ? prefix : ' '.repeat(prefix.length)}${line}`.trimEnd());
    if (item.option.description && !hideDescriptions) {
      lines.push(...wrapText(item.option.description, Math.max(8, normalizedWidth - 6)).map((line) => `      ${line}`.trimEnd()));
    }
    return { itemIndex, lines };
  });
}

function flatten(blocks: readonly ItemBlock[], selectedIndex: number): AnnotatedRow[] {
  return blocks.flatMap((block) => block.lines.map((line) => ({
    line,
    selected: block.itemIndex === selectedIndex,
  })));
}

function wrapText(text: string, width: number): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [''];
  if (width <= 1) return [...normalized];
  const lines: string[] = [];
  let current = '';
  for (const word of normalized.split(' ')) {
    if (!current && word.length <= width) {
      current = word;
      continue;
    }
    if (current && `${current} ${word}`.length <= width) {
      current = `${current} ${word}`;
      continue;
    }
    if (current) lines.push(current);
    current = '';
    if (word.length <= width) {
      current = word;
      continue;
    }
    for (let index = 0; index < word.length; index += width) {
      const chunk = word.slice(index, index + width);
      if (chunk.length === width || index + width < word.length) lines.push(chunk);
      else current = chunk;
    }
  }
  if (current) lines.push(current);
  return lines;
}
