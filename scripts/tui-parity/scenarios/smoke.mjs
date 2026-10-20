import { pause, screen, keys, command, esc, idle } from './helpers.mjs';
export default [{
  id: 'smoke', area: 'A', title: 'Startup, full slash list, settings and one greeting',
  steps: [pause(), screen('startup'), { text: '/' }, pause(), screen('slash-list'), { commands: true },
    ...esc(), keys('C-u'), ...command('/settings', 'General'), screen('settings'), ...esc(), keys('C-u'),
    { prompt: 'say hi' }, idle(), screen('greeting')],
  observe: ['startup header, editor and footer', 'complete slash list', 'settings layout', 'greeting and streaming timeline'],
  intentional: ['daemon-only commands', 'versions and model prose'],
}];
