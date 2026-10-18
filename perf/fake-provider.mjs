import http from 'node:http';
import { now, isolatedRuntime } from './lib.mjs';

isolatedRuntime();
const tokens = Number(process.env.FAKE_TOKENS || 400);
const interval = Number(process.env.FAKE_INTERVAL_MS || 5);
const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
  let body = '';
  req.on('data', data => { body += data; if (body.length > 16 * 1024 * 1024) req.destroy(); });
  req.on('end', () => {
    let messages;
    try { messages = JSON.parse(body).messages; } catch { res.writeHead(400).end(); return; }
    const user = messages?.filter(m => m.role === 'user').at(-1);
    const seed = JSON.stringify(user?.content || '').includes('seed ');
    const count = seed ? Number(process.env.SEED_TOKENS || 600) : tokens;
    // A synchronous seed burst can overflow older fanout implementations before their socket flush.
    const spacing = seed ? Number(process.env.SEED_INTERVAL_MS || 1) : interval;
    let timer;
    let index = 0;
    res.on('close', () => clearTimeout(timer));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.socket?.setNoDelay(true);
    const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'perf-completion', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 10, completion_tokens: count, total_tokens: count + 10 } } : {}) })}\n\n`;
    res.write(chunk({ role: 'assistant', content: '' }));
    const tick = () => {
      if (res.destroyed) return;
      if (index++ >= count) { res.write(chunk({}, 'stop')); res.end('data: [DONE]\n\n'); return; }
      const stamp = now().toFixed(3);
      res.write(chunk({ content: process.env.ASCII_MARK === '1' ? `zz${stamp}zz ` : `⟦${stamp}⟧ ` }));
      timer = setTimeout(tick, Math.max(1, spacing));
    };
    tick();
  });
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: server.address().port })));
