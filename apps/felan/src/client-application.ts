import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DaemonTarget } from '@felan-ai/daemon/client';
import { SessionClient, type SessionClientOptions } from './client/client.js';
import { resolveClientHostComposition, resolveInstalledDaemonEntrypoint } from './daemon-entrypoint.js';
import { TuiSessionController, type TuiSessionOptions } from './tui/controller.js';
import { runDaemonTerminal } from './tui/run.js';
import { FELAN_VERSION } from './version.js';
import type { TuiPresentationPreferences } from './tui/preferences-schema.js';
import type { DaemonIdentity } from '@felan-ai/session-protocol';
import { waitForDaemonStop } from './client/daemon-stop.js';
import { clientDiagnosticsLog } from './client/diagnostics.js';
import { DAEMON_VERSION } from '@felan-ai/daemon';
import { TERMINAL_INTERACTION_KINDS, TERMINAL_UI_CAPABILITIES } from './tui/interactions.js';
import { createHerdrPane } from './tui/herdr.js';
import { restartFelanProcess, type RestartProcess } from './process-restart.js';

export interface RunDaemonFelanOptions extends Omit<TuiSessionOptions, 'cwd' | 'extensions'> {
  cwd?: string;
  agentDir?: string;
  daemonRuntime?: string;
  hostConfigPath?: string;
  extensionPaths?: readonly string[];
  initialMessage?: string;
  verbose?: boolean;
  /** Launch arguments that `/restart` repeats when it re-executes the client; session selection and the initial prompt are excluded. */
  restartArgs?: readonly string[];
  presentation?: Partial<{ [K in keyof TuiPresentationPreferences]: Partial<TuiPresentationPreferences[K]> }>;
  signal?: AbortSignal;
}

export function getClientAgentDir(): string { return resolve(process.env.FELAN_AGENT_DIR ?? join(homedir(), '.felan')); }

export function clientDaemonTarget(options: RunDaemonFelanOptions): DaemonTarget {
  if (options.daemonRuntime) {
    const directory = resolve(options.daemonRuntime);
    return { kind: 'isolated', directory, namespaceId: `cli-${createHash('sha256').update(directory).digest('hex').slice(0, 32)}`, storeRoots: [directory] };
  }
  return { kind: 'production', agentDir: resolve(options.agentDir ?? getClientAgentDir()), storeRoots: [] };
}

export function clientConfigurationRoot(options: RunDaemonFelanOptions): string {
  return options.daemonRuntime ? join(resolve(options.daemonRuntime), 'client') : resolve(options.agentDir ?? getClientAgentDir());
}

/** The command that reattaches to `session` through the same daemon and session folder. */
export function resumeCommand(session: string, options: Pick<RunDaemonFelanOptions, 'daemonRuntime' | 'sessionDir'>): string {
  return ['felan', ...(options.daemonRuntime ? ['--daemon-runtime', shellQuote(resolve(options.daemonRuntime))] : []),
    ...(options.sessionDir ? ['--session-dir', shellQuote(resolve(options.sessionDir))] : []), '--session', shellQuote(session)].join(' ');
}

