#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const sides = ['old', 'new'];
const files = ['auth.json', 'models-store.json', 'settings.json'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const safeName = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(value);
const stripAnsi = value => value.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

export function normalize(value, run = '') {
  if (run) value = value.replaceAll(run, '<run>');
  return stripAnsi(value)
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b\d+\.\d+\.\d+(?:-[\w.-]+)?\b/g, '<version>')
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g, '<date>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\b/g, '<time>')
    .replace(/\$\s*\d+(?:\.\d+)?/g, '$<cost>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|minutes?|hours?|tokens?|tok|tps)\b/gi, '<amount>')
    .replace(/([↑↓↗↙])\s*\d+(?:\.\d+)?[kKmM]?/g, '$1<count>')
    .replace(/\b\d+(?:\.\d+)?[kKmM]\b/g, '<count>')
    .replace(/\b(?:\d+d)?\d+h(?:\d+m)?\b|\b\d+d\b/g, '<elapsed>')
    .replace(/\/(?:[^\s/]+\/)*(?:old|new)-workspace\b/g, '<workspace>')
    .replace(/\b(tokens?|input|output|elapsed|duration|cost)\s*[:=]\s*\d+(?:\.\d+)?/gi, '$1:<amount>')
    .split('\n').map(line => line.trimEnd()).join('\n').trimEnd();
}

function homePaths(value, home, prefix = '') {
  if (typeof value === 'string') return value.includes(home) ? [prefix] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => homePaths(item, home, prefix ? `${prefix}.${key}` : key));
}

function seedProviders(settings) {
  const providers = new Set(settings.defaultProvider ? [settings.defaultProvider] : []);
  const reference = value => { if (typeof value === 'string' && value.includes('/')) providers.add(value.split('/')[0]); };
  reference(settings.defaultModel);
  function visit(value, inFusion = false) {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      const fusion = inFusion || /fusion/i.test(key);
      if (fusion && (key === 'participants' || key === 'fusionModel')) {
        for (const ref of Array.isArray(item) ? item : [item]) reference(ref);
      }
      visit(item, fusion);
    }
  }
  visit(settings);
  return [...providers];
}

function expiringProviders(auth, maxRunMs, now = Date.now()) {
  return Object.entries(auth).filter(([, credential]) => credential?.type === 'oauth'
    && (!Number.isFinite(credential.expires) || credential.expires <= now + maxRunMs + 3600000)).map(([provider]) => provider);
}

function changedCredentials(seed, actual) {
  return [...new Set([...Object.keys(seed), ...Object.keys(actual)])].filter(provider => {
    try { assert.deepEqual(actual[provider], seed[provider]); return false; } catch { return true; }
  });
}

function stableScreen(condition, screen, previous, stableSince, now) {
  const since = screen === previous ? stableSince : now;
  const busy = /working|thinking|generating|running\.\.\.|esc to (?:cancel|interrupt)/i.test(screen.split('\n').slice(-6).join('\n'));
  return { since, ready: now - since >= (condition.settle ? 500 : 2500) && (condition.settle || !busy) };
}

async function waitForScreen(side, condition, { capture, check, observe, now = Date.now, pause = sleep }) {
  if ('ms' in condition) { await pause(condition.ms); check(); return; }
  const deadline = now() + condition.timeoutMs;
  let previous, stableSince = now();
  while (now() < deadline) {
    check();
    const screen = stripAnsi(await capture(side));
    if (condition.text && screen.toLowerCase().includes(condition.text.toLowerCase())) return;
    if (condition.startup && /Felan Code|trust this (?:folder|project|directory)|trust.*(?:folder|workspace)|folder.*trust/i.test(screen)) return;
    if (condition.idle || condition.settle) {
      const state = stableScreen(condition, screen, previous, stableSince, now());
      stableSince = state.since;
      if (state.ready) return;
    }
    previous = screen;
    await pause(150);
  }
  check();
  if (condition.settle || condition.onTimeout === 'observe') {
    observe({ side, condition, detail: condition.settle ? `screen did not settle within ${condition.timeoutMs} ms` : `${JSON.stringify(condition.text)} not shown within ${condition.timeoutMs} ms` });
    return;
  }
  throw new Error(`${side}: wait timed out: ${JSON.stringify(condition)}`);
}

function sgrSummary(ansi) {
  return ansi.split('\n').map((line, index) => ({ line: index + 1, sgr: [...line.matchAll(/\x1b\[[0-9;:]*m/g)].map(match => match[0].slice(2, -1)) }));
}

export function validate(scenarios) {
  assert(Array.isArray(scenarios) && scenarios.length, 'Scenario array required');
  const ids = new Set();
  for (const scenario of scenarios) {
    assert(safeName(scenario.id) && !ids.has(scenario.id), `Invalid/duplicate id: ${scenario.id}`);
    ids.add(scenario.id);
    assert(/^[ABCD]$/.test(scenario.area), `Invalid area: ${scenario.id}`);
    assert(typeof scenario.title === 'string' && scenario.title.length, 'Title required');
    for (const field of ['observe', 'intentional']) assert(Array.isArray(scenario[field]) && scenario[field].every(v => typeof v === 'string'), `${field} must be strings`);
    assert(Array.isArray(scenario.steps) && scenario.steps.length, 'Steps required');
    const checkpoints = new Set();
    for (const step of scenario.steps) {
      const kinds = Object.keys(step).filter(key => key !== 'side');
      assert(kinds.length === 1, `One action required in ${scenario.id}`);
      assert(step.side === undefined || sides.includes(step.side), 'Invalid side');
      const kind = kinds[0], value = step[kind];
      if (['text', 'prompt', 'blocked'].includes(kind)) assert(typeof value === 'string' && value.length, `${kind} must be text`);
      else if (kind === 'keys') assert((typeof value === 'string' && value.length) || (Array.isArray(value) && value.length && value.every(v => typeof v === 'string' && v.length)), 'Invalid keys');
      else if (kind === 'checkpoint') {
        assert(safeName(value) && !checkpoints.has(`${step.side ?? 'both'}:${value}`), 'Invalid/duplicate checkpoint');
        checkpoints.add(`${step.side ?? 'both'}:${value}`);
      } else if (kind === 'wait') {
        assert(value && typeof value === 'object', 'Invalid wait');
        const modes = ['ms', 'text', 'idle', 'settle'].filter(key => key in value);
        assert(modes.length === 1 && Object.keys(value).every(key => [...modes, 'timeoutMs', 'onTimeout'].includes(key)), 'One wait mode required');
        assert(value.onTimeout === undefined || (modes[0] === 'text' && value.onTimeout === 'observe'), 'Only text waits support onTimeout: observe');
        if (modes[0] === 'ms') assert(Number.isFinite(value.ms) && value.ms >= 0 && value.ms <= 300000, 'Invalid ms');
        else {
          assert(modes[0] === 'text' ? typeof value.text === 'string' && value.text.length : (value.idle === true || value.settle === true), 'Invalid wait condition');
          assert(Number.isFinite(value.timeoutMs) && value.timeoutMs > 0 && value.timeoutMs <= 300000, 'Timeout required');
        }
      } else if (kind === 'resize') assert(Array.isArray(value) && value.length === 2 && value.every(v => Number.isInteger(v) && v >= 20 && v <= 300), 'Invalid size');
      else if (kind === 'commands') assert(value === true, 'commands must be true');
      else if (kind === 'daemonStop') assert(value === 'force' && step.side === 'new', 'Force stop is new-side only');
      else assert.fail(`Unknown action: ${kind}`);
      if ((kind === 'prompt' && scenario.id !== 'smoke') || (kind === 'text' && /\/fusion\s/.test(value))) assert(scenario.paid === true, `Mark paid scenario: ${scenario.id}`);
      assert(!['text', 'prompt'].includes(kind) || !/^\/login\s+\S/.test(value), 'Login completion is forbidden');
    }
  }
  return scenarios;
}

async function catalog() {
  return validate((await Promise.all(['A', 'B', 'C', 'D', 'smoke'].map(async name => (await import(`./scenarios/${name}.mjs`)).default))).flat());
}

async function command(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: repo, ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    options.onSpawn?.(child.pid);
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 45000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${path.basename(bin)} ${args[0] ?? ''} timed out after ${options.timeoutMs ?? 45000} ms: ${stderr || stdout}`));
      else if (code === 0 || options.allowedExitCodes?.includes(code)) resolve(stdout);
      else reject(new Error(`${path.basename(bin)} ${args[0] ?? ''} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function snapshot(root) {
  const entries = [];
  async function visit(relative) {
    const full = path.join(root, relative);
    let stat;
    try { stat = await fs.lstat(full, { bigint: true }); } catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return; throw error; }
    entries.push([relative || '.', String(stat.size), String(stat.mtimeNs)]);
    if (stat.isDirectory()) {
      let names;
      try { names = await fs.readdir(full); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
      for (const name of names.sort()) await visit(path.join(relative, name));
    }
  }
  await visit('');
  return entries;
}

function concurrentActivity(relative) {
  return /^(?:sessions|subagents|storage\/sessions)(?:\/|$)/.test(relative)
    || /(?:^|\/)subscription-usage\.json\..*\.lease\.(?:reclaim|release)-[^/]+(?:\/|$)/.test(relative)
    || /^(?:storage\/agent\/)?codebase-memory\/cache\/(?:logs\/)?\.worker-(?:log|response)-[^/]+$/.test(relative)
    || /^storage\/agent\/codebase-memory\/cache\/logs\/[^/]+\.log$/.test(relative)
    // Live sessions index real repositories here; a sandbox leak would carry the sandbox workspace slug instead.
    || /^storage\/agent\/codebase-memory\/cache\/[^/]+\.db\.stage\.[^/]+$/.test(relative) && !/felan-parity/.test(relative)
    || /^(?:storage\/agent\/)?savings\/v1\/writers\/[^/]+\/\d+\.json$/.test(relative);
}

function guardChanges(before, after) {
  const previous = new Map(before.map(entry => [entry[0], entry]));
  const current = new Map(after.map(entry => [entry[0], entry]));
  const added = after.filter(entry => !previous.has(entry[0]));
  const removed = before.filter(entry => !current.has(entry[0]));
  return {
    added: added.filter(entry => !concurrentActivity(entry[0])),
    removed: removed.filter(entry => !concurrentActivity(entry[0])),
    concurrentActivity: { added: added.filter(entry => concurrentActivity(entry[0])), removed: removed.filter(entry => concurrentActivity(entry[0])) },
    modified: after.filter(entry => previous.has(entry[0]) && JSON.stringify(previous.get(entry[0])) !== JSON.stringify(entry)),
  };
}

async function scanGuardContent(root, entries, needles) {
  const result = { checked: 0, overLimit: [], vanished: [], concurrentVanished: [], hits: [], errors: [] };
  for (const [relative] of entries) {
    const full = path.join(root, relative);
    try {
      const stat = await fs.lstat(full);
      if (!stat.isFile()) continue;
      if (stat.size > 16 * 1024 * 1024) { result.overLimit.push(relative); continue; }
      const data = await fs.readFile(full);
      if (data.length > 16 * 1024 * 1024) { result.overLimit.push(relative); continue; }
      result.checked++;
      const matches = needles.filter(needle => data.includes(Buffer.from(needle.value))).map(needle => needle.label);
      if (matches.length) result.hits.push({ path: relative, matches });
    } catch (error) {
      if (error.code === 'ENOENT') (concurrentActivity(relative) ? result.concurrentVanished : result.vanished).push(relative);
      else result.errors.push({ path: relative, code: error.code });
    }
  }
  return result;
}

function processRows(output) {
  return output.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), uid: Number(match[3]), started: match[4], command: match[5] }] : [];
  });
}

