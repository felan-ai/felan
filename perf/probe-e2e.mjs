import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { now, sleep } from './lib.mjs';
import { accepted, startProvider, stopChild, connect, closeClient, prompt } from './setup-session.mjs';

export async function run(ctx) {
  const fake = await startProvider(ctx);
  let client;
  const windows = [];
  const request = async (op, params, options) => {
    const start = now();
    const response = await client.request(op, params, options);
    const end = now();
    accepted(response);
    windows.push({ op, start, end });
    return { result: response.result, duration: end - start };
  };
  try {
    const start = now(); client = await connect(fake.port, true);
    ctx.value('connect-and-launch', now() - start);
    for (const op of ['host.status', 'sessions.list']) {
      const values = [];
      for (let i = -3; i < (ctx.quick ? 10 : 50); i++) {
        const { duration } = await request(op, op === 'sessions.list' ? { cwd: process.env.PROBE_CWD } : {});
        if (i >= 0) values.push(duration);
      }
      ctx.samples(`${op}.RTT`, values);
    }
    const created = await request('sessions.create', { cwd: process.env.PROBE_CWD, source: 'headless' });
    const session = created.result.sessionId;
    ctx.value('sessions.create', created.duration);
    const attachStart = now(); const attached = accepted(await client.attach(session));
    ctx.value('attach.empty', now() - attachStart, 'ms', { bytes: Buffer.byteLength(JSON.stringify(attached.snapshot)) });
    await request('set_model', { provider: 'fake', id: 'fake-model' }, { session });
    const seen = new Set();
    for (let turn = 1; turn <= 3; turn++) await ctx.case(`turn.${turn}`, async () => {
      const latencies = [];
      let first;
      const start = now();
      let ack;
      let notifications = 0;
      // prompt() owns completion and this wrapper records the actual request acknowledgement.
      const original = client.request.bind(client);
      client.request = async (...args) => { const response = await original(...args); if (args[0] === 'prompt') ack = now(); return response; };
      try {
        await prompt(client, session, 'go', snap => {
          notifications++;
          const time = now();
          const texts = [...snap.activeStreams.map(s => s.text), ...snap.history.entries.filter(m => m.role === 'assistant').flatMap(m => m.content.filter(c => c.type === 'text').map(c => c.text))];
          for (const text of texts) for (const match of text.matchAll(/(?:⟦|zz)([0-9]+\.[0-9]+)(?:⟧|zz)/gu)) {
            if (seen.has(match[1])) continue;
            seen.add(match[1]); latencies.push(time - Number(match[1])); first ??= time;
          }
        });
      } finally { client.request = original; }
      const end = now();
      windows.push({ op: 'prompt', start, end: ack });
      windows.push({ op: 'whole-turn', start, end });
      assert.equal(latencies.length, fake.tokens, 'Fake-provider token count mismatch');
      ctx.value(`turn.${turn}.prompt-ack`, ack - start);
      ctx.value(`turn.${turn}.first-token`, first - start);
      ctx.samples(`turn.${turn}.provider-to-client`, latencies, 'ms', { notifications, tokens: fake.tokens, interval: fake.interval });
    });
    const thinking = [];
    for (const level of ['low', 'medium', 'high', 'low']) thinking.push((await request('set_thinking', { thinking: level }, { session })).duration);
    ctx.samples('set_thinking.RTT', thinking);
    await client.detach(session);
    const reattachStart = now(); const reattached = accepted(await client.attach(session));
    ctx.value('attach.after-three-turns', now() - reattachStart, 'ms', { bytes: Buffer.byteLength(JSON.stringify(reattached.snapshot)), entries: reattached.snapshot.history.entries.length });
    if (process.env.DPROF_FILE) await sleep(Number(process.env.DPROF_MS) + 100);
    const events = readFileSync(process.env.COMMIT_LOG, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const fsyncs = events.filter(event => event.kind === 'fsync');
    ctx.value('explicit-fsync.total-count', fsyncs.length, 'fsyncs');
    ctx.value('explicit-fsync.total-duration', fsyncs.reduce((sum, event) => sum + event.duration, 0));
    const grouped = new Map();
    for (const window of windows) {
      const commits = events.filter(e => e.kind === 'commit' && e.start >= window.start && e.start <= window.end);
      const record = grouped.get(window.op) || { counts: [], durations: [] };
      record.counts.push(commits.length); record.durations.push(commits.reduce((sum, e) => sum + e.duration, 0));
      grouped.set(window.op, record);
    }
    for (const [op, values] of grouped) {
      ctx.samples(`commits.${op}.count`, values.counts, 'commits');
      ctx.samples(`commits.${op}.duration`, values.durations);
    }
  } finally { await closeClient(client); await stopChild(fake.provider); }
}
