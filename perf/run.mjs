#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { ROOT, HERE } from './lib.mjs';
import { createIsolation, cleanupIsolation, processesUsing } from './isolation.mjs';

const available = ['protocol', 'daemon', 'transport', 'fanout', 'e2e', 'tui', 'idle'];
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Usage: node perf/run.mjs [${available.join('|')}] [--quick] [--profile]\nDefault: all suites. Results: perf/results/. --profile instruments the e2e daemon.`);
  process.exit(0);
}
if (args.some(arg => arg.startsWith('-') && !['--quick', '--profile'].includes(arg))) throw new Error('Unknown option; use --help');
const suites = args.filter(arg => !arg.startsWith('-'));
if (suites.some(suite => !available.includes(suite))) throw new Error('Unknown suite; use --help');
if (!suites.length) suites.push(...available);
const quick = args.includes('--quick');
const git = (...args) => { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } };
const started = new Date().toISOString();
const id = started.replace(/[:.]/g, '-') + `-${process.pid}`;
const outdir = join(HERE, 'results');
mkdirSync(outdir, { recursive: true });
const report = { format: 1, started, quick, profile: args.includes('--profile'), git: { sha: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')) },
  machine: { platform: os.platform(), release: os.release(), arch: os.arch(), cpus: os.cpus().length, cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(), node: process.version }, results: [], isolation: [] };
let active;
let interrupted = false;
let interruptTimer;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  interrupted = true;
  if (active) {
    const worker = active;
    worker.kill('SIGTERM');
    interruptTimer ??= setTimeout(() => worker.kill('SIGKILL'), 2500);
  }
});
const sanitize = text => String(text).replaceAll(ROOT.replace(/\/$/, ''), '<repo>');
try {
  for (const suite of suites) {
    if (interrupted) break;
    const isolation = createIsolation();
    const env = { ...isolation.env, COMMIT_LOG: join(isolation.root, 'commits.jsonl') };
    if (report.profile && suite === 'e2e') {
      env.DPROF_FILE = join(outdir, `${id}-daemon.cpuprofile`);
      env.DPROF_MS = quick ? '1500' : '6000';
    }
    const time = performance.now();
    let output = '';
    let timedOut = false;
    let timer;
    let killTimer;
    try {
      const worker = spawn(process.execPath, [join(HERE, 'worker.mjs'), suite, ...(quick ? ['--quick'] : [])], { env, cwd: isolation.env.PROBE_CWD, stdio: ['ignore', 'pipe', 'pipe'] });
      active = worker;
      worker.stdout.on('data', data => { output = (output + data).slice(-12000); });
      worker.stderr.on('data', data => { output = (output + data).slice(-12000); });
      timer = setTimeout(() => {
        timedOut = true; worker.kill('SIGTERM');
        killTimer = setTimeout(() => worker.kill('SIGKILL'), 2500);
      }, (quick ? 90 : 300) * 1000);
      const code = await new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
      active = undefined;
      let records;
      try { records = JSON.parse(readFileSync(join(isolation.root, 'result.json'), 'utf8')); } catch { records = []; }
      if (timedOut || interrupted || !records.length) records.push({ name: suite, status: 'fail', reason: timedOut ? 'Worker timed out' : interrupted ? 'Interrupted' : `Worker exited ${code}: ${sanitize(output).replaceAll(isolation.root, '<isolated>').trim()}` });
      report.results.push(...records.map(record => ({ suite, ...record })));
      if (code && records.every(record => record.status !== 'fail')) report.results.push({ suite, name: 'worker', status: 'fail', reason: `Worker exited ${code}` });
    } catch (error) { report.results.push({ suite, name: suite, status: 'fail', reason: sanitize(error.message) }); }
    finally {
      clearTimeout(timer); clearTimeout(killTimer); clearTimeout(interruptTimer); active = undefined;
      try { await cleanupIsolation(isolation); } catch (error) { report.results.push({ suite, name: 'cleanup', status: 'fail', reason: sanitize(error.message) }); }
      report.isolation.push({ suite, root: isolation.root, remainingProcesses: processesUsing(isolation.root).map(p => p.pid), directoryExists: existsSync(isolation.root) });
    }
    console.log(`${suite}: ${((performance.now() - time) / 1000).toFixed(1)} s`);
  }
} finally {
  report.finished = new Date().toISOString();
  const file = join(outdir, `${id}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.table(report.results.map(({ suite, name, status, value, unit, p99, reason }) => ({ suite, metric: name, status, value: value === undefined ? '' : `${value.toFixed(4)} ${unit}`, p99: p99?.toFixed(4) ?? '', note: reason?.slice(0, 120) ?? '' })));
  console.log(`Results: perf/results/${id}.json`);
}
if (interrupted || report.results.some(result => result.status === 'fail')) process.exitCode = 1;