function processRole(commandLine) {
  if (/codebase-memory|(?:^|[\s/])cbm(?:\s|$)/i.test(commandLine)) return 'codebase-memory/cbm child';
  if (/auth.*worker|worker.*auth/i.test(commandLine)) return 'auth worker';
  if (/daemon-host\.js/.test(commandLine)) return 'daemon';
  if (/\bdaemon (?:start|stop|status)\b/.test(commandLine)) return 'daemon control';
  if (/cli\.js|(?:^|[\s/])felan(?:\s|$)/.test(commandLine)) return 'TUI client';
  return 'descendant';
}

function environmentValue(output, key) {
  return [...output.matchAll(new RegExp(`(?:^|\\s)${key}=([^\\s]*)`, 'g'))].at(-1)?.[1] ?? null;
}

function verifiedAncestor(row, current, observed) {
  const visited = new Set([row.pid]);
  for (let parent = current.get(row.ppid); parent && !visited.has(parent.pid); parent = current.get(parent.ppid)) {
    visited.add(parent.pid);
    if (parent.uid !== row.uid) return undefined;
    const prior = observed.get(`${parent.pid}:${parent.started}`);
    if (prior?.passed && prior.inspection === 'verified' && prior.uid === parent.uid && prior.command === parent.command) return prior;
  }
}

function executablePath(comm, files, pid) {
  if (path.isAbsolute(comm)) return comm;
  const match = files.match(/^p(\d+)\nftxt\nn([^\n]+)/);
  return match && Number(match[1]) === pid && path.basename(match[2]) === comm ? match[2] : '';
}

function inspectEnvironment(row, output, executable, side, ancestor, home, env, platform = process.platform) {
  const actualHome = environmentValue(output, 'HOME');
  const agentDir = environmentValue(output, 'FELAN_AGENT_DIR');
  side ??= sides.find(candidate => actualHome === home(candidate)) ?? ancestor?.side;
  const verified = row.uid === process.getuid() && !!side && actualHome === home(side) && agentDir === env(side).FELAN_AGENT_DIR;
  const readable = /(?:^|\s)[A-Za-z_][A-Za-z_0-9]*=/.test(output);
  const inherited = !readable && platform === 'darwin' && row.uid === process.getuid()
    && /^\/(?:bin|usr\/bin|sbin|usr\/sbin|System)\//.test(executable)
    && ancestor?.passed && ancestor.inspection === 'verified' && ancestor.side === side;
  return { ...row, side, role: processRole(row.command), home: actualHome, agentDir,
    inspection: verified ? 'verified' : inherited ? 'inherited, not inspectable' : 'invalid',
    ...(executable ? { executable } : {}), ...(inherited ? { ancestorPid: ancestor.pid } : {}), passed: verified || !!inherited };
}

function processMonitor(root, home, env) {
  const roots = new Map(), observed = new Map(), violations = new Map(), exited = new Map(), errors = [];
  const sweepPids = new Set();
  let stopped = false, pending = Promise.resolve();
  const identity = row => `${row.pid}:${row.started}`;
  const same = (a, b) => a.uid === b.uid && a.started === b.started && a.command === b.command;
  const rows = async () => processRows(await command('ps', ['-axww', '-o', 'pid=,ppid=,uid=,lstart=,command=']));
  async function inspect(row, side) {
    const key = identity(row);
    if (row.command === '<defunct>') { exited.set(key, { ...row, side }); return; }
    let output;
    try { output = await command('ps', ['eww', '-o', 'command=', '-p', String(row.pid)]); }
    catch (error) {
      if (!(await rows()).some(item => item.pid === row.pid && same(item, row))) { exited.set(key, { ...row, side }); return; }
      throw error;
    }
    let executable = '';
    if (process.platform === 'darwin' && !/(?:^|\s)[A-Za-z_][A-Za-z_0-9]*=/.test(output)) {
      try {
        const comm = (await command('ps', ['-o', 'comm=', '-p', String(row.pid)])).trim();
        const files = path.isAbsolute(comm) ? '' : await command('/usr/sbin/lsof', ['-a', '-p', String(row.pid), '-d', 'txt', '-Fn']);
        executable = executablePath(comm, files, row.pid);
      }
      catch (error) {
        if (!(await rows()).some(item => item.pid === row.pid && same(item, row))) { exited.set(key, { ...row, side }); return; }
        throw error;
      }
    }
    const current = new Map((await rows()).map(item => [item.pid, item]));
    if (!current.has(row.pid) || !same(current.get(row.pid), row)) return;
    const item = inspectEnvironment(row, output, executable, side, verifiedAncestor(current.get(row.pid), current, observed), home, env);
    observed.set(key, item);
    if (!item.passed) violations.set(key, item);
    return item;
  }
  async function sample(sweep = false) {
    const sampledRoots = new Map(roots);
    const current = await rows(), byPid = new Map(current.map(row => [row.pid, row]));
    const daemons = new Set(matchingDaemons(current.map(row => `${row.pid} ${row.uid} ${row.command}`).join('\n'), root, process.execPath, path.join(repo, 'apps/felan/dist/daemon-host.js'), process.getuid()));
    const selected = new Map();
    for (const row of current) {
      const prior = observed.get(identity(row));
      if (prior && same(prior, row)) selected.set(row.pid, prior.side);
      const registered = roots.get(row.pid);
      if (registered && row.uid === process.getuid() && (!registered.started || registered.started === row.started)) {
        registered.started = row.started;
        selected.set(row.pid, registered.side);
      }
      if (daemons.has(row.pid)) selected.set(row.pid, 'new');
    }
    if (sweep) {
      const output = await command('ps', ['-E', '-axww', '-o', 'pid=,uid=,lstart=,command=']);
      for (const line of output.split('\n')) {
        if (!line.includes(root)) continue;
        const pid = Number(line.trim().split(/\s+/)[0]);
        if (!byPid.has(pid)) continue;
        sweepPids.add(pid);
        if (!selected.has(pid)) selected.set(pid, undefined);
      }
    }
    let changed;
    do {
      changed = false;
      for (const row of current) if (!selected.has(row.pid) && selected.has(row.ppid) && row.uid === process.getuid()) {
        selected.set(row.pid, selected.get(row.ppid)); changed = true;
      }
    } while (changed);
    const inspected = new Set();
    async function inspectSelected(pid) {
      if (inspected.has(pid)) return;
      inspected.add(pid);
      const parent = byPid.get(pid).ppid;
      if (selected.has(parent)) await inspectSelected(parent);
      const row = byPid.get(pid), prior = observed.get(identity(row));
      if (!prior || !same(prior, row)) await inspect(row, selected.get(pid));
    }
    for (const pid of selected.keys()) await inspectSelected(pid);
    for (const [pid, registered] of sampledRoots) {
      if (!byPid.has(pid) && roots.get(pid) === registered) roots.delete(pid);
    }
  }
  const check = (sweep = false) => {
    const result = pending.then(() => sample(sweep));
    pending = result.catch(error => { errors.push({ error: error.message }); });
    return result;
  };
  const worker = (async () => {
    while (!stopped) { await check().catch(() => {}); await sleep(250); }
  })();
  return {
    register: (pid, side) => { if (pid) roots.set(pid, { side }); },
    check,
    async remaining() {
      await check(true);
      return (await rows()).flatMap(row => {
        const prior = observed.get(identity(row));
        return prior && same(prior, row) && row.command !== '<defunct>' ? [{ ...prior, ...row }] : [];
      });
    },
    async revalidate(item) {
      const row = (await rows()).find(row => row.pid === item.pid && same(row, item));
      return row ? inspect(row, item.side) : undefined;
    },
    async stop() { stopped = true; await worker; await check(true); },
    report() {
      const required = ['old:TUI client', 'new:TUI client', 'new:daemon'];
      const missing = required.filter(role => ![...observed.values()].some(item => item.inspection === 'verified' && `${item.side}:${item.role}` === role));
      return { passed: !missing.length && !violations.size && !errors.length, missing, sampledProcesses: observed.size, finalSweepPids: [...sweepPids], violations: [...violations.values()], exitedBeforeEnvironmentRead: [...exited.values()], errors, processes: [...observed.values()] };
    },
  };
}

function secretStrings(value, all = false, key = '') {
  if (typeof value === 'string') return value.length >= 8 && (all && !['type', 'provider', 'email', 'accountId'].includes(key) || /token|secret|password|api.?key|authorization/i.test(key)) ? [value] : [];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => secretStrings(v, all, k));
}

