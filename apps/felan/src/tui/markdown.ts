import type { MarkdownTransformer, Theme } from '@earendil-works/pi-coding-agent';

export type MermaidMode = 'off' | 'final' | 'streaming';

const { createMermaidMarkdownTransformer }: {
  createMermaidMarkdownTransformer(options: { getMode(): MermaidMode; theme: Theme }): MarkdownTransformer;
} = await import(new URL('./modes/interactive/components/mermaid.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);

export function clientMarkdownTransform(theme: Theme, mode: MermaidMode, isStreaming: boolean): (text: string, width: number) => string {
  const transform = createMermaidMarkdownTransformer({ theme, getMode: () => mode });
  return (text, availableWidth) => transform(text, { messageType: 'assistant', isStreaming, availableWidth });
}
