import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { DEFAULT_CONFIG } from '../src/config.js';
import { renderFooterLine } from '../src/footer.js';
import { getThemePalette } from '../src/colors.js';
import { getSymbols } from '../src/symbols.js';
import { parsePowerlineData, powerlineData } from '../src/view.js';
import { ProjectedPowerlineFooter, renderPowerlineData } from '../src/tui.js';

const theme = { getFgAnsi: () => '\x1b[38;5;42m', getBgAnsi: () => '\x1b[48;5;42m' };
const segments = [
  { name: 'directory' as const, colorKey: 'directory' as const, text: '界 workspace', align: 'left' as const },
  { name: 'model' as const, colorKey: 'model' as const, text: 'model', align: 'right' as const },
];

it('matches the existing footer algorithm for every style, charset and narrow-width case', () => {
  for (const style of ['minimal', 'powerline', 'capsule'] as const) for (const charset of ['text', 'unicode'] as const) {
    const config = { display: { ...DEFAULT_CONFIG.display, style, charset } };
    const data = parsePowerlineData(JSON.parse(JSON.stringify(powerlineData(config, [segments]))));
    for (const width of [1, 7, 20, 100]) {
      expect(renderPowerlineData(data, theme, width)).toEqual(renderFooterLine(segments, config, getThemePalette(theme), 'truecolor', getSymbols(charset), width));
    }
  }
});

it('bounds plain data and rejects terminal controls, invalid styles, colors and excess data', () => {
  const data = powerlineData(DEFAULT_CONFIG, [segments]);
  for (const bad of [{ ...data, padding: Infinity }, { ...data, padding: 5000 }, { ...data, style: 'other' },
    { ...data, lines: [[{ ...segments[0], text: '\x1b]2;injected\x07' }]] },
    { ...data, lines: [[{ ...segments[0], colorKey: '__proto__' }]] },
    { ...data, lines: [Array.from({ length: 257 }, () => segments[0])] },
    { ...data, lines: [Array.from({ length: 10 }, () => ({ ...segments[0], text: 'x'.repeat(8192) }))] },
    { ...data, callback: 'unsupported' }]) expect(() => parsePowerlineData(bad)).toThrow();
});

it('renders client rail rows, follows data and theme changes, and disposes subscriptions once', () => {
  let listener: () => void = () => {}; let data = powerlineData(DEFAULT_CONFIG, [segments]);
  const requestRender = vi.fn(); const unsubscribe = vi.fn();
  const footer = new ProjectedPowerlineFooter({ data: () => data, theme: () => theme, requestRender,
    subscribe(next) { listener = next; return unsubscribe; }, extraRows: () => ['child '.repeat(10)] });
  expect(footer.render(20).every(line => visibleWidth(line) <= 20)).toBe(true);
  data = powerlineData(DEFAULT_CONFIG, [[{ ...segments[0]!, text: 'updated' }]]); listener();
  expect(requestRender).toHaveBeenCalledOnce(); expect(footer.render(80).join('\n')).toContain('updated');
  footer.dispose(); footer.dispose(); listener();
  expect(unsubscribe).toHaveBeenCalledOnce(); expect(requestRender).toHaveBeenCalledOnce();
});

it('keeps the projected TUI entrypoint free of Git, subscription fetching and runtime construction', async () => {
  for (const file of ['tui.ts', 'projected-footer.ts', 'footer-renderer.ts', 'view.ts', 'colors.ts', 'symbols.ts']) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"].*\/(git|subscription|savings|index|footer)\.js['"]/);
    expect(source).not.toMatch(/\b(exec|fetch|setInterval)\(/);
  }
});
