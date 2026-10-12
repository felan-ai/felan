import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, link, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';

const RESTART_WORKER_ENV = 'FELAN_RESTART_WORKER';
const RESTART_EXIT_CODE = 75;

interface RestartHandoff {
  readonly type: 'felan-restart';
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly cwd: string;
  readonly verbose: boolean;
  readonly restartArgs: readonly string[];
}

type SendToParent = (
  message: RestartHandoff,
  callback: (error: Error | null) => void,
) => boolean;

export interface RestartProcessOptions {
  readonly sessionManager: SessionManager;
  readonly verbose: boolean;
  readonly restartArgs?: readonly string[];
  readonly execve?: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never;
  readonly spawn?: typeof spawn;
  readonly exit?: (code: number) => never;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly send?: SendToParent;
}

export type RestartProcess = (options: RestartProcessOptions) => Promise<never>;

export async function restartFelanProcess(options: RestartProcessOptions): Promise<never> {
  const sessionManager = options.sessionManager;
  const sessionFile = sessionManager.getSessionFile();
  if (!sessionFile) throw new Error('Cannot restart an in-memory session');
  await materializeSession(sessionManager, sessionFile);

  const handoff = createRestartHandoff(options);
  const env = options.env ?? process.env;
  const execve = options.execve ?? process.execve;
  if ((options.platform ?? process.platform) !== 'win32' && execve !== undefined) {
    const previousCwd = process.cwd();
    try {
      process.chdir(handoff.cwd);
      return execve(
        process.execPath,
        [process.execPath, ...nodeArguments(handoff)],
        env,
      );
    } catch (error) {
      process.chdir(previousCwd);
      throw error;
    }
  }

  const send = options.send ?? (typeof process.send === 'function'
    ? process.send.bind(process) as SendToParent
    : undefined);
  const exit = options.exit ?? process.exit;
  if (env[RESTART_WORKER_ENV] === '1' && send !== undefined) {
    await sendRestartHandoff(send, handoff);
    return exit(RESTART_EXIT_CODE);
  }

  let next = handoff;
  while (true) {
    const result = await runRestartWorker(options.spawn ?? spawn, next, env);
    if (result.code === RESTART_EXIT_CODE && result.handoff !== undefined) {
      next = result.handoff;
      continue;
    }
    return exit(result.code ?? 1);
  }
}

async function materializeSession(sessionManager: SessionManager, sessionFile: string): Promise<void> {
  try {
    await access(sessionFile, constants.F_OK);
    return;
  } catch (error) {
    if (!isErrorCode(error, 'ENOENT')) throw error;
  }

  const directory = dirname(sessionFile);
  await mkdir(directory, { recursive: true });
  const header = sessionManager.getHeader();
  if (!header) throw new Error('Cannot restart a session without a session header');
  const entries = [header, ...sessionManager.getEntries()];
  const content = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  const temporaryFile = join(directory, `.${basename(sessionFile)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryFile, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    try {
      await link(temporaryFile, sessionFile);
    } catch (error) {
      if (!isErrorCode(error, 'EEXIST')) throw error;
    }
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }
}

function createRestartHandoff(options: RestartProcessOptions): RestartHandoff {
  return {
    type: 'felan-restart',
    sessionId: options.sessionManager.getSessionId(),
    sessionDir: options.sessionManager.getSessionDir(),
    cwd: options.sessionManager.getCwd(),
    verbose: options.verbose,
    restartArgs: [...(options.restartArgs ?? [])],
  };
}

function nodeArguments(handoff: RestartHandoff): string[] {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('Cannot restart Felan Code without a CLI entrypoint');
  return [
    entrypoint,
    ...handoff.restartArgs,
    '--session-dir', handoff.sessionDir,
    '--session', handoff.sessionId,
    ...(handoff.verbose && !handoff.restartArgs.includes('--verbose') ? ['--verbose'] : []),
  ];
}

async function runRestartWorker(
  spawnProcess: typeof spawn,
  handoff: RestartHandoff,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly handoff?: RestartHandoff }> {
  const child = spawnProcess(process.execPath, nodeArguments(handoff), {
    cwd: handoff.cwd,
    env: { ...env, [RESTART_WORKER_ENV]: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    windowsHide: false,
  });
  let requestedHandoff: RestartHandoff | undefined;
  child.on('message', (message: unknown) => {
    if (isRestartHandoff(message)) requestedHandoff = message;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return {
    code,
    ...(requestedHandoff === undefined ? {} : { handoff: requestedHandoff }),
  };
}

function sendRestartHandoff(send: SendToParent, handoff: RestartHandoff): Promise<void> {
  return new Promise((resolve, reject) => {
    send(handoff, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function isRestartHandoff(value: unknown): value is RestartHandoff {
  if (typeof value !== 'object' || value === null) return false;
  const handoff = value as Partial<RestartHandoff>;
  return handoff.type === 'felan-restart'
    && typeof handoff.sessionId === 'string'
    && typeof handoff.sessionDir === 'string'
    && typeof handoff.cwd === 'string'
    && typeof handoff.verbose === 'boolean'
    && Array.isArray(handoff.restartArgs)
    && handoff.restartArgs.every((argument) => typeof argument === 'string');
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
