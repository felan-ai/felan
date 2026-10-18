import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Markdown } from '@earendil-works/pi-tui';
import { expect, it, vi } from 'vitest';
import { clientMarkdownTransform, type MermaidMode } from '../src/tui/markdown.js';
import { StreamingMarkdown } from '../src/tui/streaming-markdown.js';
import { clientMarkdownTheme, FELAN_THEME_PATHS, parseClientTheme } from '../src/tui/theme.js';

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
const codeHeavyCorpus = {
  typescript: '# TypeScript\n\nUse `Promise<void>` for asynchronous work.\n\n```ts\nasync function run<T>(items: T[]): Promise<void> {\n  for (let i = 0; i < items.length; i++) {\n    if (i > 0) console.log(items[i]);\n  }\n}\n```\n\nDone.\n',
  go: '# Go\n\nTabs remain readable.\n\n```go\nfunc main() {\n\tfor i := 0; i < 3; i++ {\n\t\tfmt.Println(i)\n\t}\n}\n```\n\nDone.\n',
  json: '# JSON\n\nAn array of objects:\n\n```json\n[\n  { "name": "first", "enabled": true },\n  { "name": "second", "enabled": false }\n]\n```\n\n[1, 2, 3]\n\nDone.\n',
  toml: '# TOML\n\nConfiguration:\n\n```toml\n[server]\nport = 3000\n\n[database]\nhost = "localhost"\n```\n\n[server]\nport = 3000\n\nDone.\n',
  jsx: '# JSX\n\nRender a component:\n\n```tsx\nconst view = <Panel>\n  <Button disabled={count < 1}>Save</Button>\n</Panel>;\n```\n\n<Panel>\n  <Button>Save</Button>\n</Panel>\n\nDone.\n',
  crlf: '# Windows\r\n\r\nUse `Promise<void>`.\r\n\r\n```go\r\nfunc main() {\r\n\tfmt.Println("hello")\r\n}\r\n```\r\n\r\nDone.\r\n',
  carriageReturns: '# Returns\r\rFirst.\r\r\tIndented code.\r\rLast.\r',
};
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

it.each(Object.entries({ ...codeHeavyCorpus, ...inlineLatexCorpus }))('keeps settled blocks cached: %s', (_name, source) => {
  const heading = vi.fn(markdown.heading);
  const streaming = new StreamingMarkdown('', 1, { ...markdown, heading });
  for (let length = 1; length <= source.length; length++) {
    streaming.setText(source.slice(0, length));
    streaming.render(80);
  }
  expect(streaming.render(80)).toEqual(new Markdown(source, 1, 0, markdown).render(80));
  expect(heading).toHaveBeenCalled();
  heading.mockClear();
  streaming.setText(source + 'More tail text.\n');
  expect(streaming.render(80)).toEqual(new Markdown(source + 'More tail text.\n', 1, 0, markdown).render(80));
  expect(heading).not.toHaveBeenCalled();
});

it.each([['$$', '$$'], ['\\[', '\\]']])('invalidates settled blocks when a LaTeX block starts mid-stream with %s', (opening, closing) => {
  const source = '# Heading\n\nBefore.\n\nTail.\n\n';
  const suffix = `   ${opening}\nx = y\n\n+ z\n${closing}\n\nAfter.\n`;
  const heading = vi.fn(markdown.heading);
  const streaming = new StreamingMarkdown(source, 1, { ...markdown, heading });
  expect(streaming.render(80)).toEqual(new Markdown(source, 1, 0, markdown).render(80));
  heading.mockClear();
  for (let length = 1; length <= suffix.length; length++) {
    const text = source + suffix.slice(0, length);
    streaming.setText(text);
    expect(streaming.render(80), `suffix prefix ${length}`).toEqual(new Markdown(text, 1, 0, markdown).render(80));
    if (length < 3 + opening.length) expect(heading).not.toHaveBeenCalled();
  }
  expect(heading).toHaveBeenCalled();
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
  const transform = vi.fn((text: string) => text.replace(/\t/g, 'TAB'));
  const source = '# Heading\r\n\r\nFirst\tparagraph.\r\n\r\nSecond\tparagraph.\r\n\r\nTail.\r\n';
  const streaming = new StreamingMarkdown('', 1, markdown, transform);
  for (let length = 0; length <= source.length; length++) {
    const text = source.slice(0, length);
    streaming.setText(text);
    expect(streaming.render(80)).toEqual(new Markdown(text, 1, 0, markdown, undefined, { transform: value => value.replace(/\t/g, 'TAB') }).render(80));
  }
  expect(transform.mock.calls.some(([text]) => text.includes('\t') && text.includes('\r\n'))).toBe(true);
});

