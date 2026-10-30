import type { RunLocalFelanHeadlessOptions } from './headless.js';
import type { RunDaemonFelanOptions } from './client-application.js';
import type { CliConfigOption } from './cli-config.js';
import { FELAN_VERSION } from './version.js';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { suggestTopLevelCommand } from './cli-command-suggestions.js';

export interface CliDependencies {
  readonly writeOutput?: (line: string) => void;
  readonly writeError?: (line: string) => void;
  readonly launch?: (options: RunDaemonFelanOptions) => Promise<void>;
  readonly launchHeadless?: (options: RunLocalFelanHeadlessOptions) => Promise<number>;
  readonly launchAcp?: (options?: { agentDir?: string; daemonRuntime?: string }) => Promise<number>;
  readonly launchAcpLogin?: (options?: { agentDir?: string; daemonRuntime?: string }) => Promise<number>;
  readonly launchDaemon?: (args: readonly string[]) => Promise<number>;
  readonly update?: () => Promise<number>;
}

const help = (configOptions: readonly CliConfigOption[] = []) => `Usage: felan [options] [message]

Options:
  --mode <text|json>  Run one headless session (JSON emits machine-readable JSONL)
  --provider <name>   Select a headless model provider
  --model <name>      Select a headless model or provider/model reference
  --thinking <level>  Select headless thinking: off|minimal|low|medium|high|xhigh|max
  -e, --extension <path>  Load a local Pi extension (repeatable; interactive TUI only)
  -c, --continue     Continue the most recent session for this directory
  -r, --resume       Pick a session to resume
  --session <id>     Resume a specific session
  --session-dir <dir> Session directory for --session
  --daemon-runtime <dir> Explicit isolated runtime directory (tests/CI only)
  --diagnostics      Print local runtime versions and configuration mode
  update             Update a global npm installation of Felan Code
  savings            Show persisted estimated API-equivalent savings
  acp [login]        Serve Agent Client Protocol v1 or authenticate in a terminal
  daemon [command]   Start, inspect, stop or restart the local daemon
  -h, --help         Show this help
  -v, --version      Print the Felan Code version
  --verbose          Show verbose startup details
${configOptions.map((option) => `  --${option.name}${option.configField.type === 'boolean' ? '' : ` <${option.configField.values?.join('|') ?? option.configField.type}>`}  ${option.configField.description}`).join('\n')}`;