function redactor(secrets) {
  return value => {
    for (const secret of [...new Set(secrets.flatMap(value => [value, JSON.stringify(value).slice(1, -1)]))].sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, '*'.repeat(secret.length));
    return value.replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, match => '*'.repeat(match.length)).replace(/\b(?:sk-[\w-]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, match => '*'.repeat(match.length));
  };
}

export function commandRows(screen) {
  return stripAnsi(screen).split('\n').flatMap(line => {
    const match = line.match(/^\s*[>❯›→]?\s*(\/?(?:[a-z][a-z0-9-]*|skill:[\w:./-]+))\s{2,}(\S.*)$/);
    if (!match) return [];
    return [{ name: `/${match[1].replace(/^\//, '')}`, description: match[2].trim() }];
  });
}

export function matchingDaemons(output, root, executable, entrypoint, uid) {
  return output.split('\n').flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[2]) !== uid) return [];
    const prefix = `${executable} ${entrypoint} `;
    if (!match[3].startsWith(prefix)) return [];
    try {
      const target = JSON.parse(match[3].slice(prefix.length));
      return target.kind === 'isolated' && target.directory === path.join(root, 'new') ? [Number(match[1])] : [];
    } catch { return []; }
  });
}

async function requestDaemonStop(daemon, forceOnly = false) {
  const result = { shutdown: [] };
  if (!forceOnly) {
    try {
      result.shutdown.push({ mode: 'drain', output: await daemon('stop', false, 5000) });
      return result;
    } catch (error) { result.shutdown.push({ mode: 'drain', error: error.message }); }
  }
  try { result.shutdown.push({ mode: 'force', output: await daemon('stop', true, 5000) }); }
  catch (error) {
    result.forceFailure = error.message;
    result.shutdown.push({ mode: 'force', error: error.message });
    try {
      result.status = await daemon('status', false, 3000);
      result.shutdown.push({ mode: 'status', output: result.status });
    } catch (error) {
      result.status = `status unavailable: ${error.message}`;
      result.shutdown.push({ mode: 'status', error: error.message });
    }
  }
  return result;
}

async function reapDaemons(monitor, record, { graceMs = 5000, signalGraceMs = 1000 } = {}) {
  const started = Date.now();
  const evidence = { graceMs: 0, lingering: [], unverified: [], survivors: [], reaped: [], errors: [], inspectionFailed: false };
  const persist = async () => { try { await record(evidence); } catch (error) { evidence.errors.push(error.message); } };
  try {
    do {
      evidence.lingering = await monitor.remaining();
      if (!evidence.lingering.length) break;
      await sleep(250);
    } while (Date.now() - started < graceMs);
    evidence.graceMs = Date.now() - started;
    await persist();
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      for (const item of await monitor.remaining()) {
        const current = await monitor.revalidate(item);
        if (!current) continue;
        if (!current.passed || current.inspection === 'inherited, not inspectable') {
          if (!evidence.unverified.some(row => row.pid === current.pid)) evidence.unverified.push(current);
          continue;
        }
        try { process.kill(current.pid, signal); evidence.reaped.push({ pid: current.pid, signal }); }
        catch (error) { if (error.code !== 'ESRCH') evidence.errors.push(error.message); }
      }
      if (!(await monitor.remaining()).length) break;
      await sleep(signalGraceMs);
    }
    evidence.survivors = await monitor.remaining();
  } catch (error) { evidence.inspectionFailed = true; evidence.errors.push(error.message); }
  await persist();
  return evidence;
}

async function removePrivateData(root) {
  async function privatePaths(directory) {
    const paths = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) paths.push(...await privatePaths(full));
      else if (files.includes(entry.name) || entry.name.endsWith('.raw.jsonl')) paths.push(full);
    }
    return paths;
  }
  const removed = await privatePaths(root);
  for (const full of removed) await fs.rm(full, { force: true });
  const remaining = await privatePaths(root);
  assert(!remaining.length, 'Private sandbox files remain after removal');
  return { removed: removed.map(full => path.relative(root, full)), remaining };
}

