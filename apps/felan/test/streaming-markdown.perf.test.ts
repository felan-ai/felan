import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Markdown } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';
import { clientMarkdownTransform } from '../src/tui/markdown.js';
import { StreamingMarkdown } from '../src/tui/streaming-markdown.js';
import { clientMarkdownTheme, FELAN_THEME_PATHS, parseClientTheme } from '../src/tui/theme.js';
import { codeHeavyCorpus } from './fixtures/markdown-corpus.js';

const theme = parseClientTheme(readFileSync(FELAN_THEME_PATHS[1]!, 'utf8'));
const markdown = clientMarkdownTheme(() => theme);
const codeHeavy = Object.values(codeHeavyCorpus).join('\n');

it.each([
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
