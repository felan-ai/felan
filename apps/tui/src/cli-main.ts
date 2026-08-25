import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { RunLocalFelanHeadlessOptions, RunLocalFelanOptions } from './application.js';
import {
  getExtensionConfigCliOptions,
  parseExtensionConfigCliValue,
  type ExtensionConfigOverride,
} from '@felan-ai/agent-core';
import { loadLocalExtensionConfigDefinitions, resolveBuiltinExtensionPackages } from './extensions.js';
import { createLocalSettingsManager, getFelanSettings } from './settings.js';
import { getLocalAgentDir } from './runtime.js';
import { runFelanUpdate } from './update.js';
import { FELAN_VERSION } from './version.js';

export interface CliDependencies {
  readonly writeOutput?: (line: string) => void;
  readonly writeError?: (line: string) => void;
  readonly launch?: (options: RunLocalFelanOptions) => Promise<void>;
  readonly launchHeadless?: (options: RunLocalFelanHeadlessOptions) => Promise<number>;
  readonly pickSession?: () => Promise<SessionManager | undefined>;
  readonly openSession?: (sessionId: string, sessionDir?: string) => Promise<SessionManager>;
  readonly update?: () => Promise<number>;
}

const help = (configOptions: readonly ReturnType<typeof getExtensionConfigCliOptions>[number][] = []) => `Usage: felan [options] [message]

Options:
  --mode <text|json>  Run one headless session (JSON emits machine-readable JSONL)
  --provider <name>   Select a headless model provider
  --model <name>      Select a headless model or provider/model reference
  --thinking <level>  Select headless thinking: off|minimal|low|medium|high|xhigh|max
  -c, --continue     Continue the most recent session for this directory
  -r, --resume       Pick a session to resume
  --session <id>     Resume a specific session
  --session-dir <dir> Session directory for --session
  --diagnostics      Print local runtime versions and configuration mode
  update             Update a global npm installation of Felan
  -h, --help         Show this help
  -v, --version      Print the Felan version
  --verbose          Show verbose startup details
${configOptions.map((option) => `  --${option.name}${option.configField.type === 'boolean' ? '' : ` <${option.configField.values?.join('|') ?? option.configField.type}>`}  ${option.configField.description}`).join('\n')}`;

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
  let mode: 'text' | 'json' | undefined;
  let provider: string | undefined;
  let model: string | undefined;
  let thinkingLevel: RunLocalFelanHeadlessOptions['thinkingLevel'];
  const messageParts: string[] = [];
  let positionalOnly = false;
  const cliOverrides = new Map<string, Record<string, unknown>>();
  const startupSettings = createLocalSettingsManager(process.cwd(), getLocalAgentDir());
  const enabledPackages = resolveBuiltinExtensionPackages(getFelanSettings(startupSettings).builtinExtensions);
  const configOptions = getExtensionConfigCliOptions(await loadLocalExtensionConfigDefinitions(enabledPackages));
  const configByName = new Map(configOptions.map((option) => [option.name, option]));

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
      writeOutput(help(configOptions));
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
    } else if (argument.startsWith('--no-')) {
      const option = configByName.get(argument.slice('--no-'.length));
      if (!option || option.configField.type !== 'boolean') {
        writeError(`Unknown option: ${argument}`);
        return 1;
      }
      const values = cliOverrides.get(option.extensionId) ?? {};
      values[option.field] = false;
      cliOverrides.set(option.extensionId, values);
    } else if (argument.startsWith('--')) {
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
          const values = cliOverrides.get(option.extensionId) ?? {};
          values[option.field] = parseExtensionConfigCliValue(option, raw);
          cliOverrides.set(option.extensionId, values);
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
  if (mode !== undefined) {
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

  if (mode !== undefined) {
    const launchHeadless = dependencies.launchHeadless ?? (async (options: RunLocalFelanHeadlessOptions) => {
      const { runLocalFelanHeadless } = await import('./application.js');
      return runLocalFelanHeadless(options);
    });
    return launchHeadless({
      mode,
      initialMessage: messageParts.join(' '),
      ...(provider === undefined ? {} : { provider }),
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
      continueRecent,
      ...(sessionManager === undefined ? {} : { sessionManager }),
      ...(cliOverrides.size === 0 ? {} : {
        extensionConfigOverrides: [...cliOverrides].map(([extensionId, values]) => ({
          extensionId,
          values,
          source: 'CLI',
        })) satisfies ExtensionConfigOverride[],
      }),
    });
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
    ...(cliOverrides.size === 0 ? {} : {
      extensionConfigOverrides: [...cliOverrides].map(([extensionId, values]) => ({
        extensionId,
        values,
        source: 'CLI',
      })) satisfies ExtensionConfigOverride[],
    }),
  });
  return 0;
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
