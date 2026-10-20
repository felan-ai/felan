import { opendir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { LIMITS } from '@felan-ai/session-protocol';
import { parsePiExtensionSettings, readDaemonGlobalSettings } from './global-settings.js';
import type { HostServices, HostServicesRequest } from '@felan-ai/daemon/session-runtime';

export function createRootPreparation(options: {
  agentDir: string;
  homeDir: string;
  broker: HostServicesRequest['interactions'];
  assertCurrent(): void;
}): NonNullable<HostServices['prepareRoot']> {
  return async (request, caller) => {
    options.assertCurrent(); caller.signal.throwIfAborted();
    const cwd = await realpath(request.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error('Session cwd must be a directory.');
    const settings = parsePiExtensionSettings((await readDaemonGlobalSettings(options.agentDir, options.assertCurrent)).piExtensions);
    const paths: string[] = [];
    if (settings.user) paths.push(join(options.homeDir, '.pi', 'agent', 'extensions'));
    const project = join(cwd, '.pi', 'extensions');
    if (settings.project && (await existingStat(project))?.isDirectory()) {
      const store = new ProjectTrustStore(options.agentDir);
      let trusted = store.get(cwd);
      if (trusted === null && caller.recipient !== undefined) {
        const parent = dirname(cwd);
        const outcome = await options.broker.request({ kind: 'select', title: `Trust project Pi extensions in ${cwd}?`, multiple: false,
          choices: [
            { id: 'trust', title: 'Trust this folder', description: 'Load its project Pi extensions with your permissions. Remember this decision.' },
            ...(parent === cwd ? [] : [{ id: 'trust-parent', title: 'Trust parent folder', description: `Trust ${parent} and its project Pi extensions. Remember this decision.` }]),
            { id: 'deny', title: 'Do not trust', description: 'Skip project Pi extensions in this folder. Remember this decision.' },
          ] }, { kind: 'host', recipient: caller.recipient }, { signal: caller.signal });
        caller.signal.throwIfAborted(); options.assertCurrent();
        if (await realpath(request.cwd) !== cwd) throw new Error('The project path changed during trust approval.');
        if (outcome.state === 'answered' && outcome.answer.kind === 'select') {
          const choice = outcome.answer.choices[0];
          if (choice === 'trust-parent') {
            store.setMany([{ path: parent, decision: true }, { path: cwd, decision: null }]); trusted = true;
          } else if (choice === 'trust' || choice === 'deny') {
            trusted = choice === 'trust'; store.set(cwd, trusted);
          }
        }
      }
      if (trusted === true) paths.push(project);
    }
    paths.push(...(request.extensions ?? []));
    const extensionPaths = await collectExtensions(paths, caller.signal, new Set(request.extensions ?? []));
    caller.signal.throwIfAborted(); options.assertCurrent();
    if (await realpath(request.cwd) !== cwd) throw new Error('The project path changed during preparation.');
    return { cwd, extensionPaths };
  };
}

async function existingStat(path: string) {
  try { return await stat(path); }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined;
    throw error;
  }
}

async function collectExtensions(paths: readonly string[], signal: AbortSignal, required: ReadonlySet<string>): Promise<string[]> {
  const result = new Set<string>(); let inspected = 0;
  const add = async (path: string) => {
    signal.throwIfAborted(); result.add(await realpath(path));
    if (result.size > LIMITS.catalogEntries) throw new Error('External extension capacity exceeded.');
  };
  for (const path of new Set(paths)) {
    signal.throwIfAborted();
    const info = await existingStat(path);
    if (!info) {
      if (required.has(path)) throw new Error('An explicit extension path does not exist.');
      continue;
    }
    if (info.isFile()) { await add(path); continue; }
    if (!info.isDirectory()) continue;
    const directory = await opendir(path);
    for await (const entry of directory) {
      signal.throwIfAborted();
      if (++inspected > 4096) throw new Error('External extension directory capacity exceeded.');
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const child = join(path, entry.name);
      if (entry.isFile() && /\.(?:ts|js)$/u.test(entry.name)) await add(child);
      else if (entry.isDirectory()) for (const name of ['index.ts', 'index.js']) {
        const index = join(child, name);
        if ((await existingStat(index))?.isFile()) { await add(index); break; }
      }
    }
  }
  return [...result];
}
