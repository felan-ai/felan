import { spawn, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { HERE, ROOT, skip } from './lib.mjs';
import { startProvider, stopChild, connect, closeClient, createSession } from './setup-session.mjs';

export async function run(ctx) {
  if (spawnSync('python3', ['--version']).status !== 0) skip('python3 is required for PTY measurements');
  const fake = await startProvider(ctx, { FAKE_TOKENS: ctx.quick ? '180' : '600', FAKE_INTERVAL_MS: ctx.quick ? '5' : '10' });
  let client;
  try {
    client = await connect(fake.port);
    const variants = process.env.SEED_TURNS ? [Number(process.env.SEED_TURNS)] : [0, ctx.quick ? 2 : 30];
    for (const turns of variants) await ctx.case(`history.${turns}`, async () => {
      const session = await createSession(client, turns);
      await client.detach(session);
      const env = { ...process.env, PERF_QUICK: ctx.quick ? '1' : '0', PERF_EXPECT_TOKENS: String(fake.tokens), PERF_INTERVAL_MS: String(fake.interval) };
      delete env.CI;
      const child = spawn('python3', [join(HERE, 'pty-driver.py'), process.execPath, join(ROOT, 'apps/felan/dist/cli.js'), '--daemon-runtime', process.env.PROBE_RUNTIME, '--session', session], {
        env, cwd: process.env.PROBE_CWD, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
      const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      const rows = JSON.parse(stdout.trim() || '[]');
      if (!rows.length) throw new Error(`PTY exited ${code}: ${stderr}`);
      for (const row of rows) {
        if (row.status !== 'ok') throw new Error(row.reason);
        const { name, status, value, unit, ...details } = row;
        ctx.value(`history.${turns}.${name}`, value, unit, { ...details, seedTurns: turns, columns: 220, rows: 60 });
      }
      if (code) throw new Error(`PTY exited ${code}: ${stderr}`);
    });
  } finally { await closeClient(client); await stopChild(fake.provider); }
}
