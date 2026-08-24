import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { RunLocalFelanOptions } from './application.js';
import { runFelanUpdate } from './update.js';
import { FELAN_VERSION } from './version.js';

export interface CliDependencies {
  readonly writeOutput?: (line: string) => void;
  readonly writeError?: (line: string) => void;
  readonly launch?: (options: RunLocalFelanOptions) => Promise<void>;
  readonly pickSession?: () => Promise<SessionManager | undefined>;
  readonly openSession?: (sessionId: string, sessionDir?: string) => Promise<SessionManager>;
  readonly update?: () => Promise<number>;
}

const help = `Usage: felan [options] [message]

Options:
  -c, --continue     Continue the most recent session for this directory
  -r, --resume       Pick a session to resume
  --session <id>     Resume a specific session
  --session-dir <dir> Session directory for --session
  --diagnostics      Print local runtime versions and configuration mode
  update             Update a global npm installation of Felan
  -h, --help         Show this help
  -v, --version      Print the Felan version
  --verbose          Show verbose startup details`;

export async function runCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const writeOutput = dependencies.writeOutput ?? ((line) => console.log(line));
  const writeError = dependencies.writeError ?? ((line) => console.error(line));
  if (args[0] === 'update') {
    if (args.length !== 1) {
      writeError('Usage: felan update');
      return 1;
    }
    return dependencies.update?.() ?? runFelanUpdate({ writeOutput, writeError });
  }

  let continueRecent = false;
  let resume = false;
  let sessionId: string | undefined;
  let sessionDir: string | undefined;
  let verbose = false;
  const messageParts: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (positionalOnly) {
      messageParts.push(argument);
      continue;
    }
    if (argument === '--') {
      positionalOnly = true;
    } else if (argument === '-c' || argument === '--continue') {
      continueRecent = true;
    } else if (argument === '-r' || argument === '--resume') {
      resume = true;
    } else if (argument === '--session') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        writeError('--session requires an id');
        return 1;
      }
      sessionId = value;
      index += 1;
    } else if (argument === '--session-dir') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        writeError('--session-dir requires a directory');
        return 1;
      }
      sessionDir = value;
      index += 1;
    } else if (argument === '--verbose') {
      verbose = true;
    } else if (argument === '-h' || argument === '--help') {
      writeOutput(help);
      return 0;
    } else if (argument === '-v' || argument === '--version') {
      writeOutput(FELAN_VERSION);
      return 0;
    } else if (argument === '--diagnostics') {
      const [{ AGENT_CORE_VERSION }, { VERSION: PI_VERSION }] = await Promise.all([
        import('@felan-ai/agent-core'),
        import('@earendil-works/pi-coding-agent'),
      ]);
      writeOutput(`Felan version: ${FELAN_VERSION}`);
      writeOutput(`Agent Core version: ${AGENT_CORE_VERSION}`);
      writeOutput(`Pi version: ${PI_VERSION}`);
      writeOutput(`Node version: ${process.versions.node}`);
      writeOutput('Runtime: host');
      writeOutput('Credentials: local');
      return 0;
    } else if (argument.startsWith('-')) {
      writeError(`Unknown option: ${argument}`);
      return 1;
    } else {
      messageParts.push(argument);
    }
  }

  if (continueRecent && (resume || sessionId !== undefined)) {
    writeError('Cannot combine --continue with --resume or --session');
    return 1;
  }
  if (resume && sessionId !== undefined) {
    writeError('Cannot combine --resume with --session');
    return 1;
  }
  if (sessionDir !== undefined && sessionId === undefined) {
    writeError('--session-dir requires --session');
    return 1;
  }

  let sessionManager: SessionManager | undefined;
  if (resume) {
    const pickSession = dependencies.pickSession
      ?? (await import('./resume.js')).selectLocalSessionManager;
    sessionManager = await pickSession();
    if (!sessionManager) return 0;
  } else if (sessionId !== undefined) {
    const openSession = dependencies.openSession
      ?? (await import('./resume.js')).openLocalSessionManager;
    sessionManager = await openSession(sessionId, sessionDir);
  }

  const launch = dependencies.launch ?? (async (options: RunLocalFelanOptions) => {
    const { runLocalFelan } = await import('./application.js');
    await runLocalFelan(options);
  });
  await launch({
    continueRecent,
    verbose,
    ...(sessionManager === undefined ? {} : { sessionManager }),
    ...(messageParts.length === 0 ? {} : { initialMessage: messageParts.join(' ') }),
  });
  return 0;
}