it('invalidates settled blocks when a reference definition arrives later', () => {
  const heading = vi.fn(markdown.heading);
  const source = '# Heading\n\nUse [the API][api].\n\nTail.\n';
  const streaming = new StreamingMarkdown(source, 1, { ...markdown, heading });
  streaming.render(80);
  heading.mockClear();
  streaming.setText(source + '\nMore.\n');
  streaming.render(80);
  expect(heading).not.toHaveBeenCalled();
  const text = source + '\nMore.\n\n[api]: https://example.com\n';
  streaming.setText(text);
  expect(streaming.render(80)).toEqual(new Markdown(text, 1, 0, markdown).render(80));
  expect(heading).toHaveBeenCalled();
});

it('reuses settled blocks, but refreshes them on resize and invalidation', () => {
  const heading = vi.fn(markdown.heading);
  const styled = { ...markdown, heading };
  const source = '# Settled heading\n\nTail paragraph.\n';
  const streaming = new StreamingMarkdown(source, 1, styled);
  expect(streaming.render(48)).toEqual(new Markdown(source, 1, 0, markdown).render(48));
  heading.mockClear();
  for (const suffix of ['More', 'More text', 'More text in the tail.']) {
    streaming.setText(source + suffix);
    expect(streaming.render(48)).toEqual(new Markdown(source + suffix, 1, 0, markdown).render(48));
  }
  expect(heading).not.toHaveBeenCalled();
  streaming.render(18);
  expect(heading).toHaveBeenCalled();
  heading.mockClear();
  streaming.invalidate();
  streaming.render(18);
  expect(heading).toHaveBeenCalled();
});

it('restarts after replacement, truncation, and a whole-document fallback', () => {
  const streaming = new StreamingMarkdown('# Old\n\nSecond paragraph.\n\nThird.\n', 1, markdown);
  streaming.render(48);
  for (const text of ['# New\n\nChanged.\n', '# New', corpus.references, 'Ordinary.\n\nAnother.\n', '', corpus.quotes]) {
    streaming.setText(text);
    for (const width of widths) expect(streaming.render(width)).toEqual(new Markdown(text, 1, 0, markdown).render(width));
  }
});

it.skipIf(!process.env.FELAN_STREAMING_MARKDOWN_BENCHMARK).each([
  ['prose', '## Streaming output\n\nA representative paragraph with **styled text**, `inline code`, and enough words to wrap across several terminal lines. 中文测试 👩🏽‍💻.\n\n- First list item with a useful detail.\n- Second item with another detail.\n\n'],
  ['code-heavy', codeHeavy],
])('benchmarks token-by-token rendering of a growing 20 KB message: %s', (sample, section) => {
  const source = section.repeat(Math.ceil(20_000 / Buffer.byteLength(section)));
  const tokens = source.match(/.{1,4}/gsu)!;
  const transform = clientMarkdownTransform(theme, 'streaming', true);
  const render = (incremental: boolean) => {
    const component = new StreamingMarkdown('', 1, markdown, transform);
    let text = '';
    let lines: string[] = [];
    const start = performance.now();
    for (const token of tokens) {
      text += token;
      if (incremental) { component.setText(text); lines = component.render(80); }
      else lines = new Markdown(text, 1, 0, markdown, undefined, { transform }).render(80);
    }
    return { milliseconds: performance.now() - start, lines };
  };
  render(true);
  const baseline = render(false);
  const incremental = render(true);
  expect(incremental.lines).toEqual(baseline.lines);
  const speedup = baseline.milliseconds / incremental.milliseconds;
  console.log(JSON.stringify({ sample, bytes: Buffer.byteLength(source), tokens: tokens.length, baselineMs: baseline.milliseconds,
    incrementalMs: incremental.milliseconds, speedup }));
  expect(speedup).toBeGreaterThanOrEqual(5);
}, 120_000);