export async function runCli(args: readonly string[], dependencies: CliDependencies = {}): Promise<number> {
  const writeOutput = dependencies.writeOutput ?? ((line) => console.log(line));
  const writeError = dependencies.writeError ?? ((line) => console.error(line));
  const suggestion = suggestTopLevelCommand(args);
  if (suggestion) {
    writeError(`Unknown command: ${args[0]}. Did you mean: felan ${[suggestion, ...args.slice(1)].join(' ')}?`);
    writeError('Use felan -- <message> to send this as a prompt.');
    return 1;
  }
  if (args[0] === 'daemon') {
    if (dependencies.launchDaemon) return dependencies.launchDaemon(args.slice(1));
    const { runDaemonCommand } = await import('./daemon-command.js');
    return runDaemonCommand(args.slice(1), { writeOutput, writeError });
  }
  if (args[0] === 'update') {
    if (args.length !== 1) {
      writeError('Usage: felan update');
      return 1;
    }
    if (dependencies.update) return dependencies.update();
    const { runFelanUpdate } = await import('./update.js');
    return runFelanUpdate({ writeOutput, writeError });
  }
  if (args[0] === 'savings') {
    return runSavingsCommand(args.slice(1), writeOutput, writeError);
  }

  if (args[0] === 'acp') {
    const login = args[1] === 'login';
    const rest = args.slice(login ? 2 : 1);
    const usage = login ? 'Usage: felan acp login' : 'Usage: felan acp [login]';
    if (rest.length === 1 && (rest[0] === '-h' || rest[0] === '--help')) { writeOutput(usage); return 0; }
    if (rest.length && (rest.length !== 2 || rest[0] !== '--daemon-runtime' || !isAbsolute(rest[1]!))) {
      writeError(usage); return 1;
    }
    const { getClientAgentDir } = await import('./client-application.js');
    const options = { agentDir: getClientAgentDir(), ...(rest[1] ? { daemonRuntime: rest[1] } : {}) };
    if (login) {
      const launchAcpLogin = dependencies.launchAcpLogin ?? (async (options?: { agentDir?: string; daemonRuntime?: string }) => {
        const { runLocalFelanAcpLogin } = await import('./acp/login.js');
        const { openInBrowser } = await import('./tui/browser.js');
        return runLocalFelanAcpLogin({ ...options, openBrowser: openInBrowser });
      });
      return launchAcpLogin(options);
    }
    const launchAcp = dependencies.launchAcp ?? (async (options?: { agentDir?: string; daemonRuntime?: string }) => {
      const { runLocalFelanAcp } = await import('./acp/server.js');
      return runLocalFelanAcp(options);
    });
    return launchAcp(options);
  }

  let continueRecent = false;
  let resume = false;
  let sessionId: string | undefined;
  let sessionDir: string | undefined;
  let daemonRuntime: string | undefined;
  let verbose = false;
  let mode: 'text' | 'json' | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let thinkingLevel: RunLocalFelanHeadlessOptions['thinkingLevel'];
  const extensionPaths: string[] = [];
  const messageParts: string[] = [];
  let positionalOnly = false;
  const cliValues: Record<string, Record<string, unknown>> = {};
  const presentation: Record<string, Record<string, unknown>> = {};
  let configOptions: readonly CliConfigOption[] | undefined;
  const configByName = new Map<string, CliConfigOption>();
  const loadConfigOptions = async () => {
    if (!configOptions) {
      const { cliConfigOptions } = await import('./cli-config.js');
      configOptions = await cliConfigOptions();
      for (const option of configOptions) configByName.set(option.name, option);
    }
    return configOptions;
  };

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
    } else if (argument === '--mode') {
      const value = args[index + 1];
      if (value !== 'text' && value !== 'json') {
        writeError('--mode requires text or json');
        return 1;
      }
      mode = value;
      index += 1;
    } else if (argument === '--provider' || argument === '--model' || argument === '--thinking') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        writeError(`${argument} requires a value`);
        return 1;
      }
      if (argument === '--provider') provider = value;
      else if (argument === '--model') model = value;
      else thinkingLevel = parseThinkingLevel(value, writeError);
      if (argument === '--thinking' && thinkingLevel === undefined) return 1;
      index += 1;
    } else if (argument === '-e' || argument === '--extension') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('-')) {
        writeError(`${argument} requires a local extension path`);
        return 1;
      }
      try {
        extensionPaths.push(resolveLocalExtensionPath(value, process.cwd()));
      } catch (error) {
        writeError(error instanceof Error ? error.message : String(error));
        return 1;
      }
      index += 1;
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
    } else if (argument === '--daemon-runtime') {
      const value = args[index + 1];
      if (!value || !isAbsolute(value)) { writeError('--daemon-runtime requires an absolute isolated directory'); return 1; }
      daemonRuntime = value;
      index += 1;
    } else if (argument === '--verbose') {
      verbose = true;
    } else if (argument === '-h' || argument === '--help') {
      writeOutput(help(await loadConfigOptions()));
      return 0;
    } else if (argument === '-v' || argument === '--version') {
      writeOutput(FELAN_VERSION);
      return 0;
    } else if (argument === '--diagnostics') {
      const [{ AGENT_CORE_VERSION }, { VERSION: PI_VERSION }] = await Promise.all([
        import('@felan-ai/agent-core'),
        import('@earendil-works/pi-coding-agent'),
      ]);
      writeOutput(`Felan Code version: ${FELAN_VERSION}`);
      writeOutput(`Agent Core version: ${AGENT_CORE_VERSION}`);
      writeOutput(`Pi version: ${PI_VERSION}`);
      writeOutput(`Node version: ${process.versions.node}`);
      writeOutput('Runtime: local daemon client');
      writeOutput('Credentials: local');
      return 0;
    } else if (argument.startsWith('--no-')) {
      await loadConfigOptions();
      const option = configByName.get(argument.slice('--no-'.length));
      if (!option || option.configField.type !== 'boolean') { writeError(`Unknown option: ${argument}`); return 1; }
      const target = option.presentation ? presentation : cliValues;
      (target[option.extensionId] ??= {})[option.field] = false;
    } else if (argument.startsWith('--')) {
      await loadConfigOptions();
      const equals = argument.indexOf('=');
      const name = argument.slice(2, equals === -1 ? undefined : equals);
      const option = configByName.get(name);
      if (option) {
        let raw: string | boolean;
        if (equals !== -1) raw = argument.slice(equals + 1);
        else if (option.configField.type === 'boolean') raw = true;
        else {
          const value = args[index + 1];
          if (value === undefined || value.startsWith('-')) {
            writeError(`--${name} requires a value`);
            return 1;
          }
          raw = value;
          index += 1;
        }
        try {
          const { parseCliConfigValue } = await import('./cli-config.js');
          const target = option.presentation ? presentation : cliValues;
          (target[option.extensionId] ??= {})[option.field] = parseCliConfigValue(option, raw);
        } catch (error) {
          writeError(error instanceof Error ? error.message : String(error));
          return 1;
        }
      } else {
        writeError(`Unknown option: ${argument}`);
        return 1;
      }
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
  if (mode !== undefined && Object.keys(presentation).length) { writeError('Display options are interactive-only'); return 1; }
  if (mode !== undefined) {
    if (extensionPaths.length > 0) {
      writeError('--extension is interactive-only');
      return 1;
    }
    if (provider !== undefined && model === undefined) {
      writeError('--provider requires --model in headless mode');
      return 1;
    }
    if (resume) {
      writeError('--resume is interactive-only; use --continue or --session in headless mode');
      return 1;
    }
    if (messageParts.length === 0) {
      writeError(`--mode ${mode} requires an initial prompt`);
      return 1;
    }
  } else if (provider !== undefined || model !== undefined || thinkingLevel !== undefined) {
    writeError('--provider, --model, and --thinking require --mode text or --mode json');
    return 1;
  }
  const loadConfigValues = async () => {
    const { ConfigValuesSchema, parseSchema } = await import('@felan-ai/session-protocol');
    return parseSchema(ConfigValuesSchema, { extensionConfig: cliValues });
  };
  if (mode !== undefined) {
    const launchHeadless = dependencies.launchHeadless ?? (async (options: RunLocalFelanHeadlessOptions) => {
      const { runLocalFelanHeadless } = await import('./headless.js');
      return runLocalFelanHeadless(options);
    });
    return launchHeadless({
      mode,
      initialMessage: messageParts.join(' '),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      continueRecent,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(sessionDir === undefined ? {} : { sessionDir }),
      ...(daemonRuntime === undefined ? {} : { daemonRuntime }),
      ...(Object.keys(cliValues).length ? { config: await loadConfigValues() } : {}),
    });
  }

  const launch = dependencies.launch ?? (async (options: RunDaemonFelanOptions) => {
    const { runDaemonFelan } = await import('./client-application.js');
    await runDaemonFelan(options);
  });
  const restartArgs = buildRestartArgs(args, configByName);
  try {
    await launch({ continueRecent, verbose, ...(restartArgs.length ? { restartArgs } : {}),
      ...(Object.keys(presentation).length ? { presentation: presentation as NonNullable<RunDaemonFelanOptions['presentation']> } : {}),
      ...(resume ? { resume } : {}), ...(sessionId ? { sessionId } : {}), ...(sessionDir ? { sessionDir } : {}),
      ...(daemonRuntime ? { daemonRuntime } : {}),
      ...(messageParts.length ? { initialMessage: messageParts.join(' ') } : {}),
      ...(Object.keys(cliValues).length ? { config: await loadConfigValues() } : {}),
      ...(extensionPaths.length ? { extensionPaths } : {}),
    });
    return 0;
  } catch (error) { writeError(error instanceof Error ? error.message : String(error)); return 1; }
}

