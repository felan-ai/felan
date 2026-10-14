import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Keybinding, KeybindingsManager } from '@earendil-works/pi-tui';
import { FELAN_VERSION } from '../version.js';

export function startupHeader(theme: Theme, keys: KeybindingsManager, toolsExpanded = false, quiet: boolean | 'header' = false): string {
  if (quiet === true) return '';
  const key = (action: Keybinding) => keys.getKeys(action).join('/');
  const hint = (binding: string, label: string) => `${theme.fg('muted', binding)} ${theme.fg('dim', label)}`;
  const title = [
    theme.fg('accent', `◉  Felan Code v${FELAN_VERSION}`),
    theme.fg('dim', '   get the job done · waste less'),
  ];
  if (quiet === 'header') return title.join('\n');
  return [...title,
    '',
    [hint(key('app.interrupt'), 'interrupt'), hint(`${key('app.clear')}/${key('app.exit')}`, 'clear/exit'),
      hint('/', 'commands'), hint('!', 'bash'), hint(key('app.tools.expand'), toolsExpanded ? 'collapse tools' : 'more'), ...(toolsExpanded ? [hint(key('app.tools.inspect'), 'full details')] : [])].join(theme.fg('muted', ' · ')),
  ].join('\n');
}
