import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function testBackgroundBashTools(runtime, workspace) {
  const extensionErrors = [];
  await runtime.session.bindExtensions({ mode: 'print', onError: (error) => extensionErrors.push(error) });
  const ownedJobs = new Set();
  const ownedPids = new Set();
  const interactivePath = join(workspace, 'background-smoke-interactive.mjs');
  const silentPath = join(workspace, 'background-smoke-silent.mjs');
  const pidPath = join(workspace, 'background-smoke-pids.json');
  const cancellation = new AbortController();
  let foreground;
  let sequence = 0;
  const call = async (name, params, signal) => {
    const tool = runtime.session.agent.state.tools.find((tool) => tool.name === name);
    assert.ok(tool, `Registered tool is missing: ${name}`);
    return tool.execute(`background-smoke-${++sequence}`, params, signal);
  };
  const remember = (job) => {
    ownedJobs.add(job.meta?.id ?? job.id);
    if (job.status?.pid ?? job.pid) ownedPids.add(job.status?.pid ?? job.pid);
  };
  await writeFile(interactivePath, [
    "console.log('tty=' + process.stdin.isTTY + '/' + process.stdout.isTTY);",
    "setInterval(() => console.log('heartbeat'), 1000);",
    'setTimeout(() => process.exit(99), 30000);',
    "process.stdin.setEncoding('utf8');",
    "let pending = '';",
    "process.stdin.on('data', (value) => {",
    '  pending += value;',
    "  while (pending.includes('\\n')) {",
    "    const end = pending.indexOf('\\n');",
    '    const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);',
    "    console.log('input:' + line);",
    "    if (line === 'exit7') { console.log('final-output'); process.exit(7); }",
    '  }',
    '});',
  ].join('\n'));
  await writeFile(silentPath, [
    "import { writeFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify([process.pid, child.pid]));`,
    "process.stdin.on('data', () => console.log('received-input'));",
    'setTimeout(() => process.exit(99), 30000);',
  ].join('\n'));

  const errors = [];
  try {
    const largeOutput = "process.stdout.write('old line\\n'.repeat(40000) + 'tail-one\\ntail-two 🌍\\n'); process.exitCode = 7;";
    for (const params of [{}, { background: true }, { background: true, tty: true }]) {
      const result = await call('bash', { command: `node -e ${JSON.stringify(largeOutput)}`, timeout: 10, ...params });
      remember(result.details);
      if (params.background) {
        const job = (await call('wait_background_bash', { id: result.details.id, timeout: 5 })).details.job;
        remember(job);
        assert.equal(job.status.exitCode, 7);
        const tail = await call('read_background_bash', { id: result.details.id, lines: 2 });
        assert.match(tail.content[0].text, /\ntail-one\ntail-two 🌍$/u);
        assert.doesNotMatch(tail.content[0].text, /old line/);
      } else {
        assert.equal(result.details.background, false);
        assert.match(result.content[0].text, /tail-one\ntail-two 🌍/u);
      }
    }

    const started = await call('bash', { command: `node ${JSON.stringify(interactivePath)}`, tty: true, background: true });
    remember(started.details);
    const id = started.details.id;
    await delay(6_100);
    const listed = await deadline(call('list_background_bash', { status: 'running' }), 'list long-lived PTY');
    assert.ok(listed.details.jobs.some((job) => job.meta.id === id));
    assert.match((await call('read_background_bash', { id })).content[0].text, /heartbeat/);
    assert.equal((await call('wait_background_bash', { id, timeout: 0 })).details.timedOut, true);

    await runtime.session.reload();
    await call('write_background_bash', { id, chars: 'Привет 🌍\nexit7\n' });
    const finished = (await call('wait_background_bash', { id, timeout: 5 })).details.job;
    assert.equal(finished.status.status, 'failed');
    assert.equal(finished.status.exitCode, 7);
    const output = (await call('read_background_bash', { id })).content[0].text;
    assert.match(output, /tty=true\/true/);
    assert.equal(output.split('input:Привет 🌍').length - 1, 1);
    assert.match(output, /final-output/);
    const terminalStatus = JSON.stringify(finished.status);
    await delay(30);
    await call('list_background_bash', {});
    await call('read_background_bash', { id });
    assert.equal(JSON.stringify((await call('wait_background_bash', { id, timeout: 0 })).details.job.status), terminalStatus);

    const command = `node ${JSON.stringify(silentPath)}`;
    foreground = call('bash', { command, tty: true, timeout: 20 }, cancellation.signal)
      .then((value) => ({ value }), (error) => ({ error }));
    for (let attempt = 0; ; attempt += 1) {
      try {
        for (const pid of JSON.parse(await readFile(pidPath, 'utf8'))) ownedPids.add(pid);
        break;
      } catch (error) {
        if (attempt >= 100) throw error;
        await delay(20);
      }
    }
    const active = await deadline(call('list_background_bash', { status: 'running' }), 'list during foreground PTY wait');
    const running = active.details.jobs.find((job) => job.meta.command === command);
    assert.ok(running, 'Foreground PTY missing from running jobs');
    remember(running);
    await deadline(call('read_background_bash', { id: running.meta.id }), 'read during foreground PTY wait');
    await deadline(call('write_background_bash', { id: running.meta.id, chars: 'hello\n' }), 'write during foreground PTY wait');
    const stopped = await deadline(call('stop_background_bash', { id: running.meta.id, signal: 'SIGTERM' }), 'stop during foreground PTY wait');
    assert.equal(stopped.details.job.status.status, 'killed');
    assert.equal(stopped.details.job.status.signal, 'SIGTERM');
    const foregroundResult = await deadline(foreground, 'foreground PTY completion after stop');
    assert.ifError(foregroundResult.error);
    assert.equal(foregroundResult.value.details.background, false);
    assert.equal(foregroundResult.value.details.status, 'killed');
    assert.deepEqual(extensionErrors, [], 'Unexpected extension lifecycle errors');
  } catch (error) {
    errors.push(error);
  } finally {
    cancellation.abort();
    if (foreground) {
      try { await deadline(foreground, 'foreground cancellation cleanup'); }
      catch (error) { errors.push(error); }
    }
    const cleanup = await Promise.allSettled([...ownedJobs].map((id) => call('stop_background_bash', { id, signal: 'SIGKILL' })));
    errors.push(...cleanup.filter((result) => result.status === 'rejected').map((result) => result.reason));
    for (const pid of ownedPids) {
      try {
        process.kill(pid, 0);
        errors.push(new Error(`Background Bash smoke process ${pid} survived cleanup`));
      } catch (error) {
        if (error.code !== 'ESRCH') errors.push(error);
      }
    }
    await Promise.all([interactivePath, silentPath, pidPath].map((path) => rm(path, { force: true })));
  }
  if (errors.length) throw new AggregateError(errors, 'Background Bash registered-tool smoke failed');
  return 'large foreground/background log tails, long-lived PTY, reload, Unicode/final output, stable terminal status, concurrent list/read/write/stop, descendant cleanup';
}

async function deadline(promise, operation) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${operation}`)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