/** Repeats launch options for `/restart`; session selection and the initial prompt are excluded, and relative extension paths are resolved because the restart changes directory. */
function buildRestartArgs(args: readonly string[], configByName: ReadonlyMap<string, { readonly configField: { readonly type: string } }>): string[] {
  const restartArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') break;
    if (argument === '--session' || argument === '--session-dir') { index += 1; continue; }
    if (argument === '-e' || argument === '--extension') {
      restartArgs.push(argument, resolveLocalExtensionPath(args[index + 1]!, process.cwd())); index += 1; continue;
    }
    if (argument === '--daemon-runtime') { restartArgs.push(argument, args[index + 1]!); index += 1; continue; }
    if (argument === '--verbose') { restartArgs.push(argument); continue; }
    if (!argument.startsWith('--')) continue;
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals === -1 ? undefined : equals);
    const option = configByName.get(name) ?? (argument.startsWith('--no-') ? configByName.get(argument.slice('--no-'.length)) : undefined);
    if (!option) continue;
    restartArgs.push(argument);
    if (equals === -1 && !argument.startsWith('--no-') && option.configField.type !== 'boolean') { restartArgs.push(args[index + 1]!); index += 1; }
  }
  return restartArgs;
}

function resolveLocalExtensionPath(value: string, cwd: string): string {
  if (!/^[A-Za-z]:[\\/]/u.test(value) && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    throw new Error(`Extension source must be a local file or directory: ${value}`);
  }
  const expanded = value === '~'
    ? homedir()
    : value.startsWith('~/') || value.startsWith('~\\')
      ? resolve(homedir(), value.slice(2))
      : value;
  return resolve(cwd, expanded);
}

