import { afterEach, expect, it } from 'vitest';
import { setKeybindings, stripTerminalSequences } from '@earendil-works/pi-tui';
import { ShellExecution, shellExecutionMessage } from '../src/tui/shell-execution.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { defaultClientTheme } from '../src/tui/theme.js';

afterEach(() => setKeybindings(createClientKeybindings()));

it('strips raw C0/C1 and terminal controls from commands, output and paths', () => {
  const theme = defaultClientTheme();
  const frame = new ShellExecution({ role: 'bashExecution', command: 'echo\u0000\u0007\u0085safe\x1b[31m',
    output: 'line\u0001\u009f\nnext', truncated: true, fullOutputPath: '/tmp/\u0007\u0085safe', cancelled: false, exitCode: 0, timestamp: 0 },
  false, 1, () => theme).render(100).join('\n');
  expect(stripTerminalSequences(frame)).toContain('$ echosafe');
  expect(stripTerminalSequences(frame)).toContain('line');
  expect(stripTerminalSequences(frame)).toContain('Full output: /tmp/safe');
  expect(stripTerminalSequences(frame)).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
});

it('uses remapped interrupt and expand key names in live/collapsed legends', () => {
  setKeybindings(createClientKeybindings({ 'app.interrupt': 'alt+x', 'app.tools.expand': 'alt+o' }));
  const theme = defaultClientTheme();
  const view = new ShellExecution({ role: 'bashExecution', command: 'echo hi', output: Array.from({ length: 25 }, () => 'line').join('\n'),
    truncated: false, cancelled: false, exitCode: undefined, timestamp: 0 }, true, 1, () => theme);
  expect(stripTerminalSequences(view.render(100).join('\n'))).toContain('Running... (alt+x to cancel)');
  expect(stripTerminalSequences(view.render(100).join('\n'))).toContain('(alt+o to expand)');
  view.setExpanded(true);
  expect(stripTerminalSequences(view.render(100).join('\n'))).not.toContain('to expand');
});

it('decodes a fenced multiline command and literal output without duplicate data fields', () => {
  const command = 'echo `hi`\n# command'; const output = '# title\n- list\n```\n| a & b |';
  expect(shellExecutionMessage({ id: 'shell', kind: 'document', revision: 1, title: 'Shell execution', fallback: 'Running', actions: [],
    hint: { id: 'shell.execution', version: '1.0.0' }, markdown: `\`\`\`\`\n$ ${command}\n${output}\n\`\`\`\``,
    data: { commandLength: command.length, excludeFromContext: true } })).toMatchObject({ command, output, excludeFromContext: true });
});
