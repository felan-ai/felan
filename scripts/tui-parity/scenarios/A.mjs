import { scenario as s, pause, screen, keys, command, esc, prompt, until, legacyClientFallback } from './helpers.mjs';
export default [
  s('A-startup', 'Startup header, editor and footer', [...legacyClientFallback(), screen('startup')], ['header lines', 'footer three lines', 'editor borders']),
  s('A-slash-list', 'Full slash autocomplete', [{ text: '/' }, pause(), screen('slash-list'), { commands: true }, ...esc()], ['labels, descriptions, order, skills and count'], ['daemon-only commands']),
  s('A-autocomplete-filter', 'Fuzzy autocomplete and escape', [{ text: '/mo' }, pause(), screen('filtered'), ...esc(), screen('escaped')], ['fuzzy filter', 'highlight', 'Esc behaviour']),
  s('A-editor-clear', 'Command submit and history', [
    { side: 'old', text: '/hotkeys' }, { side: 'new', text: '/help' }, keys('Enter'), pause(), screen('submitted'),
    keys('PageDown'), pause(), screen('help-page-2'), keys('PageDown'), pause(), screen('help-page-3'), keys('PageDown'), pause(), screen('help-page-4'),
    keys('PageUp'), pause(), screen('help-page-up'),
    keys(...Array.from({ length: 20 }, () => 'Down')), pause(), screen('help-arrow-scroll'),
    keys(...Array.from({ length: 200 }, () => 'Down')), pause(), screen('help-bottom'),
    ...esc(), keys('C-r'), until('History'), pause(), screen('history'), keys('Enter'), pause(), screen('history-inserted'), keys('C-u')], ['editor clears after submit', 'command history', 'one Enter inserts the command'], ['/hotkeys on old, /help on new']),
  s('A-streaming', 'Streaming greeting', [...prompt('say hi in five words'), keys('C-r'), until('History'), pause(), screen('populated-history'), keys('C-r'), pause(), screen('history-scope'), keys('Enter'), pause(), screen('history-selected'), pause(), screen('history-inserted'), keys('C-u')], ['working indicator and streamed text', 'footer tokens and cost', 'populated prompt history, scope cycling and insertion'], ['model prose'], true),
  s('A-tool-display', 'Tool rendering and preview toggle', [...prompt('list the files in this directory'), keys('C-o'), pause(), screen('expanded')], ['tool row', 'Ctrl+O preview', 'completion'], ['model tool choice'], true),
  s('A-bash', 'Context and non-context shell commands', [...command('!echo hi'), screen('context-bash'), ...command('!!echo hi'), screen('no-context-bash'), ...command("!printf 'first\\n'; sleep 1; printf 'last\\n'"), pause(1500), screen('delayed-output'), ...command("!!printf 'stderr-only\\n' >&2; exit 7"), screen('stderr-nonzero')], ['output placement', '! vs !! context inclusion', 'delayed output', 'stderr and nonzero exit']),
  s('A-keys', 'Cancel and exit keys', [{ prompt: 'say hi' }, pause(400), keys('Escape'), pause(), screen('cancel'), keys('C-c'), pause(300), screen('ctrl-c'), keys('C-d'), pause(), screen('ctrl-d')], ['cancel behaviour', 'exit or detach notices'], ['daemon detach semantics'], true),
  s('A-resize', 'Narrow and restored terminal', [{ resize: [80, 24] }, pause(), screen('narrow'), { resize: [120, 40] }, pause(), screen('wide')], ['editor and footer reflow', 'no overlap or clipped border']),
  s('A-long-input', 'Twelve-line editor', Array.from({ length: 12 }, (_, i) => [{ text: `line ${i + 1}: a short unsent editor test` }, ...(i === 11 ? [] : [keys('C-j')])]).flat().concat([pause(), screen('multiline'), keys('C-u')]), ['editor growth', 'scroll', 'retained borders']),
  s('A-notices', 'Unknown command notice', [...command('/parity-no-such-command'), screen('notice')], ['notice text and colour'], ['An unknown slash command may become a model prompt.'], true),
];
