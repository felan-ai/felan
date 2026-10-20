import { scenario as s, pause, screen, keys, command, esc, idle } from './helpers.mjs';
const view = (id, text, observe, paid = false) => s(id, text, [...command(text), screen('view'), ...esc()], observe, [], paid);
const lifecycle = (id, text, title, observe, paid = false) => s(id, text, [
  ...command(text, title), screen('view'), ...esc(), idle(), screen('closed-idle'),
  ...command(text, title), screen('reopened'), ...esc(), idle(), screen('reclosed-idle'),
  ...(id === 'D-context' ? [...command(text, title).map(step => ({ ...step, side: 'new' })),
    { side: 'new', checkpoint: 'awaited-before-force' }, { side: 'new', daemonStop: 'force' },
    { side: 'new', wait: { ms: 500 } }, { side: 'new', checkpoint: 'force-stopped' }] : []),
], [...observe, 'Escape releases command, idle, reopen, daemon teardown'],
  id === 'D-context' ? ['New side only: force stop the isolated daemon while context is open.'] : [], paid);
export default [
  lifecycle('D-memory', '/memory', 'Local memory:', ['status', 'pending counter', 'footer status', 'empty history wording'], true),
  lifecycle('D-context', '/context', 'Context', ['placement', 'layout', 'percentage precision']),
  view('D-insights', '/insights', ['layout', 'charts', 'filters'], true),
  s('D-savings', '/savings', [keys('/'), pause(), { commands: true }, screen('commands'), ...esc(), keys('C-u'), ...command('/savings'), screen('view'), ...esc()], ['command discovery', 'values', 'wording', 'layout']),
  lifecycle('D-fusion-models', '/fusion-models', 'Unavailable saved model choices must be replaced before saving.', ['search layout', 'saved lineup; no requests', 'unavailable participants and recovery warning']),
  s('D-fusion', 'Short fusion request', [{ text: '/fusion say hi' }, keys('Enter'), idle(120000), screen('fusion')], ['progress', 'review layout'], ['model prose and configured lineup'], true),
  s('D-web', 'Web search result', [{ prompt: 'Use web search to find the official Node.js website; do not browse any other site.' }, idle(120000), screen('search')], ['tool row', 'results'], ['model tool choice; browser interactions require separately authorized follow-up'], true),
  s('D-mcp', '/mcp status', [...command('/mcp status'), { side: 'old', keys: ['Enter'] }, pause(), screen('view'), ...esc()], ['status', 'empty state'], ['Released TUI first Enter accepts argument completion; second Enter submits.']),
  view('D-markitdown', '/markitdown', ['status']),
  s('D-rtk', '/rtk show', [...command('/rtk show'), { side: 'old', keys: ['Enter'] }, pause(), screen('view'), ...esc()], ['status'], ['Released TUI first Enter accepts argument completion; second Enter submits.']),
  view('D-codebase-memory', '/codebase-memory', ['status']),
  view('D-dependencies', '/dependencies', ['checklist', 'wording']),
  view('D-progressive-context', '/progressive-context', ['list layout']),
];
