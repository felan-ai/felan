import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DaemonTarget } from '@felan-ai/daemon/client';
import { SessionClient, type SessionClientOptions } from './client/client.js';
import { resolveClientHostComposition, resolveInstalledDaemonEntrypoint } from './daemon-entrypoint.js';
import { TuiSessionController, type TuiSessionOptions } from './tui/controller.js';
import { runDaemonTerminal } from './tui/run.js';
import { FELAN_VERSION } from './version.js';
import type { DaemonIdentity } from '@felan-ai/session-protocol';
import { waitForDaemonStop } from './client/daemon-stop.js';
import { DAEMON_VERSION } from '@felan-ai/daemon';
import { TERMINAL_INTERACTION_KINDS, TERMINAL_UI_CAPABILITIES } from './tui/interactions.js';

export interface RunDaemonFelanOptions extends Omit<TuiSessionOptions, 'cwd' | 'extensions'> {
  cwd?: string;
  agentDir?: string;
  daemonRuntime?: string;
  hostConfigPath?: string;
  extensionPaths?: readonly string[];
  initialMessage?: string;
  verbose?: boolean;
  signal?: AbortSignal;
}

export function getClientAgentDir(): string { return resolve(process.env.FELAN_AGENT_DIR ?? join(homedir(), '.felan')); }

export function clientDaemonTarget(options: RunDaemonFelanOptions): DaemonTarget {
  if (options.daemonRuntime) {
    const directory = resolve(options.daemonRuntime);
    return { kind: 'isolated', directory, namespaceId: `cli-${createHash('sha256').update(directory).digest('hex').slice(0, 32)}`, storeRoots: [directory] };
  }
  return { kind: 'production', agentDir: resolve(options.agentDir ?? getClientAgentDir()),
    storeRoots: options.sessionDir ? [resolve(options.sessionDir)] : [] };
}

export function clientConfigurationRoot(options: RunDaemonFelanOptions): string {
  return options.daemonRuntime ? join(resolve(options.daemonRuntime), 'client') : resolve(options.agentDir ?? getClientAgentDir());
}

export async function runDaemonFelan(options: RunDaemonFelanOptions = {}, dependencies: {
  createClient?: (options: SessionClientOptions) => SessionClient;
  runTerminal?: typeof runDaemonTerminal;
  waitForStop?: typeof waitForDaemonStop;
} = {}): Promise<void> {
  let replacing: DaemonIdentity | undefined;
  let selected = options.sessionId;
  let cwd = resolve(options.cwd ?? process.cwd());
  let draft = '';
  let first = true;
  while (!options.signal?.aborted) {
    const target = clientDaemonTarget(options);
    const expectedComposition = dependencies.createClient ? undefined : await resolveClientHostComposition(target, options.hostConfigPath);
    const client = (dependencies.createClient ?? (options => new SessionClient(options)))({ target,
      clientVersion: FELAN_VERSION, expectedDaemonVersion: DAEMON_VERSION, ...(expectedComposition ? { expectedComposition } : {}), kind: 'tui', interactionKinds: [...TERMINAL_INTERACTION_KINDS], capabilities: [...TERMINAL_UI_CAPABILITIES],
      launch: { entrypoint: resolveInstalledDaemonEntrypoint(), ...(options.hostConfigPath ? { hostConfigPath: resolve(options.hostConfigPath) } : {}), ...(replacing ? { replacing } : {}) } });
    const controller = new TuiSessionController(client);
    const outcome: { restart?: { identity: DaemonIdentity; sessionId?: string; cwd: string; draft: string; keepStartup: boolean } } = {};
    try {
      await (dependencies.runTerminal ?? runDaemonTerminal)(controller, { cwd, clientConfigDir: clientConfigurationRoot(options),
        ...(selected ? { sessionId: selected } : {}), ...(options.sessionDir ? { sessionDir: resolve(options.sessionDir) } : {}),
        ...(first && options.continueRecent ? { continueRecent: true } : {}), ...(first && options.resume ? { resume: true } : {}),
        ...(first && options.extensionPaths?.length ? { extensions: options.extensionPaths.map(path => resolve(path)) } : {}),
        ...(first && options.config ? { config: options.config } : {}), ...(first && options.initialMessage ? { initialMessage: options.initialMessage } : {}),
        ...(draft ? { initialDraft: draft } : {}),
        ...(options.signal ? { signal: options.signal } : {}), ...(options.verbose ? { verbose: true } : {}),
        onDaemonAction: async (action, force, text, beforeAttachment) => {
          const identity = client.identity;
          if (!identity) throw new Error('Connect to a verified daemon before using lifecycle controls.');
          const result = await client.control(action === 'stop' ? 'host.stop' : 'host.restart', { confirmed: true, mode: force ? 'force' : 'drain' });
          if (result.outcome !== 'accepted') throw new Error('Daemon control was not accepted. Inspect status before retrying.');
          await (dependencies.waitForStop ?? waitForDaemonStop)(client, options.signal);
          if (action === 'restart') {
            const sessionId = controller.sessionId ?? selected;
            outcome.restart = { identity, ...(sessionId ? { sessionId } : {}), cwd: controller.snapshot?.cwd ?? cwd,
              draft: /^\/(?:daemon|restart)(?:\s|$)/u.test(text.trim()) ? '' : text, keepStartup: beforeAttachment === true && first };
          }
          return true;
        },
      });
    } finally { await controller.dispose(); }
    const restart = outcome.restart;
    if (!restart) return;
    replacing = restart.identity; selected = restart.sessionId; cwd = restart.cwd; draft = restart.draft; first = restart.keepStartup;
  }
}
