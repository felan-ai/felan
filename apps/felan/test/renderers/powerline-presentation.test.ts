import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { DEFAULT_CONFIG } from '../../src/tui/renderers/powerline/config.js';
import { renderFooterLine } from '../../src/tui/renderers/powerline/footer-renderer.js';
import { getThemePalette } from '../../src/tui/renderers/powerline/colors.js';
import { getSymbols } from '../../src/tui/renderers/powerline/symbols.js';
import { ProjectedPowerlineFooter, renderPowerlineData } from '../../src/tui/renderers/powerline.js';

const theme = { getFgAnsi: () => '\x1b[38;5;42m', getBgAnsi: () => '\x1b[48;5;42m' };
const segments = [
  { name: 'directory' as const, colorKey: 'directory' as const, text: '界 workspace', align: 'left' as const },
  { name: 'model' as const, colorKey: 'model' as const, text: 'model', align: 'right' as const },
];

it('matches the existing footer algorithm for every style, charset and narrow-width case', () => {
  for (const style of ['minimal', 'powerline', 'capsule'] as const) for (const charset of ['text', 'unicode'] as const) {
    const config = { display: { ...DEFAULT_CONFIG.display, style, charset } };
    const data = JSON.parse(JSON.stringify({ ...config.display, lines: [segments] }));
    for (const width of [1, 7, 20, 100]) {
      expect(renderPowerlineData(data, theme, width)).toEqual(renderFooterLine(segments, config, getThemePalette(theme), 'truecolor', getSymbols(charset), width));
    }
  }
});

it('renders client rail rows, follows data and theme changes, and disposes subscriptions once', () => {
  let listener: () => void = () => {}; let data = ({ ...DEFAULT_CONFIG.display, lines: [segments] });
  const requestRender = vi.fn(); const unsubscribe = vi.fn();
  const footer = new ProjectedPowerlineFooter({ data: () => data, theme: () => theme, requestRender,
    subscribe(next) { listener = next; return unsubscribe; }, extraRows: () => ['child '.repeat(10)] });
  expect(footer.render(20).every(line => visibleWidth(line) <= 20)).toBe(true);
  data = ({ ...DEFAULT_CONFIG.display, lines: [[{ ...segments[0]!, text: 'updated' }]] }); listener();
  expect(requestRender).toHaveBeenCalledOnce(); expect(footer.render(80).join('\n')).toContain('updated');
  footer.dispose(); footer.dispose(); listener();
  expect(unsubscribe).toHaveBeenCalledOnce(); expect(requestRender).toHaveBeenCalledOnce();
});

it('keeps projected renderer modules free of Git, subscription fetching and runtime construction', async () => {
  for (const file of ['projected-footer.ts', 'footer-renderer.ts', 'colors.ts', 'symbols.ts']) {
    const source = await readFile(new URL(`../../src/tui/renderers/powerline/${file}`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"].*\/(git|subscription|savings|index|footer)\.js['"]/);
    expect(source).not.toMatch(/\b(exec|fetch|setInterval)\(/);
  }
});
