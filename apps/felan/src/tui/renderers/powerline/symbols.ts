import type { Charset } from './config.js';

export interface PowerlineSymbols {
  separator: string;
  separatorThin: string;
  capsuleLeft: string;
  capsuleRight: string;
  branch: string;
  sha: string;
  clean: string;
  dirty: string;
  ahead: string;
  behind: string;
  stash: string;
  tag: string;
  clock: string;
  tokensIn: string;
  tokensOut: string;
  cacheRead: string;
  cacheWrite: string;
  dotFull: string;
  dotEmpty: string;
  blockFull: string;
  blockEmpty: string;
}

export const BAR_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

const unicodeSymbols: PowerlineSymbols = {
  separator: '', separatorThin: '', capsuleLeft: '', capsuleRight: '',
  branch: '', sha: '◌', clean: '✓', dirty: '✗', ahead: '↑', behind: '↓',
  stash: '≡', tag: '⌑', clock: '◷', tokensIn: '↑', tokensOut: '↓', cacheRead: 'R',
  cacheWrite: 'W', dotFull: '●', dotEmpty: '○', blockFull: '█', blockEmpty: '░',
};

const textSymbols: PowerlineSymbols = {
  separator: ' ', separatorThin: '|', capsuleLeft: '[', capsuleRight: ']',
  branch: '', sha: 'sha:', clean: '', dirty: '', ahead: 'ahead', behind: 'behind',
  stash: 'stash', tag: 'tag:', clock: '', tokensIn: 'in', tokensOut: 'out', cacheRead: 'R',
  cacheWrite: 'W', dotFull: '*', dotEmpty: '.', blockFull: '#', blockEmpty: '-',
};

export function getSymbols(charset: Charset): PowerlineSymbols {
  return charset === 'text' ? textSymbols : unicodeSymbols;
}