async function scenarioReports({ scenario, screens, frames, observations, root, artifact, save }) {
  for (const side of sides) await save(`${scenario.id}/frames.${side}.jsonl`, frames[side].map(frame => JSON.stringify(frame)).join('\n') + '\n');
  const lines = new Map();
  for (const side of sides) for (const frame of frames[side]) for (const line of normalize(frame.text, root).split('\n').filter(line => line.trim())) {
    const item = lines.get(line) ?? {};
    item.first = Math.min(item.first ?? Infinity, frame.runMs);
    item[side] ??= `step ${frame.step}, +${frame.ms}ms (${frame.runMs}ms total)`;
    lines.set(line, item);
  }
  const cell = text => String(text ?? '—').replaceAll('|', '\\|').replaceAll('<', '&lt;');
  await save(`${scenario.id}/timeline.md`, `# First appearance (150ms sampling; not event timestamps)\n\n| Normalized line | Old | New |\n| --- | --- | --- |\n${[...lines].sort((a, b) => a[1].first - b[1].first).map(([line, times]) => `| ${cell(line)} | ${cell(times.old)} | ${cell(times.new)} |`).join('\n')}\n`);
  let diff = '# Masked checkpoint comparison\n\nModel prose is intentionally not asserted; judge structure manually.\n';
  for (const name of new Set([...Object.keys(screens.old), ...Object.keys(screens.new)])) {
    const paths = [];
    for (const side of sides) {
      const relative = `${scenario.id}/${name}.${side}.normalized.txt`;
      await save(relative, normalize(screens[side][name] ?? '', root) + '\n');
      await save(`${scenario.id}/${name}.${side}.sgr.json`, json(sgrSummary(screens[side][name] ?? '')));
      paths.push(path.join(artifact, relative));
    }
    const unified = await command('git', ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', ...paths], { allowedExitCodes: [1] });
    diff += `\n## ${name}\n\n\`\`\`diff\n${unified}\`\`\`\n`;
  }
  await save(`${scenario.id}/diff.md`, diff);
  await save(`${scenario.id}/scenario.json`, json({ ...scenario, observations }));
}

async function run(options, scenarios) {
  await fs.access(path.join(repo, 'apps/felan/dist/cli.js')).catch(() => { throw new Error('Missing CLI build; run pnpm build first.'); });
  process.umask(0o077);
  const realHome = os.userInfo().homedir;
  const guarded = path.join(realHome, '.felan');
  const maxRunMs = (options.maxRunHours ?? 4) * 3600000;
  const seeds = Object.fromEntries(await Promise.all(files.map(async name => {
    const text = await fs.readFile(path.join(guarded, name), 'utf8');
    try { return [name, JSON.parse(text)]; } catch { throw new Error(`Invalid JSON in seed ${name}`); }
  })));
  for (const name of ['settings.json', 'models-store.json']) {
    const paths = homePaths(seeds[name], realHome);
    assert(!paths.length, `Unsafe home references in ${name} at key paths: ${paths.join(', ')}`);
  }
  const providers = options.providers ?? seedProviders(seeds['settings.json']);
  assert(providers.length, 'Cannot determine seed providers; use --providers');
  assert(providers.every(provider => Object.hasOwn(seeds['auth.json'], provider)), 'Requested provider has no seed credential');
  seeds['auth.json'] = Object.fromEntries(providers.map(provider => [provider, seeds['auth.json'][provider]]));
  const expiring = expiringProviders(seeds['auth.json'], maxRunMs);
  assert(!expiring.length, `OAuth credentials expire within max run duration + 1 h margin: ${expiring.join(', ')}`);
  const started = Date.now();
  const runId = options.id ?? `${Date.now().toString(36)}-${process.pid}`;
  assert(safeName(runId), 'Run id must be 1–48 letters, digits, hyphens or underscores');
  const root = `/tmp/felan-parity/${runId}`;
  const artifact = path.join(repo, '.parity', runId);
  const before = await snapshot(guarded);
  const parent = path.dirname(root);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(parent);
  assert(parentStat.isDirectory() && !parentStat.isSymbolicLink() && parentStat.uid === process.getuid() && (parentStat.mode & 0o077) === 0, 'Unsafe /tmp/felan-parity directory');
  await fs.mkdir(root, { mode: 0o700 });
  try {
    await fs.mkdir(path.dirname(artifact), { recursive: true, mode: 0o700 });
    await fs.mkdir(artifact, { mode: 0o700 });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
  const secrets = [], findings = [], results = [], recordings = [];
  const seededAuthPaths = new Set();
  let daemonPrepared = false, interrupted = false, guardPassed = false, retainSandbox = false, failure;
  const cleanup = [];
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const check = () => {
    if (interrupted) throw new Error('Interrupted');
    if (Date.now() - started >= maxRunMs) throw new Error('Maximum run duration reached');
  };
  const home = side => path.join(root, `${side}-home`);
  let workspaceSuffix = '';
  const workspace = side => path.join(root, `${side}-workspace${workspaceSuffix}`);
  const env = side => ({
    PATH: process.env.PATH, HOME: home(side), USER: process.env.USER ?? '', LOGNAME: process.env.USER ?? '',
    SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor',
    TMPDIR: path.join(root, 'tmp'), XDG_CONFIG_HOME: path.join(home(side), '.config'),
    XDG_CACHE_HOME: path.join(home(side), '.cache'), XDG_DATA_HOME: path.join(home(side), '.local/share'),
    XDG_RUNTIME_DIR: path.join(home(side), '.run'),
    FELAN_AGENT_DIR: side === 'old' ? path.join(root, 'old-agent') : path.join(root, 'new/agent'),
    PI_CODING_AGENT_DIR: side === 'old' ? path.join(root, 'old-agent') : path.join(root, 'new/agent'),
    PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', FELAN_SKIP_VERSION_CHECK: '1',
  });
  const monitor = processMonitor(root, home, env);
  const newCli = [process.execPath, path.join(repo, 'apps/felan/dist/cli.js')];
  const daemon = async (action, force = false, timeoutMs = 45000) => command(newCli[0], [...newCli.slice(1), 'daemon', action, ...(action === 'stop' && force ? ['--force'] : []), '--daemon-runtime', path.join(root, 'new')], { env: env('new'), timeoutMs, onSpawn: pid => monitor.register(pid, 'new') });
  const tmux = (...args) => command('tmux', ['-S', path.join(root, 'tmux.sock'), '-f', '/dev/null', ...args], { env: env('old') });
  const pane = side => `${side}:0.0`;
  const capture = async side => tmux('capture-pane', '-p', '-e', '-t', pane(side));
  const sendText = (side, text) => tmux('send-keys', '-t', pane(side), '-l', '--', text);
  const sendKeys = (side, keys) => tmux('send-keys', '-t', pane(side), ...(Array.isArray(keys) ? keys : [keys]));
  const save = async (relative, text) => {
    const full = path.join(artifact, relative);
    await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await fs.writeFile(full, redactor(secrets)(text), { mode: 0o600 });
  };
  async function collectSecrets(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await collectSecrets(full);
      else if (entry.isFile() && files.includes(entry.name)) {
        try { secrets.push(...secretStrings(JSON.parse(await fs.readFile(full, 'utf8')), entry.name === 'auth.json')); } catch { }
      }
    }
  }
  async function stopDaemon(phase) {
    const entry = { phase, ...await requestDaemonStop(daemon) };
    cleanup.push(entry);
    const evidence = await reapDaemons(monitor, async evidence => {
      Object.assign(entry, evidence);
      if (entry.forceFailure && evidence.lingering.some(item => item.role === 'daemon')) {
        entry.productFinding = `force stop blocked: ${entry.status}`;
      }
      await save('daemon-cleanup.json', json({ phases: cleanup, retainSandbox }));
    });
    if (entry.productFinding) findings.push({ scenario: phase, detail: entry.productFinding, evidence: 'daemon-cleanup.json' });
    if (evidence.survivors.length || evidence.unverified.length || evidence.inspectionFailed) {
      retainSandbox = true;
      failure ??= new Error('Isolated process cleanup failed; sandbox retained without credentials');
    }
    if (evidence.errors.length) failure ??= new Error(`Isolated process cleanup errors: ${evidence.errors.join('; ')}`);
    if (phase !== 'final' && (retainSandbox || evidence.errors.length)) throw failure;
  }
  try {
    await fs.mkdir(path.join(root, 'tmp'), { mode: 0o700 });
    await fs.mkdir(path.join(root, 'seed'), { mode: 0o700 });
    for (const name of files) {
      await fs.writeFile(path.join(root, 'seed', name), json(seeds[name]), { mode: 0o600 });
    }
    await collectSecrets(path.join(root, 'seed'));
    for (const side of sides) {
      await fs.mkdir(home(side), { mode: 0o700 });
      const skills = path.join(realHome, '.agents/skills');
      if (await fs.stat(skills).then(() => true, () => false)) {
        await fs.cp(skills, path.join(home(side), '.agents/skills'), { recursive: true, dereference: true });
      }
      await fs.writeFile(path.join(home(side), '.gitconfig'), '[user]\n\tname = Parity Fixture\n\temail = milko.slavov@gmail.com\n', { mode: 0o600 });
      for (const dir of ['.config', '.cache', '.local/share', '.run']) await fs.mkdir(path.join(home(side), dir), { recursive: true, mode: 0o700 });
      for (const suffix of scenarios.some(scenario => scenario.id === 'B-trust') ? ['', '-trust'] : ['']) {
        workspaceSuffix = suffix;
        await fs.mkdir(workspace(side), { mode: 0o700 });
        await fs.mkdir(path.join(workspace(side), '.agents/skills/parity-note'), { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(workspace(side), 'AGENTS.md'), '# Parity fixture\nKeep all work inside this scratch repository.\n');
        await fs.writeFile(path.join(workspace(side), 'README.md'), '# Parity fixture\nA small, disposable project.\n');
        await fs.writeFile(path.join(workspace(side), '.agents/skills/parity-note/SKILL.md'), '---\nname: parity-note\ndescription: Write a short note in this scratch project.\n---\nWrite note.txt only when asked.\n');
        await command('git', ['init', '--template=', '-q'], { cwd: workspace(side), env: env(side) });
        await command('git', ['add', '.'], { cwd: workspace(side), env: env(side) });
        await command('git', ['-c', 'commit.gpgSign=false', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Parity Fixture', '-c', 'user.email=parity@example.invalid', 'commit', '-qm', 'fixture'], { cwd: workspace(side), env: { ...env(side), GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
      }
      workspaceSuffix = '';
    }
    await fs.mkdir(path.join(root, 'old-agent'), { mode: 0o700 });
    await fs.mkdir(path.join(root, 'new'), { mode: 0o700 });
    daemonPrepared = true;
    await daemon('start');
    await monitor.check();
    await stopDaemon('bootstrap');
    for (const side of sides) for (const name of files) {
      const target = path.join(env(side).FELAN_AGENT_DIR, name);
      await fs.copyFile(path.join(root, 'seed', name), target);
      if (name === 'auth.json') seededAuthPaths.add(target);
      await fs.chmod(target, 0o600);
    }
    const metadata = {
      runId, root, maxRunMs, providers, pollMs: 150, size: [120, 40], oldBin: options.oldBin ?? 'felan', newBin: newCli,
      PI_OFFLINE: '1', envKeys: Object.keys(env('old')).sort(), daemonState: 'cold start per scenario; persistent target',
      versions: { old: (await command(options.oldBin ?? 'felan', ['--version'], { env: env('old') })).trim(), new: (await command(newCli[0], [...newCli.slice(1), '--version'], { env: env('new') })).trim() },
      git: { head: (await command('git', ['rev-parse', 'HEAD'])).trim(), dirty: !!(await command('git', ['status', '--porcelain'])).trim() },
      distMtime: (await fs.stat(path.join(repo, 'apps/felan/dist'))).mtime.toISOString(),
      cliMtime: (await fs.stat(newCli[1])).mtime.toISOString(), scenarios: scenarios.map(s => s.id), launches: {},
    };
    await save('run.json', json(metadata));
    for (const scenario of scenarios) {
      check();
      workspaceSuffix = scenario.id === 'B-trust' ? '-trust' : '';
      for (const side of sides) {
        assert(!(await fs.readdir(env(side).FELAN_AGENT_DIR)).some(name => /^mcp(?:[.-]|$)/i.test(name)), 'MCP config must not be seeded');
        await fs.writeFile(path.join(env(side).FELAN_AGENT_DIR, 'settings.json'), json(seeds['settings.json']), { mode: 0o600 });
      }
      await daemon('start');
      const launches = {};
      metadata.launches[scenario.id] = launches;
      const frames = { old: [], new: [] }, screens = { old: {}, new: {} }, blocked = {}, observations = [];
      let stepIndex = -1, stepStart = Date.now(), polling = true, pollError;
      const poll = async () => {
        while (polling) {
          const started = Date.now(), sampledStep = stepIndex, sampledStart = stepStart;
          await Promise.all(sides.map(async side => {
            try {
              const ansi = await capture(side);
              if (frames[side].at(-1)?.ansi !== ansi) frames[side].push({ step: sampledStep, ms: Date.now() - sampledStart, runMs: Date.now() - launches[side], ansi, text: stripAnsi(ansi) });
            } catch (error) { if (polling) pollError = error; }
          }));
          await sleep(Math.max(0, 150 - (Date.now() - started)));
        }
      };
      async function checkpoint(name, selected = sides) {
        for (const side of selected) {
          const ansi = await capture(side);
          screens[side][name] = ansi;
          await save(`${scenario.id}/${name}.${side}.meta.json`, json({ step: stepIndex, observations: observations.filter(item => item.side === side) }));
          await save(`${scenario.id}/${name}.${side}.ansi`, ansi);
          await save(`${scenario.id}/${name}.${side}.txt`, stripAnsi(ansi));
        }
      }
      const wait = (side, condition) => waitForScreen(side, condition, {
        capture, check,
        observe(item) {
          const observation = { ...item, step: stepIndex, runMs: Date.now() - launches[side] };
          observations.push(observation);
          findings.push({ scenario: scenario.id, side, detail: item.detail, evidence: `${scenario.id}/scenario.json` });
        },
      });
      let pollTask;
      try {
        for (const side of sides) {
          const binary = side === 'old' ? [options.oldBin ?? 'felan'] : [...newCli, '--daemon-runtime', path.join(root, 'new')];
          const stamp = path.join(root, `${scenario.id}.${side}.launch`);
          const gated = `${quote('tmux')} -S ${quote(path.join(root, 'tmux.sock'))} wait-for go-${side}; ${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --stamp ${quote(stamp)}; exec ${binary.map(quote).join(' ')}`;
          const shellCommand = `exec env -i ${Object.entries(env(side)).map(([key, value]) => `${key}=${quote(value)}`).join(' ')} /bin/sh -c ${quote(gated)}`;
          await tmux('new-session', '-d', '-s', side, '-x', '120', '-y', '40', '-c', workspace(side), shellCommand);
          monitor.register(Number((await tmux('display-message', '-p', '-t', pane(side), '#{pane_pid}')).trim()), side);
          await tmux('set-option', '-t', side, 'status', 'off');
          await tmux('set-option', '-t', side, 'remain-on-exit', 'on');
          const recording = path.join(root, `${scenario.id}.${side}.raw.jsonl`);
          recordings.push({ recording, relative: `${scenario.id}/raw.${side}.jsonl` });
          await tmux('pipe-pane', '-t', pane(side), `${quote(process.execPath)} ${quote(fileURLToPath(import.meta.url))} --record ${quote(recording)}`);
        }
        await Promise.all(sides.map(side => tmux('wait-for', '-S', `go-${side}`)));
        await Promise.all(sides.map(async side => {
          const stamp = path.join(root, `${scenario.id}.${side}.launch`);
          while (!(await fs.stat(stamp).then(() => true, () => false))) { check(); await sleep(50); }
          launches[side] = Number(await fs.readFile(stamp, 'utf8'));
        }));
        await save('run.json', json(metadata));
        pollTask = poll();
        await Promise.all(sides.map(async side => {
          await wait(side, { startup: true, timeoutMs: 30000 });
          await wait(side, { settle: true, timeoutMs: 15000 });
          await checkpoint('setup', [side]);
          const screen = stripAnsi(await capture(side));
          if (/trust this (?:folder|project|directory)|trust.*(?:folder|workspace)|folder.*trust/i.test(screen)) {
            await checkpoint('setup-trust', [side]);
            findings.push({ scenario: scenario.id, side, evidence: `${scenario.id}/setup-trust.${side}.txt`, detail: 'Scratch workspace trust gate observed; default choice selected with Enter. Classify manually (unsure pending review).' });
            await sendKeys(side, 'Enter');
            await wait(side, { settle: true, timeoutMs: 15000 });
            await checkpoint('setup-after-trust', [side]);
          }
          await wait(side, { text: 'Felan Code', timeoutMs: 30000 });
          await wait(side, { settle: true, timeoutMs: 15000 });
        }));
        for (const [index, step] of scenario.steps.entries()) {
          check(); if (pollError) throw pollError;
          stepIndex = index; stepStart = Date.now();
          const selected = (step.side ? [step.side] : sides).filter(side => !blocked[side] || 'checkpoint' in step);
          if ('blocked' in step) {
            for (const side of selected) blocked[side] = step.blocked;
          } else if ('checkpoint' in step) await checkpoint(step.checkpoint, selected);
          else if ('commands' in step) {
            await Promise.all(selected.map(async side => {
              const rows = new Map(), seen = new Set();
              let complete = false;
              for (let index = 0; index < 500; index++) {
                check();
                const ansi = await capture(side), plain = stripAnsi(ansi);
                await save(`${scenario.id}/commands/${side}-${String(index).padStart(3, '0')}.txt`, plain);
                for (const row of commandRows(plain)) rows.set(row.name, row.description);
                const counter = plain.match(/\((\d+)\/(\d+)\)/);
                const signature = counter ? counter[0] : plain;
                if (seen.has(signature)) {
                  complete = !counter || seen.size === Number(counter[2]);
                  break;
                }
                seen.add(signature);
                await sendKeys(side, 'Down');
                await sleep(160);
              }
              assert(complete && rows.size > 10, `${side}: full command list could not be confirmed (${rows.size} rows)`);
              await save(`commands.${side}.json`, json([...rows].map(([name, description]) => ({ name, description }))));
            }));
          } else if ('daemonStop' in step) {
            const entry = { phase: `${scenario.id}:awaited-view`, ...await requestDaemonStop(daemon, true) };
            cleanup.push(entry);
            await save('daemon-cleanup.json', json({ phases: cleanup, retainSandbox }));
            if (entry.forceFailure) throw new Error(`Force stop failed with awaited view: ${entry.forceFailure}`);
          } else await Promise.all(selected.map(async side => {
            if ('text' in step) await sendText(side, step.text);
            if ('keys' in step) {
              const keys = Array.isArray(step.keys) ? step.keys : [step.keys];
              if (keys.some(key => /^C-S-/.test(key))) {
                findings.push({ scenario: scenario.id, side, detail: 'shortcut not sendable: tmux cannot certify Ctrl+Shift key encoding; use the slash-command checkpoints.', evidence: `${scenario.id}/scenario.json` });
              } else await sendKeys(side, keys);
            }
            if ('prompt' in step) { await sendText(side, step.prompt); await sendKeys(side, 'Enter'); }
            if ('wait' in step) await wait(side, step.wait);
            if ('resize' in step) await tmux('resize-window', '-t', side, '-x', String(step.resize[0]), '-y', String(step.resize[1]));
          }));
        }
        results.push({ id: scenario.id, status: Object.keys(blocked).length ? 'blocked' : 'passed', ...(Object.keys(blocked).length ? { reason: JSON.stringify(blocked) } : {}) });
        for (const [side, detail] of Object.entries(blocked)) findings.push({ scenario: scenario.id, side, detail, evidence: `${scenario.id}/scenario.json` });
      } catch (error) {
        await checkpoint('blocked').catch(() => {});
        results.push({ id: scenario.id, status: 'blocked', reason: error.message });
        findings.push({ scenario: scenario.id, detail: error.message, evidence: `${scenario.id}/blocked.{old,new}.txt` });
      } finally {
        polling = false;
        await pollTask;
        try {
          await scenarioReports({ scenario, screens, frames, observations, root, artifact, save });
        } finally {
          for (let attempt = 0; attempt < 3; attempt++) {
            await Promise.all(sides.map(side => sendKeys(side, 'Escape').catch(() => {})));
            await sleep(200);
          }
          await monitor.check(true).catch(error => { failure ??= error; });
          for (const side of sides) {
            await tmux('pipe-pane', '-t', pane(side)).catch(() => {});
            await tmux('kill-session', '-t', side).catch(() => {});
          }
          await stopDaemon(scenario.id);
        }
      }
      if (interrupted) break;
    }
  } catch (error) { failure = error; }
  finally {
    const finalErrors = [];
    const attempt = async action => {
      try { return await action(); }
      catch (error) { finalErrors.push(error.message); failure ??= error; }
    };
    let guardSummary = 'Guard: **FAIL** (incomplete inspection).\n';
    try {
      await attempt(() => tmux('kill-server').catch(() => {}));
      if (daemonPrepared) await attempt(() => stopDaemon('final'));
      await attempt(async () => {
        try { await monitor.stop(); }
        catch (error) { retainSandbox = true; throw error; }
      });
      await attempt(() => save('daemon-cleanup.json', json({ phases: cleanup, retainSandbox })));
      for (const phase of cleanup) for (const item of phase.lingering ?? []) findings.push({ scenario: 'cleanup', detail: `${phase.phase}: ${item.role} PID ${item.pid} remained alive after ${phase.graceMs}ms grace.`, evidence: 'daemon-cleanup.json' });
      await attempt(() => collectSecrets(root));
      await attempt(async () => {
        const authPaths = new Set(seededAuthPaths);
        async function discover(directory) {
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (full === path.join(root, 'seed')) continue;
            if (entry.isDirectory()) await discover(full);
            else if (entry.isFile() && entry.name === 'auth.json') authPaths.add(full);
          }
        }
        await discover(root);
        const changed = new Set();
        for (const full of authPaths) {
          let auth;
          try { auth = JSON.parse(await fs.readFile(full, 'utf8')); }
          catch { auth = {}; }
          for (const provider of changedCredentials(seeds['auth.json'], auth)) changed.add(provider);
        }
        await save('guard.credentials.json', json({ passed: !changed.size, changedProviders: [...changed] }));
        for (const provider of changed) finalErrors.push(`credentials were refreshed in the sandbox; the real login for ${provider} may need /login`);
        if (changed.size) failure ??= new Error([...changed].map(provider => `credentials were refreshed in the sandbox; the real login for ${provider} may need /login`).join('\n'));
      });
      for (const { recording, relative } of recordings) await attempt(async () => {
        const chunks = (await fs.readFile(recording, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
        const joined = redactor(secrets)(chunks.map(chunk => chunk.data).join(''));
        let offset = 0;
        await save(relative, chunks.map(chunk => { const data = joined.slice(offset, offset + chunk.data.length); offset += chunk.data.length; return JSON.stringify({ ...chunk, data }); }).join('\n') + '\n');
      });
      await attempt(async () => {
        const after = await snapshot(guarded);
        const changes = guardChanges(before, after);
        await save('guard.diff.json', json(changes));
        const content = await scanGuardContent(guarded, [...changes.added, ...changes.concurrentActivity.added, ...changes.modified], [
          { label: 'run directory', value: root }, { label: 'run id', value: runId },
          ...sides.flatMap(side => [{ label: `${side} workspace`, value: path.join(root, `${side}-workspace`) }, { label: `${side} HOME`, value: home(side) }]),
        ]);
        await save('guard.content.json', json(content));
        const environment = monitor.report();
        await save('guard.processes.json', json(environment));
        guardPassed = !changes.added.length && !changes.removed.length && !content.hits.length && !content.errors.length && !content.vanished.length && environment.passed && !finalErrors.length && !retainSandbox;
        if (!guardPassed) failure ??= new Error('GUARD FAILED: see guard reports');
        guardSummary = `Guard: **${guardPassed ? 'PASS' : 'FAIL'}**.\n\n- Fatal entry additions: ${changes.added.length}; removals: ${changes.removed.length}.\n- Concurrent activity (reported, not fatal): ${changes.concurrentActivity.added.length} additions; ${changes.concurrentActivity.removed.length} removals.\n- Pre-existing metadata updates: ${changes.modified.length} (content-scanned).\n- Content: ${content.checked} checked; ${content.hits.length} hits; ${content.errors.length} errors; ${content.vanished.length} fatal vanished; ${content.concurrentVanished.length} concurrent vanished (reported, not fatal); ${content.overLimit.length} over 16 MiB (excluded).\n- Processes: **${environment.passed ? 'PASS' : 'FAIL'}**; ${environment.sampledProcesses} observed; ${environment.violations.length} violations; ${environment.errors.length} errors; missing required roles: ${environment.missing.join(', ') || 'none'}.\n\nEvidence: guard.diff.json, guard.content.json, guard.processes.json, guard.credentials.json. Sampling cannot certify processes that start and exit between samples; the final sweep detects surviving detached processes.\n`;
      });
      await attempt(() => save('verification.md', `# Verification\n\n${guardSummary}\nCleanup: [daemon-cleanup.json](daemon-cleanup.json).\n${finalErrors.join('\n')}\n`));
      if (options.updateCommands && !failure && results.every(result => result.status === 'passed')) await attempt(() => updateCommands(artifact, runId));
      await attempt(() => save('findings.md', `# Observations awaiting classification\n\n${findings.map(f => `- (${f.scenario}${f.side ? `, ${f.side}` : ''}): ${f.detail} Evidence: \`${f.evidence}\`.`).join('\n') || 'No automatic observations. Manual review is required.'}\n`));
      await attempt(() => save('index.md', `# TUI parity ${runId}\n\n${guardSummary}\n${failure ? `Run error: ${failure.message}\n\n` : ''}${finalErrors.join('\n')}\n\n| Scenario | Status | Evidence |\n| --- | --- | --- |\n${results.map(r => `| ${r.id} | ${r.status}${r.reason ? `: ${r.reason}` : ''} | [diff](${r.id}/diff.md), [timeline](${r.id}/timeline.md) |`).join('\n')}\n\n[Observations](findings.md). [Verification](verification.md). ${retainSandbox ? 'Sandbox retained without credentials or private raw captures.' : 'Sandbox and credentials removed.'}\n`));
    } finally {
      await attempt(async () => {
        async function sanitize(directory) {
          for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await sanitize(full);
            else if (entry.isFile()) await fs.writeFile(full, redactor(secrets)(await fs.readFile(full, 'utf8')));
          }
        }
        await sanitize(artifact);
      });
      await attempt(async () => {
        if (retainSandbox) {
          await save('sandbox-scrub.json', json(await removePrivateData(root)));
        } else await fs.rm(root, { recursive: true, force: true });
      });
      process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt);
    }
    console.log(redactor(secrets)(`${artifact}\nGuard: ${guardPassed && !finalErrors.length ? 'PASS' : 'FAIL'}\n${results.map(r => `${r.id}: ${r.status}${r.reason ? ` (${r.reason})` : ''}`).join('\n')}\n${finalErrors.join('\n')}`));
  }
  if (failure) throw new Error(redactor(secrets)(failure.message));
  if (results.some(result => result.status !== 'passed') || interrupted) process.exitCode = 1;
}

async function updateCommands(artifact, runId) {
  const lists = await Promise.all(sides.map(async side => JSON.parse(await fs.readFile(path.join(artifact, `commands.${side}.json`), 'utf8'))));
  const maps = lists.map(list => new Map(list.map(row => [row.name, row.description])));
  const names = [...new Set(lists.flat().map(row => row.name))].filter(name => !name.startsWith('/skill:')).sort();
  const table = `<!-- command-comparison:start -->\nCaptured live with \`node scripts/tui-parity/run.mjs --id ${runId} --update-command-table\`. Full scrolled lists and frames: \`.parity/${runId}/\`.\n\nThe table includes commands only; both lists also contain ${lists[0].filter(row => row.name.startsWith('/skill:')).length}/${lists[1].filter(row => row.name.startsWith('/skill:')).length} skill rows (old/new). Long skill labels are truncated by the TUI and preserved as displayed in the JSON evidence.\n\n| Command | 0.28.3 | Daemon TUI | Note |\n| --- | --- | --- | --- |\n${names.map(name => `| \`${name}\` | ${maps[0].has(name) ? 'yes' : 'no'} | ${maps[1].has(name) ? 'yes' : 'no'} | ${maps[0].has(name) && maps[1].has(name) ? '' : maps[0].has(name) ? 'old-only in live list' : 'new-only in live list'} |`).join('\n')}\n<!-- command-comparison:end -->`;
  await fs.writeFile(path.join(artifact, 'command-comparison.md'), table + '\n');
  const doc = path.join(repo, 'docs/maintainers/tui-parity.md');
  const text = await fs.readFile(doc, 'utf8');
  assert(text.includes('<!-- command-comparison:start -->') && text.includes('<!-- command-comparison:end -->'), 'Missing command comparison markers');
  await fs.writeFile(doc, text.replace(/<!-- command-comparison:start -->[\s\S]*?<!-- command-comparison:end -->/, table));
}

async function selfTest() {
  const cases = await catalog();
  assert.equal(normalize('\x1b[31m0.28.3 123e4567-e89b-12d3-a456-426614174000 $1.23 12 tokens 40ms 2026-10-13T11:12:13Z /tmp/run/x\x1b[0m', '/tmp/run'), '<version> <id> $<cost> <amount> <amount> <date> <run>/x');
  assert.equal(normalize('/p/t/f/r/old-workspace 13k/272k 6d17h'), '<workspace> <count>/<count> <elapsed>');
  assert.equal(normalize('↑12.3k ↓45 input: 123 cost=2.30 12:30'), '↑<count> ↓<count> input:<amount> cost:<amount> <time>');
  const base = { ...cases[0], steps: [{ checkpoint: 'ok' }] };
  for (const step of [{ wat: true }, { text: 'x', keys: 'Enter' }, { wait: { idle: true } }, { wait: { ms: -1 } }, { wait: { idle: true, timeoutMs: 100, onTimeout: 'observe' } }, { side: 'bad', text: 'x' }, { checkpoint: '../bad' }, { prompt: 'spend money' }, { keys: [] }, { resize: [0, 24] }]) assert.throws(() => validate([{ ...base, steps: [step] }]));
  assert.throws(() => validate([base, base]));
  const now = 1000, maxRunMs = 4 * 3600000;
  const oauth = { type: 'oauth', expires: now + maxRunMs + 3600000 + 1, access: 'access', refresh: 'refresh' };
  assert.deepEqual(expiringProviders({ safe: oauth, api: { type: 'api_key' } }, maxRunMs, now), []);
  assert.deepEqual(expiringProviders({ boundary: { ...oauth, expires: oauth.expires - 1 }, expired: { ...oauth, expires: 0 }, missing: { type: 'oauth' } }, maxRunMs, now), ['boundary', 'expired', 'missing']);
  assert.deepEqual(changedCredentials({ provider: oauth }, { provider: { refresh: 'refresh', access: 'access', expires: oauth.expires, type: 'oauth' } }), []);
  for (const actual of [{ provider: { ...oauth, access: 'changed' } }, { provider: { ...oauth, expires: 0 } }, {}]) assert.deepEqual(changedCredentials({ provider: oauth }, actual), ['provider']);
  assert.deepEqual(changedCredentials({}, { added: oauth }), ['added']);
  assert.deepEqual(homePaths({ nested: [{ path: '/real/home/private' }], harmless: '/other/home' }, '/real/home'), ['nested.0.path']);
  assert.deepEqual(seedProviders({ defaultProvider: 'primary', defaultModel: 'primary/model', extensionConfig: { fusion: { participants: ['second/model', 'primary/other'], fusionModel: 'third/model' } } }), ['primary', 'second', 'third']);
  assert.equal(stableScreen({ settle: true }, 'a', 'a', 0, 499).ready, false);
  assert.equal(stableScreen({ settle: true }, 'a', 'a', 0, 500).ready, true);
  assert.deepEqual(stableScreen({ settle: true }, 'b', 'a', 0, 500), { ready: false, since: 500 });
  const transcript = 'thinking in old transcript\n' + 'idle\n'.repeat(8);
  assert.equal(stableScreen({ idle: true }, transcript, transcript, 0, 2500).ready, true);
  assert.equal(stableScreen({ idle: true }, 'working', 'working', 0, 2500).ready, false);
  const observations = [];
  let clock = 0;
  const waitDependencies = {
    capture: async () => `spinner ${clock}`, check() {}, observe: item => observations.push(item),
    now: () => clock, pause: async ms => { clock += ms; },
  };
  await waitForScreen('new', { settle: true, timeoutMs: 600 }, waitDependencies);
  assert.equal(observations[0].detail, 'screen did not settle within 600 ms');
  await waitForScreen('new', { text: 'History', timeoutMs: 600, onTimeout: 'observe' }, waitDependencies);
  assert.equal(observations[1].detail, '"History" not shown within 600 ms');
  await waitForScreen('old', { text: 'History', timeoutMs: 600, onTimeout: 'observe' }, { ...waitDependencies, capture: async () => 'Prompt History' });
  assert.equal(observations.length, 2);
  await assert.rejects(waitForScreen('new', { idle: true, timeoutMs: 600 }, waitDependencies), /wait timed out/);
  await assert.rejects(waitForScreen('new', { startup: true, timeoutMs: 600 }, waitDependencies), /wait timed out/);
  await assert.rejects(waitForScreen('new', { settle: true, timeoutMs: 600 }, { ...waitDependencies, check() { throw new Error('Interrupted'); } }), /Interrupted/);
  for (const scenario of cases) for (const step of scenario.steps) {
    if (step.wait?.text) assert.equal(step.wait.onTimeout, 'observe', `${scenario.id}: selector waits must record missing UI`);
  }
  assert.deepEqual(sgrSummary('\x1b[31mred\x1b[0m'), [{ line: 1, sgr: ['31', '0'] }]);
  assert.equal(redactor([])('a person@example.com z'), 'a ****************** z');
  assert.equal(redactor(['secret-value'])('a secret-value z'), 'a ************ z');
  assert.equal(redactor(['secret\nvalue'])(JSON.stringify('secret\nvalue')), '"*************"');
  const chunks = ['secret-', 'value'];
  assert.equal(redactor(['secret-value'])(chunks.join('')), '************');
  assert.deepEqual(commandRows('  ❯ settings    Configure settings\n    skill:parity-note  Write a note'), [{ name: '/settings', description: 'Configure settings' }, { name: '/skill:parity-note', description: 'Write a note' }]);
  const doc = await fs.readFile(path.join(repo, 'docs/maintainers/tui-parity.md'), 'utf8');
  const ids = [...doc.matchAll(/^\| ([ABCD]-[a-z-]+) \|/gm)].map(match => match[1]);
  assert.deepEqual(cases.filter(s => s.id !== 'smoke').map(s => s.id).sort(), ids.sort(), 'Catalog coverage');
  assert.deepEqual(matchingDaemons(' 123 501 /node /host {\"kind\":\"isolated\",\"directory\":\"/tmp/test/new\"}', '/tmp/test', '/node', '/host', 501), [123]);
  assert.deepEqual(matchingDaemons(' 123 502 /node /host {\"kind\":\"isolated\",\"directory\":\"/tmp/test/new\"}', '/tmp/test', '/node', '/host', 501), []);
  assert.deepEqual(matchingDaemons(' 123 501 /node /host {\"kind\":\"isolated\",\"directory\":\"/tmp/other/new\"}', '/tmp/test', '/node', '/host', 501), []);
  const changes = guardChanges([
    ['settings.json', '1', '1'], ['removed', '0', '1'], ['storage/sessions/live', '0', '1'], ['storage/sessions/live/removed', '1', '1'],
  ], [
    ['settings.json', '2', '2'], ['storage/sessions/live', '0', '2'], ['storage/sessions/live/new/file', '1', '2'], ['storage/sessions/new', '0', '2'], ['unexpected', '1', '2'],
  ]);
  assert.deepEqual(changes.added.map(entry => entry[0]), ['unexpected']);
  assert.deepEqual(changes.removed.map(entry => entry[0]), ['removed']);
  assert.deepEqual(changes.concurrentActivity.added.map(entry => entry[0]), ['storage/sessions/live/new/file', 'storage/sessions/new']);
  assert.equal(changes.modified.length, 2);
  const concurrent = ['sessions/new', 'subagents/child/status', 'storage/sessions/new/file', 'subscription-usage.json.foo.lease.reclaim-x/owner', 'subscription-usage.json.foo.lease.release-y', 'storage/agent/codebase-memory/cache/logs/.worker-response-xyz'];
  const stage = 'storage/agent/codebase-memory/cache/Users-x-repo.db.stage.Ab12';
  assert.equal(guardChanges([[stage], [`${stage}.lock`]], []).removed.length, 0);
  assert.equal(guardChanges([['storage/agent/codebase-memory/cache/tmp-felan-parity-x.db.stage.Ab12']], []).removed.length, 1);
  const savingsDiff = guardChanges([['storage/agent/savings/v1/writers/w/1.json']], [['storage/agent/savings/v1/writers/w/2.json']]);
  assert.equal(savingsDiff.added.length + savingsDiff.removed.length, 0);
  assert.equal(savingsDiff.concurrentActivity.added.length + savingsDiff.concurrentActivity.removed.length, 2);
  const logDiff = guardChanges([['storage/agent/codebase-memory/cache/logs/Users-felan-1.log']], [['storage/agent/codebase-memory/cache/logs/Users-felan-2.log']]);
  assert.equal(logDiff.added.length + logDiff.removed.length, 0);
  assert.equal(logDiff.concurrentActivity.added.length + logDiff.concurrentActivity.removed.length, 2);
  const concurrentDiff = guardChanges(concurrent.map(name => [name]), concurrent.map(name => [`${name}2`]));
  assert.equal(concurrentDiff.added.length, 0);
  assert.equal(concurrentDiff.removed.length, 0);
  assert.equal(concurrentDiff.concurrentActivity.added.length, concurrent.length);
  assert.equal(concurrentDiff.concurrentActivity.removed.length, concurrent.length);
  assert.equal(concurrentActivity('storage/agent/codebase-memory/bin/new'), false);
  assert.equal(concurrentActivity('storage/agent/codebase-memory/cache/logs/nested/other.log'), false);
  assert.equal(concurrentActivity('storage/agent/codebase-memory/cache/logs/other.json'), false);
  assert.equal(concurrentActivity('settings.json'), false);
  assert.deepEqual(processRows(' 12 1 501 Tue Oct 13 14:38:17 2026 /node /daemon-host.js'), [{ pid: 12, ppid: 1, uid: 501, started: 'Tue Oct 13 14:38:17 2026', command: '/node /daemon-host.js' }]);
  assert.equal(environmentValue('node XDG_HOME=/wrong HOME=/fake FELAN_AGENT_DIR=/agent', 'HOME'), '/fake');
  assert.equal(environmentValue('node HOME=/argument HOME=/actual', 'HOME'), '/actual');
  assert.equal(environmentValue('node XDG_HOME=/wrong', 'HOME'), null);
  assert.equal(processRole('/bin/cbm serve'), 'codebase-memory/cbm child');
  assert.equal(processRole('/node /daemon-host.js {}'), 'daemon');
  assert.equal(executablePath('/bin/sh', '', 10), '/bin/sh');
  assert.equal(executablePath('sleep', 'p10\nftxt\nn/bin/sleep\nftxt\nn/usr/lib/dyld\n', 10), '/bin/sleep');
  assert.equal(executablePath('sleep', 'p11\nftxt\nn/bin/sleep\n', 10), '');
  assert.equal(executablePath('sleep', 'p10\nftxt\nn/usr/lib/dyld\nftxt\nn/bin/sleep\n', 10), '');
  assert.equal(executablePath('sleep', 'p10\nftxt\nn/opt/bin/sleep\n', 10), '/opt/bin/sleep');
  const testHome = side => `/sandbox/${side}-home`;
  const testEnv = side => ({ FELAN_AGENT_DIR: `/sandbox/${side}-agent` });
  const parent = { pid: 10, ppid: 1, uid: process.getuid(), started: 'parent-start', command: '/node client.js' };
  const shell = { pid: 11, ppid: 10, uid: process.getuid(), started: 'shell-start', command: '/bin/sh -c sleep 20' };
  const child = { pid: 12, ppid: 11, uid: process.getuid(), started: 'child-start', command: 'sleep 20' };
  const current = new Map([parent, shell, child].map(row => [row.pid, row]));
  const parentEvidence = inspectEnvironment(parent, '/node HOME=/sandbox/new-home FELAN_AGENT_DIR=/sandbox/new-agent', '', 'new', undefined, testHome, testEnv, 'darwin');
  const observed = new Map([[`${parent.pid}:${parent.started}`, parentEvidence]]);
  const ancestor = verifiedAncestor(child, current, observed);
  assert.equal(ancestor, parentEvidence);
  for (const executable of ['/bin/sleep', '/usr/bin/true', '/sbin/ping', '/usr/sbin/foo', '/System/Library/foo']) {
    const inherited = inspectEnvironment(child, 'sleep 20', executable, 'new', ancestor, testHome, testEnv, 'darwin');
    assert.equal(inherited.passed, true);
    assert.equal(inherited.inspection, 'inherited, not inspectable');
    assert.equal(inherited.ancestorPid, parent.pid);
  }
  for (const [output, executable, side, verified, platform] of [
    ['sleep 20', '/bin/sleep', 'new', undefined, 'darwin'],
    ['sleep 20', '/opt/bin/sleep', 'new', ancestor, 'darwin'],
    ['sleep 20', '/binning/sleep', 'new', ancestor, 'darwin'],
    ['sleep 20', '/bin/sleep', 'old', ancestor, 'darwin'],
    ['sleep 20', '/bin/sleep', 'new', ancestor, 'linux'],
    ['sleep HOME=/wrong FELAN_AGENT_DIR=/sandbox/new-agent', '/bin/sleep', 'new', ancestor, 'darwin'],
    ['sleep PATH=/bin', '/bin/sleep', 'new', ancestor, 'darwin'],
  ]) assert.equal(inspectEnvironment(child, output, executable, side, verified, testHome, testEnv, platform).passed, false);
  assert.equal(verifiedAncestor(child, new Map([[child.pid, child], [shell.pid, shell]]), observed), undefined);
  assert.equal(verifiedAncestor(child, new Map([...current, [parent.pid, { ...parent, started: 'reused-pid' }]]), observed), undefined);
  assert.equal(verifiedAncestor(child, new Map([...current, [shell.pid, { ...shell, uid: parent.uid + 1 }]]), observed), undefined);
  let recorded = false;
  const cleanupFailure = await reapDaemons({ remaining: async () => { throw new Error('inspection unavailable'); } }, async () => { recorded = true; });
  assert(recorded);
  assert.deepEqual(cleanupFailure.errors, ['inspection unavailable']);
  assert.equal(cleanupFailure.inspectionFailed, true);
  const recordFailure = await reapDaemons({ remaining: async () => [] }, async () => { throw new Error('record unavailable'); });
  assert(recordFailure.errors.includes('record unavailable'));
  assert.equal(recordFailure.inspectionFailed, false);
  const stopCalls = [];
  const blockedStop = await requestDaemonStop(async (action, force, timeoutMs) => {
    stopCalls.push({ action, force, timeoutMs });
    if (action === 'stop') throw new Error('blocked');
    return 'blocked, runs: 1';
  });
  assert.deepEqual(stopCalls, [{ action: 'stop', force: false, timeoutMs: 5000 }, { action: 'stop', force: true, timeoutMs: 5000 }, { action: 'status', force: false, timeoutMs: 3000 }]);
  assert.equal(blockedStop.status, 'blocked, runs: 1');
  assert.equal(blockedStop.forceFailure, 'blocked');
  const drained = await requestDaemonStop(async () => 'stopped');
  assert.equal(drained.shutdown.length, 1);
  const forced = await requestDaemonStop(async (action, force) => { if (!force) throw new Error('blocked'); return 'stopped'; });
  assert.equal(forced.shutdown.length, 2);
  assert.equal(forced.forceFailure, undefined);
  const forceOnlyCalls = [];
  const forceOnly = await requestDaemonStop(async (action, force, timeoutMs) => { forceOnlyCalls.push({ action, force, timeoutMs }); return 'Daemon stopped.'; }, true);
  assert.deepEqual(forceOnlyCalls, [{ action: 'stop', force: true, timeoutMs: 5000 }]);
  assert.deepEqual(forceOnly.shutdown, [{ mode: 'force', output: 'Daemon stopped.' }]);
  const uninspectable = inspectEnvironment(child, 'sleep 20', '/bin/sleep', 'new', ancestor, testHome, testEnv, 'darwin');
  const inheritedCleanup = await reapDaemons({ remaining: async () => [uninspectable], revalidate: async () => uninspectable }, async () => {}, { graceMs: 0, signalGraceMs: 0 });
  assert.equal(inheritedCleanup.reaped.length, 0);
  assert.deepEqual(inheritedCleanup.unverified, [uninspectable]);
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 25 }), /timed out after 25 ms/);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'parity-guard-test-'));
  try {
    await fs.writeFile(path.join(fixture, 'hit'), 'prefix marker suffix');
    await fs.writeFile(path.join(fixture, 'clean'), 'ordinary live session data');
    await fs.mkdir(path.join(fixture, 'directory'));
    const large = await fs.open(path.join(fixture, 'large'), 'w');
    await large.truncate(16 * 1024 * 1024 + 1); await large.close();
    const vanishedConcurrent = ['storage/agent/savings/v1/writers/w/3.json', 'storage/agent/codebase-memory/cache/logs/Users-felan-3.log'];
    const scan = await scanGuardContent(fixture, ['hit', 'clean', 'directory', 'large', 'vanished', ...vanishedConcurrent].map(name => [name]), [{ label: 'run id', value: 'marker' }]);
    assert.equal(scan.checked, 2);
    assert.deepEqual(scan.hits, [{ path: 'hit', matches: ['run id'] }]);
    assert.deepEqual(scan.overLimit, ['large']);
    assert.deepEqual(scan.vanished, ['vanished']);
    assert.deepEqual(scan.concurrentVanished, vanishedConcurrent);
    assert.deepEqual(scan.errors, []);
    const retained = path.join(fixture, 'retained');
    const privateFiles = ['seed/auth.json', 'old-agent/auth.json', 'new/agent/auth.json', 'new/agent/settings.json', 'new/agent/models-store.json', 'nested/copy/auth.json', 'smoke.new.raw.jsonl'];
    for (const relative of [...privateFiles, 'keep.txt']) {
      const full = path.join(retained, relative);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, 'private fixture');
    }
    await fs.symlink(path.join(retained, 'keep.txt'), path.join(retained, 'auth.json'));
    const scrub = await removePrivateData(retained);
    assert.deepEqual(scrub.removed.sort(), [...privateFiles, 'auth.json'].sort());
    assert.deepEqual(scrub.remaining, []);
    assert.equal(await fs.readFile(path.join(retained, 'keep.txt'), 'utf8'), 'private fixture');
    const reportRoot = path.join(fixture, 'reports');
    const reportSave = async (relative, text) => {
      const full = path.join(reportRoot, relative);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, text);
    };
    await scenarioReports({ scenario: base, root: fixture, artifact: reportRoot, observations, save: reportSave,
      screens: { old: { partial: '\x1b[31mold\x1b[0m' }, new: {} },
      frames: { old: [{ text: 'old', step: 0, ms: 1, runMs: 1 }], new: [] } });
    for (const name of ['timeline.md', 'diff.md', 'frames.old.jsonl', 'frames.new.jsonl', 'partial.old.sgr.json', 'partial.new.sgr.json', 'partial.old.normalized.txt', 'partial.new.normalized.txt']) await fs.access(path.join(reportRoot, base.id, name));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(reportRoot, base.id, 'scenario.json'), 'utf8')).observations, observations);
    const snapshotLines = (await snapshot(fixture)).map(entry => JSON.stringify(entry)).join('\n');
    assert(snapshotLines.split('\n').every(line => JSON.parse(line).length === 3));
    const detachedMonitor = processMonitor(fixture, () => fixture, () => ({ FELAN_AGENT_DIR: `${fixture}/agent` }));
    const detached = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, env: { HOME: fixture, FELAN_AGENT_DIR: `${fixture}/agent` }, stdio: 'ignore' });
    const detachedClosed = new Promise(resolve => detached.on('close', resolve));
    try {
      assert((await detachedMonitor.remaining()).some(item => item.pid === detached.pid && item.passed));
      assert(detachedMonitor.report().finalSweepPids.includes(detached.pid));
    } finally { detached.kill(); await detachedClosed; await detachedMonitor.stop(); }
    if (process.platform === 'darwin') {
      const monitor = processMonitor(fixture, () => fixture, () => ({ FELAN_AGENT_DIR: `${fixture}/agent` }));
      const script = "const { spawn } = require('node:child_process'); const child = spawn('sleep', ['20'], { stdio: 'ignore' }); process.on('SIGTERM', () => child.kill()); child.on('close', () => process.exit()); console.log('ready');";
      const parent = spawn(process.execPath, ['-e', script], { env: { HOME: fixture, FELAN_AGENT_DIR: `${fixture}/agent`, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'ignore'] });
      const closed = new Promise(resolve => parent.on('close', resolve));
      try {
        await new Promise(resolve => parent.stdout.once('data', resolve));
        monitor.register(parent.pid, 'new');
        await monitor.check();
        assert.equal(monitor.report().violations.length, 0);
        assert(monitor.report().processes.some(item => item.executable === '/bin/sleep' && item.inspection === 'inherited, not inspectable'));
      } finally { parent.kill(); await closed; await monitor.stop(); }
    }
    for (const [side, actualHome, agentDir] of [['old', fixture, `${fixture}/agent`], ['old', `${fixture}/wrong`, `${fixture}/agent`], ['new', fixture, `${fixture}/wrong-agent`]]) {
      const monitor = processMonitor(fixture, () => fixture, () => ({ FELAN_AGENT_DIR: `${fixture}/agent` }));
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { HOME: actualHome, FELAN_AGENT_DIR: agentDir }, stdio: 'ignore' });
      const closed = new Promise(resolve => child.on('close', resolve));
      try {
        monitor.register(child.pid, side);
        await monitor.check();
        assert.equal(monitor.report().passed, false);
        assert.deepEqual(monitor.report().missing, ['old:TUI client', 'new:TUI client', 'new:daemon']);
        assert.equal(monitor.report().violations.length, actualHome === fixture && agentDir === `${fixture}/agent` ? 0 : 1);
        assert.equal(monitor.report().sampledProcesses, 1);
        if (monitor.report().violations.length) {
          const evidence = await reapDaemons(monitor, async () => {}, { graceMs: 0, signalGraceMs: 0 });
          assert.equal(evidence.reaped.length, 0);
          assert(evidence.unverified.some(item => item.pid === child.pid));
        }
      } finally { child.kill(); await closed; await monitor.stop(); }
    }
    const stubbornMonitor = processMonitor(fixture, () => fixture, () => ({ FELAN_AGENT_DIR: `${fixture}/agent` }));
    const stubborn = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)"], { env: { HOME: fixture, FELAN_AGENT_DIR: `${fixture}/agent` }, stdio: ['ignore', 'pipe', 'ignore'] });
    const stubbornClosed = new Promise(resolve => stubborn.on('close', resolve));
    try {
      await new Promise(resolve => stubborn.stdout.once('data', resolve));
      stubbornMonitor.register(stubborn.pid, 'new');
      const evidence = await reapDaemons(stubbornMonitor, async () => {}, { graceMs: 0, signalGraceMs: 100 });
      assert.deepEqual(evidence.reaped.map(item => item.signal), ['SIGTERM', 'SIGKILL']);
      assert.deepEqual(evidence.survivors, []);
      assert.deepEqual(evidence.unverified, []);
      assert.deepEqual(evidence.errors, []);
    } finally { stubborn.kill('SIGKILL'); await stubbornClosed; await stubbornMonitor.stop(); }
  } finally { await fs.rm(fixture, { recursive: true, force: true }); }
  console.log(`Self-test passed: expiry, credential changes, home-path checks, non-fatal waits, masking, redaction, parsing, validation, concurrent/vanished content, bounded shutdown, verified signal escalation, retained credential scrub, partial reports, process metadata/environment; ${cases.length} scenarios.`);
}

async function main() {
  if (process.argv[2] === '--stamp') { await fs.writeFile(process.argv[3], String(Date.now()), { mode: 0o600 }); return; }
  if (process.argv[2] === '--record') {
    const output = createWriteStream(process.argv[3], { flags: 'wx', mode: 0o600 });
    const started = Date.now();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', data => output.write(JSON.stringify({ timestamp: Date.now(), ms: Date.now() - started, data }) + '\n'));
    process.stdin.on('end', () => output.end());
    return;
  }
  const options = {};
  for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index];
    if (['--self-test', '--dry-run', '--allow-paid', '--update-command-table', '--help'].includes(arg)) options[arg.slice(2)] = true;
    else if (['--id', '--scenario', '--area', '--old-bin', '--providers', '--max-run-hours'].includes(arg)) { assert(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `${arg} requires a value`); options[arg.slice(2)] = process.argv[++index]; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.help) { console.log('node scripts/tui-parity/run.mjs [--scenario smoke|ID | --area A|B|C|D] [--id ID] [--old-bin PATH] [--allow-paid] [--providers NAME,NAME] [--max-run-hours 4] [--update-command-table]\n--dry-run validates every scenario without launching anything. --self-test runs offline tests.\nOnly smoke may make paid calls without --allow-paid. Login scenarios navigate and cancel only.'); return; }
  if (options['self-test']) { await selfTest(); return; }
  const cases = await catalog();
  if (options['dry-run']) { console.log(`Validated ${cases.length} scenarios:\n${cases.map(s => `${s.id}: ${s.steps.length} steps${s.paid ? ' (requires --allow-paid)' : ''}`).join('\n')}`); return; }
  assert(!(options.area && options.scenario), 'Choose --area or --scenario');
  const selected = options.area ? cases.filter(s => s.area === options.area && s.id !== 'smoke') : cases.filter(s => s.id === (options.scenario ?? 'smoke'));
  assert(selected.length, 'No matching scenarios');
  assert(!options['update-command-table'] || selected.some(s => s.steps.some(step => step.commands)), '--update-command-table requires a scenario that captures commands');
  assert(options['allow-paid'] || selected.every(s => !s.paid), 'Selected scenarios require --allow-paid');
  const maxRunHours = Number(options['max-run-hours'] ?? 4);
  assert(Number.isFinite(maxRunHours) && maxRunHours > 0 && maxRunHours <= 24, '--max-run-hours must be in (0, 24]');
  const providers = options.providers?.split(',');
  assert(!providers || providers.every(provider => /^[a-zA-Z0-9_-]+$/.test(provider)), 'Invalid provider list');
  await run({ id: options.id, oldBin: options['old-bin'], updateCommands: options['update-command-table'], providers, maxRunHours }, selected);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
