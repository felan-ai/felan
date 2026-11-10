import { readFileSync } from 'node:fs';
import { Markdown } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';
import { clientMarkdownTransform, type MermaidMode } from '../src/tui/markdown.js';
import { StreamingMarkdown } from '../src/tui/streaming-markdown.js';
import { clientMarkdownTheme, FELAN_THEME_PATHS, parseClientTheme } from '../src/tui/theme.js';
import { codeHeavyCorpus } from './fixtures/markdown-corpus.js';

const theme = parseClientTheme(readFileSync(FELAN_THEME_PATHS[1]!, 'utf8'));
const markdown = clientMarkdownTheme(() => theme);
const widths = [1, 8, 18, 48, 100];
const corpus = {
  paragraphs: 'First **bold** and _italic_ paragraph.\nA soft break with `code`.\n\nSecond paragraph with ~~deleted~~ words.\n\nThird.\n',
  whitespace: '\n\n  # Leading blank lines\n\nParagraph.\n\n   \nAnother.\n\n\n',
  headings: '# Heading\nParagraph.\n\nSetext heading\n==============\n\n## Second\n\n### Third\nText after heading.\n',
  fences: 'Before.\n\n```ts\nconst message = "hello";\n\nconsole.log(message);\n```\nAfter without a blank line.\n\n~~~~text\nA ``` literal.\n~~~\n~~~~\n\nLast.\n',
  openFence: 'Before.\n\n```text\nOpen code.\n\nStill code.\n``',
  lists: 'Before.\n\n3. First\n   - nested **one**\n   - nested two\n7. Second\n\n   Another paragraph in the item.\n\n8. Third\n\nAfter.\n\n- task\n\n- another\n\nEnd.\n',
  orderedContinuation: '1. First\n\n2. Second\n\n3. Third\n\n4. Fourth\n\nEnd.\n',
  quotes: 'Before.\n\n> ## Heading\n>\n> Quoted **text**.\n>\n> - nested list\n> - second\n\n> Another quote\n\nAfter.\n',
  tables: 'Before.\n\n| Name | Value |\n| :--- | ---: |\n| a | **long** value |\n| 中文 | 👩🏽‍💻 |\n\nAfter.\n',
  rules: 'Paragraph\n---\nText\n\n***\n## Heading\n___\n\nAfter.\n',
  unicode: '# 日本語 👩🏽‍💻\n\n中文の段落。全角文字と emoji 👨‍👩‍👧‍👦 café.\n\nSecond 🚀 paragraph **你好**.\n\nEnd.\n',
  references: '[later] and ![picture].\n\nSecond paragraph.\n\n[later]: https://example.com\n[picture]: https://example.com/p.png\n\nEnd.\n',
  multilineReference: 'Before [multi line reference].\n\nAfter.\n\n[multi\n\nline\n\nreference]: https://example.com\n',
  math: 'Before.\n\n$$\nx = y\n\n+ z\n$$\n\nAfter.\n\n\\[\na + b\n\n= c\n\\]\n',
  html: 'Before.\n\nSecond.\n\n<div\n\nclass="example">hello</div>\n\nAfter.\n',
  normalization: 'Before.\r\n\r\n- Item\r\n\tIndented\r\n\r\nAfter.\r\n',
};

const combined = [corpus.paragraphs, corpus.headings, corpus.fences, corpus.lists, corpus.quotes, corpus.tables, corpus.rules, corpus.unicode].join('\n');
const codeHeavy = Object.values(codeHeavyCorpus).join('\n');
const inlineLatexCorpus = {
  shellPid: '# Shell PID\n\nRun `kill $$` to stop the current shell.\n\n```sh\nkill $$\n```\n\nTail.\n',
  inlineDollars: '# Inline dollars\n\nThe result $$x + y$$ stays inline.\n\nAnother paragraph.\n\nTail.\n',
  escapedBrackets: '# Escaped brackets\n\nText containing \\[1\\] stays in this paragraph.\n\nAnother paragraph.\n\nTail.\n',
};
const crossBlockCorpus = {
  htmlComment: 'Before.\n\nSecond.\n\n<!-- a comment\n\nwith a blank line\n-->\n\nAfter.\n',
  script: 'Before.\n\nSecond.\n\n   <ScRiPt>\n\nalert("hello");\n</ScRiPt>\n\nAfter.\n',
  pre: 'Before.\n\nSecond.\n\n<pre>\n\ntext\n</pre>\n\nAfter.\n',
  style: 'Before.\n\nSecond.\n\n<style>\n\nbody {}\n</style>\n\nAfter.\n',
  textarea: 'Before.\n\nSecond.\n\n   <textarea>\n\ntext\n</textarea>\n\nAfter.\n',
  processingInstruction: 'Before.\n\nSecond.\n\n<?instruction\n\ntext?>\n\nAfter.\n',
  declaration: 'Before.\n\nSecond.\n\n<!DOCTYPE\n\nhtml>\n\nAfter.\n',
  cdata: 'Before.\n\nSecond.\n\n<![CDATA[\n\ntext]]>\n\nAfter.\n',
  lateReference: '# Heading\n\nUse [the API][api].\n\nAnother paragraph.\n\n[api]: https://example.com\n\nDone.\n',
};

it.each(Object.entries({ ...corpus, combined }))('matches a single Markdown at every growing prefix: %s', (_name, source) => {
  const streaming = new StreamingMarkdown('', 1, markdown);
  for (let length = 0; length <= source.length; length++) {
    const text = source.slice(0, length);
    streaming.setText(text);
    const baseline = new Markdown(text, 1, 0, markdown);
    for (const width of widths) {
      expect(streaming.render(width), `prefix ${length}, width ${width}, ${JSON.stringify(text)}`).toEqual(baseline.render(width));
    }
  }
});

