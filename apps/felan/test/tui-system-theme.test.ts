import { colorToRgb, parseColor, type TerminalColors } from '@earendil-works/pi-tui';
import { expect, it } from 'vitest';
import { systemClientTheme } from '../src/tui/theme.js';

const palette = ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
  '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2'].map(value => colorToRgb(parseColor(value)));

it.each([
  { name: 'background only', input: { background: { r: 30, g: 30, b: 46 } }, appearance: 'dark', expected: {
    accent: '#a494d6', text: '#dddfe0', selectedBg: '#203540', toolErrorBg: '#4c2525', muted: '#99a2a6',
    syntaxString: '#dd8852', thinkingOff: '#687177', thinkingXhigh: '#dc4bbd', thinkingMax: '#fe485b',
  } },
  { name: 'light background with palette', input: { background: { r: 239, g: 241, b: 245 }, foreground: { r: 76, g: 79, b: 105 }, palette }, appearance: 'light', expected: {
    accent: '#924d6c', text: '#494c65', selectedBg: '#d7e2e3', toolErrorBg: '#ebdcd9', muted: '#716457',
    syntaxString: '#6c6b11', thinkingOff: '#c7bfb8', thinkingXhigh: '#d58ca0', thinkingMax: '#fa6c5c',
  } },
  { name: 'mid-gray contrast relaxation', input: { background: { r: 119, g: 119, b: 119 }, foreground: { r: 255, g: 255, b: 255 }, palette }, appearance: 'light', expected: {
    accent: '#000000', text: '#000000', selectedBg: '#407e80', toolErrorBg: '#d42e25', muted: '#000000',
    syntaxString: '#000000', thinkingOff: '#39332e', thinkingXhigh: '#000000', thinkingMax: '#000000',
  } },
])('matches the 0.28.3 palette for $name', ({ input, appearance, expected }) => {
  const theme = systemClientTheme(input as TerminalColors, appearance === 'light' ? 'dark' : 'light');
  expect(theme.appearance).toBe(appearance);
  for (const [token, hex] of Object.entries(expected)) {
    expect(colorToRgb(theme.colors[token as keyof typeof theme.colors]), token).toEqual(colorToRgb(parseColor(hex)));
  }
});

it('uses ANSI family slots, faint secondary text and transparent panels without a reported background', () => {
  const theme = systemClientTheme({}, 'dark');
  expect(theme.getFgAnsi('accent')).toBe(theme.getFgAnsi('thinkingHigh'));
  expect(theme.getFgAnsi('accent')).not.toBe(theme.getFgAnsi('mdLink'));
  expect(theme.getFgAnsi('syntaxNumber')).toBe(theme.getFgAnsi('accent'));
  expect(theme.getFgAnsi('muted')).toContain('\x1b[2m');
  expect(theme.getFgAnsi('text')).not.toContain('\x1b[2m');
  for (const token of ['selectedBg', 'userMessageBg', 'customMessageBg', 'toolErrorBg'] as const) expect(theme.getBgAnsi(token)).toBe('\x1b[49m');
});
