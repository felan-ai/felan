import type {
  InlineExtension,
  MarkdownTransformer,
} from '@earendil-works/pi-coding-agent';

export const THINKING_GROUP_EXTENSION_NAME = '@felan-ai/felan/thinking-groups';

const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
const FENCED_CODE_MARKER = /`{3,}/gu;

export const renderThinkingGroupMarkdown: MarkdownTransformer = (markdown, context) => {
  if (context.messageType !== 'assistant-thinking') return markdown;

  const rows = markdown
    .split(/\r?\n/u)
    .flatMap((line) => Array.from(sentenceSegmenter.segment(line), ({ segment }) => segment.trim()))
    .filter((line) => line.length > 0)
    // A raw fence would consume later rows because the group is one Markdown paragraph.
    .map((line) => line.replace(FENCED_CODE_MARKER, (marker) => marker.replaceAll('`', '\\`')));
  if (rows.length === 0) return markdown;

  return [
    '**Thinking**  ',
    ...rows.map((row) => `  · ${row}  `),
  ].join('\n');
};

export function createThinkingGroupExtension(): InlineExtension {
  return {
    name: THINKING_GROUP_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerMarkdownTransformer(renderThinkingGroupMarkdown);
    },
  };
}
