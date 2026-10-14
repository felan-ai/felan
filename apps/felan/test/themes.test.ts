import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const themesDirectory = resolve(import.meta.dirname, '..', 'src', 'themes');
const requiredColorTokens = [
  'accent', 'border', 'borderAccent', 'borderMuted', 'success', 'error', 'warning', 'muted', 'dim', 'text',
  'thinkingText', 'selectedBg', 'scrollbarThumb', 'searchMatchBg', 'searchMatchText', 'userMessageBg',
  'userMessageText', 'customMessageBg', 'customMessageText', 'customMessageLabel', 'toolPendingBg', 'toolSuccessBg',
  'toolErrorBg', 'toolTitle', 'toolOutput', 'mdHeading', 'mdLink', 'mdLinkUrl', 'mdCode', 'mdCodeBlock',
  'mdCodeBlockBorder', 'mdQuote', 'mdQuoteBorder', 'mdHr', 'mdListBullet', 'toolDiffAdded', 'toolDiffRemoved',
  'toolDiffContext', 'syntaxComment', 'syntaxKeyword', 'syntaxFunction', 'syntaxVariable', 'syntaxString',
  'syntaxNumber', 'syntaxType', 'syntaxOperator', 'syntaxPunctuation', 'thinkingOff', 'thinkingMinimal',
  'thinkingLow', 'thinkingMedium', 'thinkingHigh', 'thinkingXhigh', 'bashMode',
] as const;
const hexColor = /^#[0-9a-f]{6}$/iu;

type Theme = {
  name: string;
  vars: Record<string, string>;
  colors: Record<string, string>;
  export: Record<string, string>;
};

function loadTheme(name: string): Theme {
  return JSON.parse(readFileSync(resolve(themesDirectory, `${name}.json`), 'utf8')) as Theme;
}

function resolveColor(theme: Theme, value: string, visited = new Set<string>()): string {
  if (hexColor.test(value)) return value;
  if (visited.has(value)) throw new Error(`Circular color reference: ${value}`);
  const resolved = theme.vars[value];
  if (!resolved) throw new Error(`Missing color variable: ${value}`);
  visited.add(value);
  return resolveColor(theme, resolved, visited);
}

function luminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(foreground: string, background: string): number {
  const values = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe('Felan Pi themes', () => {
  for (const mode of ['light', 'dark'] as const) {
    it(`${mode} has complete semantic variables and Pi tokens`, () => {
      const theme = loadTheme(`felan-${mode}`);
      expect(theme.name).toBe(`felan-${mode}`);
      expect(theme.vars).toMatchObject({
        bg: expect.stringMatching(hexColor),
        fg: expect.stringMatching(hexColor),
        surface1: expect.stringMatching(hexColor),
        surface2: expect.stringMatching(hexColor),
        surface3: expect.stringMatching(hexColor),
        brand: expect.stringMatching(hexColor),
        border: expect.stringMatching(hexColor),
        muted: expect.stringMatching(hexColor),
        success: expect.stringMatching(hexColor),
        warning: expect.stringMatching(hexColor),
        error: expect.stringMatching(hexColor),
        info: expect.stringMatching(hexColor),
      });
      for (const token of requiredColorTokens) expect(theme.colors[token]).toBeDefined();
      for (const value of Object.values(theme.colors)) expect(resolveColor(theme, value)).toMatch(hexColor);
    });

    it(`${mode} keeps normal text readable on its semantic surfaces`, () => {
      const theme = loadTheme(`felan-${mode}`);
      const color = (token: string) => resolveColor(theme, theme.colors[token]);
      const variable = (token: string) => resolveColor(theme, theme.vars[token] ?? theme.colors[token]);
      const pairs = [
        ['text', 'bg'], ['userMessageText', 'userMessageBg'], ['customMessageText', 'customMessageBg'],
        ['searchMatchText', 'searchMatchBg'], ['toolOutput', 'toolPendingBg'], ['mdCodeBlock', 'surface1'],
        ['syntaxVariable', 'bg'], ['syntaxString', 'bg'], ['syntaxFunction', 'bg'], ['syntaxType', 'bg'],
      ] as const;
      for (const [foreground, background] of pairs) {
        expect(contrast(color(foreground), variable(background)), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${mode} keeps semantic status and secondary colors visible`, () => {
      const theme = loadTheme(`felan-${mode}`);
      const color = (token: string) => resolveColor(theme, theme.colors[token]);
      const variable = (token: string) => resolveColor(theme, theme.vars[token] ?? theme.colors[token]);
      for (const [foreground, background] of [
        ['success', 'panelSuccess'], ['error', 'panelError'], ['warning', 'surface2'], ['muted', 'surface2'],
      ] as const) {
        expect(contrast(color(foreground), variable(background)), `${foreground} on ${background}`).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