function shellQuote(value: string): string {
  return /^[\w\-./~:@]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** Like Pi's interactive quit, the hint goes only to a terminal, with a dim label. */
function writeResumeHint(text: string): void {
  if (process.stdout.isTTY) process.stdout.write(text.replace('To resume this session:', '\x1b[2mTo resume this session:\x1b[22m'));
}

/** Client diagnostics live next to the daemon's `felan.jsonl`, in `client.jsonl`. */
export function clientLogDirectory(options: RunDaemonFelanOptions): string {
  return join(clientConfigurationRoot(options), 'storage', 'agent', 'logs');
}

export async function runDaemonFelan(options: RunDaemonFelanOptions = {}, dependencies: {
  createClient?: (options: SessionClientOptions) => SessionClient;
  runTerminal?: typeof runDaemonTerminal;
  waitForStop?: typeof waitForDaemonStop;
  restartProcess?: RestartProcess;
  writeOutput?: (text: string) => void;
} = {}): Promise<void> {
  let replacing: DaemonIdentity | undefined;
  let selected = options.sessionId;
  let cwd = resolve(options.cwd ?? process.cwd());
  let draft = '';
  let first = true;
  const diagnostics = clientDiagnosticsLog(clientLogDirectory(options));
  const herdr = createHerdrPane();
  while (!options.signal?.aborted) {
    const target = clientDaemonTarget(options);
    const expectedComposition = dependencies.createClient ? undefined : await resolveClientHostComposition(target, options.hostConfigPath);
    const client = (dependencies.createClient ?? (options => new SessionClient(options)))({ target, diagnostics: diagnostics.write,
      clientVersion: FELAN_VERSION, expectedDaemonVersion: DAEMON_VERSION, ...(expectedComposition ? { expectedComposition } : {}), kind: 'tui', interactionKinds: [...TERMINAL_INTERACTION_KINDS], capabilities: [...TERMINAL_UI_CAPABILITIES],
      launch: { entrypoint: resolveInstalledDaemonEntrypoint(), ...(options.hostConfigPath ? { hostConfigPath: resolve(options.hostConfigPath) } : {}), ...(replacing ? { replacing } : {}) } });
    const controller = new TuiSessionController(client);
    const outcome: { restart?: { identity: DaemonIdentity; sessionId?: string; cwd: string; draft: string; keepStartup: boolean }; relaunch?: { sessionId?: string; cwd: string } } = {};
    let resumable: string | undefined;
    try {
      await (dependencies.runTerminal ?? runDaemonTerminal)(controller, { cwd, clientConfigDir: clientConfigurationRoot(options),
        ...(selected ? { sessionId: selected } : {}), ...(options.sessionDir ? { sessionDir: resolve(options.sessionDir) } : {}),
        ...(first && options.continueRecent ? { continueRecent: true } : {}), ...(first && options.resume ? { resume: true } : {}),
        ...(first && options.extensionPaths?.length ? { extensions: options.extensionPaths.map(path => resolve(path)) } : {}),
        ...(first && options.config ? { config: options.config } : {}), ...(first && options.initialMessage ? { initialMessage: options.initialMessage } : {}),
        ...(options.presentation ? { presentation: options.presentation } : {}),
        ...(draft ? { initialDraft: draft } : {}), ...(herdr ? { herdr } : {}),
        ...(options.signal ? { signal: options.signal } : {}), ...(options.verbose ? { verbose: true } : {}),
        onDaemonAction: async (action, force, text, beforeAttachment) => {
          const identity = client.identity;
          if (!identity) throw new Error('Connect to a verified daemon before using lifecycle controls.');
          const result = await client.control(action === 'stop' ? 'host.stop' : 'host.restart', force ? 'force' : 'drain');
          if (result.outcome !== 'accepted') throw new Error('Daemon control was not accepted. Inspect status before retrying.');
          const inPlace = action !== 'stop' && !beforeAttachment;
          if (inPlace) controller.setNotice('Daemon restarting…');
          await (dependencies.waitForStop ?? waitForDaemonStop)(client, options.signal);
          if (inPlace) {
            await controller.reconnect({ replacing: identity });
            if (action === 'relaunch') {
              const sessionId = controller.sessionId ?? selected;
              outcome.relaunch = { ...(sessionId ? { sessionId } : {}), cwd: controller.snapshot?.cwd ?? cwd };
              controller.setNotice('Restarting Felan Code…');
              return true;
            }
            controller.setNotice('Daemon restarted');
            return false;
          }
          if (action === 'restart') {
            const sessionId = controller.sessionId ?? selected;
            outcome.restart = { identity, ...(sessionId ? { sessionId } : {}), cwd: controller.snapshot?.cwd ?? cwd,
              draft: /^\/(?:daemon|restart)(?:\s|$)/u.test(text.trim()) ? '' : text, keepStartup: beforeAttachment === true && first };
          }
          return true;
        },
      });
      resumable = controller.sessionId;
    } finally { await controller.dispose(); await diagnostics.flush(); }
    if (outcome.relaunch) {
      await (dependencies.restartProcess ?? restartFelanProcess)({ ...outcome.relaunch, ...(options.restartArgs ? { restartArgs: options.restartArgs } : {}) });
      return;
    }
    const restart = outcome.restart;
    if (!restart) {
      if (resumable) (dependencies.writeOutput ?? writeResumeHint)(`To resume this session: ${resumeCommand(resumable, options)}\n`);
      return;
    }
    replacing = restart.identity; selected = restart.sessionId; cwd = restart.cwd; draft = restart.draft; first = restart.keepStartup;
  }
}
