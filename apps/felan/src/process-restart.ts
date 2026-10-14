import { spawn } from 'node:child_process';

const RESTART_WORKER_ENV = 'FELAN_RESTART_WORKER';
const RESTART_EXIT_CODE = 75;

interface RestartHandoff {
  readonly type: 'felan-restart';
  readonly sessionId?: string;
  readonly cwd: string;
  readonly restartArgs: readonly string[];
}

type SendToParent = (message: RestartHandoff, callback: (error: Error | null) => void) => boolean;

export interface RestartProcessOptions {
  readonly sessionId?: string;
  readonly cwd: string;
  readonly restartArgs?: readonly string[];
  readonly execve?: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never;
  readonly spawn?: typeof spawn;
  readonly exit?: (code: number) => never;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly send?: SendToParent;
}

export type RestartProcess = (options: RestartProcessOptions) => Promise<never>;

/** Replaces this client process with a fresh one that resumes the session; platforms without execve use a supervising parent. */
export async function restartFelanProcess(options: RestartProcessOptions): Promise<never> {
  const handoff: RestartHandoff = { type: 'felan-restart', ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    cwd: options.cwd, restartArgs: [...(options.restartArgs ?? [])] };
  const env = options.env ?? process.env;
  const execve = options.execve ?? process.execve;
  if ((options.platform ?? process.platform) !== 'win32' && execve !== undefined) {
    const previousCwd = process.cwd();
    try {
      process.chdir(handoff.cwd);
      return execve(process.execPath, [process.execPath, ...nodeArguments(handoff)], env);
    } catch (error) {
      process.chdir(previousCwd);
      throw error;
    }
  }

  const send = options.send ?? (typeof process.send === 'function' ? process.send.bind(process) as SendToParent : undefined);
  const exit = options.exit ?? process.exit;
  if (env[RESTART_WORKER_ENV] === '1' && send !== undefined) {
    await new Promise<void>((resolve, reject) => { send(handoff, error => { if (error) reject(error); else resolve(); }); });
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

function nodeArguments(handoff: RestartHandoff): string[] {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('Cannot restart Felan Code without a CLI entrypoint');
  return [entrypoint, ...handoff.restartArgs, ...(handoff.sessionId ? ['--session', handoff.sessionId] : [])];
}

async function runRestartWorker(spawnProcess: typeof spawn, handoff: RestartHandoff, env: NodeJS.ProcessEnv):
  Promise<{ readonly code: number | null; readonly handoff?: RestartHandoff }> {
  const child = spawnProcess(process.execPath, nodeArguments(handoff), {
    cwd: handoff.cwd, env: { ...env, [RESTART_WORKER_ENV]: '1' }, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], windowsHide: false,
  });
  let requested: RestartHandoff | undefined;
  child.on('message', (message: unknown) => { if (isRestartHandoff(message)) requested = message; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  return { code, ...(requested === undefined ? {} : { handoff: requested }) };
}

function isRestartHandoff(value: unknown): value is RestartHandoff {
  if (typeof value !== 'object' || value === null) return false;
  const handoff = value as Partial<RestartHandoff>;
  return handoff.type === 'felan-restart'
    && (handoff.sessionId === undefined || typeof handoff.sessionId === 'string')
    && typeof handoff.cwd === 'string'
    && Array.isArray(handoff.restartArgs)
    && handoff.restartArgs.every(argument => typeof argument === 'string');
}
