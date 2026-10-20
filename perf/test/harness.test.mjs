import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { snapshot, transcript } from '../fixtures.mjs';
import { context, Skip, quantiles, HERE, ROOT, dependency } from '../lib.mjs';
import { createIsolation, cleanupIsolation } from '../isolation.mjs';
import { SQLITE_CASES } from '../bench-daemon.mjs';

test('fixtures are deterministic, varied, and exactly 5 MiB', () => {
  assert.deepEqual(snapshot(), snapshot());
  assert.notDeepEqual(transcript(1, 1), transcript(1, 2));
  assert.equal(Buffer.byteLength(JSON.stringify(snapshot({ large: true }))), 5 * 1024 * 1024);
  const text = JSON.stringify(transcript());
  for (const value of ['中文', '🐈', 'tool_call', 'tool_result', 'thinking']) assert.ok(text.includes(value));
});
test('per-case failures and skips do not stop later metrics', async () => {
  const rows = []; const ctx = context(true, rows);
  await ctx.case('failed', () => { throw new Error('fixture failed'); });
  await ctx.case('skipped', () => { throw new Skip('optional'); });
  await ctx.case('ok', () => ctx.samples('sample', [3, 1, 2]));
  assert.deepEqual(rows.map(row => row.status), ['fail', 'skip', 'ok']);
  assert.equal(rows[2].value, 2);
  assert.throws(() => quantiles([]));
  assert.throws(() => ctx.value('invalid', NaN));
});
test('SQLite case names include the exact shipped control-store pragmas', () => {
  assert.deepEqual(SQLITE_CASES.map(([label]) => label), ['FULL-fullfsync', 'FULL', 'NORMAL', 'shipped']);
  const source = readFileSync(join(ROOT, 'apps/daemon/src/daemon/persistence.ts'), 'utf8');
  const pragmas = source.match(/^const PRAGMAS = '([^']+)';$/m)?.[1];
  assert.ok(pragmas, 'Control-store PRAGMAS must be available for comparison');
  const normalize = sql => sql.split(';').map(statement => statement.replace(/\s/g, '').toLowerCase()).filter(Boolean).sort();
  assert.deepEqual(normalize(SQLITE_CASES.find(([label]) => label === 'shipped')[1]), normalize(pragmas));
});
test('isolated environment has no ambient credentials and cleans its tree', async () => {
  const isolation = createIsolation();
  try {
    const child = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify(process.env))'], { env: isolation.env, encoding: 'utf8' });
    assert.equal(child.status, 0);
    const env = JSON.parse(child.stdout);
    assert.equal(env.HOME, isolation.root);
    assert.equal(env.PROBE_RUNTIME, isolation.runtime);
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'NODE_OPTIONS']) assert.equal(env[name], undefined);
    for (const name of ['HOME', 'TMPDIR', 'FELAN_AGENT_DIR', 'PI_CODING_AGENT_DIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR']) assert.ok(env[name].startsWith(isolation.root));
  } finally { await cleanupIsolation(isolation); }
  assert.equal(existsSync(isolation.root), false);
});
test('cleanup refuses unrelated paths', async () => {
  await assert.rejects(cleanupIsolation({ root: '/tmp/not-owned', runtime: '/tmp/not-owned/rt' }), /Refusing cleanup/);
});
test('cleanup stops a provider carrying this run runtime', async () => {
  const isolation = createIsolation();
  const child = spawn(process.execPath, [join(HERE, 'fake-provider.mjs'), '--runtime', isolation.runtime], { env: isolation.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Provider failed to start'); })]);
  } finally { await cleanupIsolation(isolation); }
  await exited;
  assert.equal(existsSync(isolation.root), false);
});
test('dependency lookup reports an unavailable optional dependency', async () => {
  await assert.rejects(dependency('@felan-perf/nonexistent'), Skip);
});
test('fsync instrumentation updates named ESM built-in imports', async () => {
  const isolation = createIsolation();
  const log = join(isolation.root, 'commits.jsonl');
  try {
    const code = `import { openSync, fsyncSync, closeSync } from 'node:fs';
      await import(${JSON.stringify(new URL('../count-commits.mjs', import.meta.url).href)});
      const fd = openSync(process.env.HOME + '/file', 'w'); fsyncSync(fd); closeSync(fd);`;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, '/daemon-host.js'], { env: { ...isolation.env, COMMIT_LOG: log }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(readFileSync(log, 'utf8').trim()).kind, 'fsync');
  } finally { await cleanupIsolation(isolation); }
});
test('cleanup escalates an unresponsive owned daemon before removing its runtime', async () => {
  const isolation = createIsolation();
  const code = `const fs = require('node:fs');
    process.on('SIGTERM', () => console.log('term-root-present=' + fs.existsSync(process.env.HOME)));
    setInterval(() => {}, 1000); console.log('ready');`;
  const child = spawn(process.execPath, ['-e', code, '--', '/daemon-host.js', isolation.runtime], { env: isolation.env, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', data => { output += data; });
  await once(child.stdout, 'data');
  await cleanupIsolation(isolation);
  await exited;
  assert.equal(child.signalCode, 'SIGKILL');
  assert.match(output, /term-root-present=true/);
  assert.equal(existsSync(isolation.root), false);
});