async function runSavingsCommand(
  args: readonly string[],
  writeOutput: (line: string) => void,
  writeError: (line: string) => void,
): Promise<number> {
  let project = false;
  let sessionId: string | undefined;
  let from: Date | undefined;
  let to: Date | undefined;
  let format: 'text' | 'json' = 'text';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--project') project = true;
    else if (argument === '--daily' || argument === '--monthly') {
      const now = new Date();
      const start = argument === '--daily'
        ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      from = start;
      to = now;
    } else if (argument === '--session') {
      const value = args[++index];
      if (!value || value.startsWith('-')) { writeError('--session requires an id'); return 1; }
      sessionId = value;
    } else if (argument === '--format') {
      const value = args[++index];
      if (value !== 'text' && value !== 'json') { writeError('--format requires text or json'); return 1; }
      format = value;
    } else if (argument === '--help') {
      writeOutput('Usage: felan savings [--project|--session <id>] [--daily|--monthly] [--format text|json]');
      return 0;
    } else {
      writeError(`Unknown savings option: ${argument}`);
      return 1;
    }
  }
  if (project && sessionId !== undefined) { writeError('Cannot combine --project with --session'); return 1; }
  const cwd = resolve(process.cwd());
  const projectKey = createHash('sha256').update(cwd, 'utf8').digest('hex');
  const scope = sessionId !== undefined ? 'session' : project ? 'project' : 'all';
  const { runLocalSavingsCli } = await import('./savings-command.js');
  const { getClientAgentDir } = await import('./client-application.js');
  return runLocalSavingsCli({
    agentDir: getClientAgentDir(), cwd, projectKey, format, ...(sessionId === undefined ? {} : { sessionId }),
    query: { scope, ...(sessionId === undefined ? {} : { sessionId }), ...(project ? { projectKey } : {}), ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) },
    writeOutput,
  });
}

const THINKING_LEVELS = new Set<NonNullable<RunLocalFelanHeadlessOptions['thinkingLevel']>>([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

function parseThinkingLevel(
  value: string,
  writeError: (line: string) => void,
): NonNullable<RunLocalFelanHeadlessOptions['thinkingLevel']> | undefined {
  if (THINKING_LEVELS.has(value as NonNullable<RunLocalFelanHeadlessOptions['thinkingLevel']>)) {
    return value as NonNullable<RunLocalFelanHeadlessOptions['thinkingLevel']>;
  }
  writeError(`Invalid thinking level "${value}". Valid values: ${[...THINKING_LEVELS].join('|')}`);
  return undefined;
}