it.each(Object.entries({ ...codeHeavyCorpus, ...crossBlockCorpus, mixed: codeHeavy }))('matches code-heavy Markdown at every growing prefix: %s', (_name, source) => {
  const streaming = new StreamingMarkdown('', 1, markdown);
  for (let length = 0; length <= source.length; length++) {
    const text = source.slice(0, length);
    streaming.setText(text);
    const baseline = new Markdown(text, 1, 0, markdown);
    for (const width of [40, 80, 120]) {
      expect(streaming.render(width), `prefix ${length}, width ${width}, ${JSON.stringify(text)}`).toEqual(baseline.render(width));
    }
  }
});

it.each(Object.entries({ ...codeHeavyCorpus, ...inlineLatexCorpus, math: corpus.math, mixed: codeHeavy }))('matches Markdown across chunk sizes 1, 3, 7, and 50: %s', (_name, source) => {
  for (const chunkSize of [1, 3, 7, 50]) {
    const streaming = new StreamingMarkdown('', 1, markdown);
    for (let offset = 0; offset < source.length; offset += chunkSize) {
      const text = source.slice(0, offset + chunkSize);
      streaming.setText(text);
      const baseline = new Markdown(text, 1, 0, markdown);
      for (const width of widths) {
        expect(streaming.render(width), `chunk size ${chunkSize}, prefix ${text.length}, width ${width}, ${JSON.stringify(text)}`).toEqual(baseline.render(width));
      }
    }
  }
});

it.each([['$$', '$$'], ['\\[', '\\]']])('invalidates settled blocks when a LaTeX block starts mid-stream with %s', (opening, closing) => {
  const source = '# Heading\n\nBefore.\n\nTail.\n\n';
  const suffix = `   ${opening}\nx = y\n\n+ z\n${closing}\n\nAfter.\n`;
  const streaming = new StreamingMarkdown(source, 1, markdown);
  expect(streaming.render(80)).toEqual(new Markdown(source, 1, 0, markdown).render(80));
  for (let length = 1; length <= suffix.length; length++) {
    const text = source + suffix.slice(0, length);
    streaming.setText(text);
    expect(streaming.render(80), `suffix prefix ${length}`).toEqual(new Markdown(text, 1, 0, markdown).render(80));
  }
});

it.each((['off', 'final', 'streaming'] as const).flatMap(mode => ['lf', 'tabs', 'crlf'].map(normalization => [mode, normalization] as const)))('preserves the %s Mermaid transform with %s at every prefix', (mode: MermaidMode, normalization) => {
  let source = 'Before.\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nAfter.\n\n```mermaid\ngraph LR\n  X --> Y\n```\n\nEnd.\n';
  if (normalization === 'tabs') source = source.replace(/ {2}/g, '\t');
  if (normalization === 'crlf') source = source.replace(/\n/g, '\r\n');
  const streaming = new StreamingMarkdown('', 1, markdown, clientMarkdownTransform(theme, mode, true));
  for (let length = 0; length <= source.length; length++) {
    const text = source.slice(0, length);
    streaming.setText(text);
    const baseline = new Markdown(text, 1, 0, markdown, undefined, { transform: clientMarkdownTransform(theme, mode, true) });
    for (const width of widths) {
      expect(streaming.render(width), `prefix ${length}, width ${width}`).toEqual(baseline.render(width));
    }
  }
});

it('passes original tabs and CRLF to the transform after settling normalized blocks', () => {
  const transform = (text: string) => text.replace(/\t/g, 'TAB');
  const source = '# Heading\r\n\r\nFirst\tparagraph.\r\n\r\nSecond\tparagraph.\r\n\r\nTail.\r\n';
  const streaming = new StreamingMarkdown('', 1, markdown, transform);
  for (let length = 0; length <= source.length; length++) {
    const text = source.slice(0, length);
    streaming.setText(text);
    expect(streaming.render(80)).toEqual(new Markdown(text, 1, 0, markdown, undefined, { transform: value => value.replace(/\t/g, 'TAB') }).render(80));
  }
});

it('matches the full renderer after resize and invalidation', () => {
  const source = '# Settled heading\n\nTail paragraph.\n';
  const streaming = new StreamingMarkdown(source, 1, markdown);
  expect(streaming.render(48)).toEqual(new Markdown(source, 1, 0, markdown).render(48));
  for (const suffix of ['More', 'More text', 'More text in the tail.']) {
    streaming.setText(source + suffix);
    expect(streaming.render(48)).toEqual(new Markdown(source + suffix, 1, 0, markdown).render(48));
  }
  const expected = new Markdown(source + 'More text in the tail.', 1, 0, markdown).render(18);
  expect(streaming.render(18)).toEqual(expected);
  streaming.invalidate();
  expect(streaming.render(18)).toEqual(expected);
});

it('restarts after replacement, truncation, and a whole-document fallback', () => {
  const streaming = new StreamingMarkdown('# Old\n\nSecond paragraph.\n\nThird.\n', 1, markdown);
  streaming.render(48);
  for (const text of ['# New\n\nChanged.\n', '# New', corpus.references, 'Ordinary.\n\nAnother.\n', '', corpus.quotes]) {
    streaming.setText(text);
    for (const width of widths) expect(streaming.render(width)).toEqual(new Markdown(text, 1, 0, markdown).render(width));
  }
});
