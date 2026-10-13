import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Keybinding, KeybindingsManager } from '@earendil-works/pi-tui';
import { FELAN_VERSION } from '../version.js';

export function startupHeader(theme: Theme, keys: KeybindingsManager): string {
  const key = (action: Keybinding) => keys.getKeys(action).join('/');
  const hint = (binding: string, label: string) => `${theme.fg('muted', binding)} ${theme.fg('dim', label)}`;
  return [
    theme.fg('accent', `◉  Felan Code v${FELAN_VERSION}`),
    theme.fg('dim', '   get the job done · waste less'),
    '',
    [hint(key('app.interrupt'), 'interrupt'), hint(`${key('app.clear')}/${key('app.exit')}`, 'clear/exit'),
      hint('/', 'commands'), hint('!', 'bash'), hint(key('app.tools.expand'), 'more')].join(theme.fg('muted', ' · ')),
  ].join('\n');
}
