export function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export interface TextContentBlock {
  readonly type: string;
  readonly text: string;
  readonly [key: string]: unknown;
}

export function isTextContentBlock(value: unknown): value is TextContentBlock {
  const block = toRecord(value);
  return block.type === 'text' && typeof block.text === 'string';
}

export function mapTextContentBlocks(
  content: readonly unknown[],
  transform: (block: TextContentBlock) => string | undefined,
): { readonly changed: boolean; readonly content: unknown[] } {
  let changed = false;
  const mapped = content.map((block) => {
    if (!isTextContentBlock(block)) return block;
    const text = transform(block);
    if (text === undefined || text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return { changed, content: mapped };
}
