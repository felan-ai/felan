import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime, ExecResult } from '@felan-ai/agent-core';
import { joinRuntimePath } from './runtime-path.js';
import type { AgentBrowserInvocation } from './installer.js';

export const MAX_BROWSER_OUTPUT_CHARACTERS = 44_000;
export const MAX_BROWSER_SKILL_OUTPUT_CHARACTERS = 100_000;
export const DEFAULT_BROWSER_TIMEOUT_MS = 60_000;
export const MAX_BROWSER_TIMEOUT_MS = 300_000;
export const BROWSER_IDLE_TIMEOUT = '1h';

const BLOCKED_MODEL_COMMANDS = new Set([
  'install',
  'upgrade',
  'doctor',
  'mcp',
  'chat',
  'dashboard',
  'stream',
  'plugin',
  'plugins',
  'batch',
  'confirm',
  'deny',
]);

const RESERVED_POLICY_OPTIONS = new Set([
  '--session',
  '--namespace',
  '--idle-timeout',
  '--json',
  '--content-boundaries',
  '--max-output',
  '--config',
  '--allowed-domains',
  '--action-policy',
  '--confirm-actions',
  '--confirm-interactive',
  '--allow-file-access',
]);

const CLOSE_COMMANDS = new Set(['close', 'quit', 'exit']);

const OPTIONS_WITH_VALUES = new Set([
  '--session', '--namespace', '--executable-path', '--extension', '--init-script',
  '--enable', '--args', '--user-agent', '--proxy', '--proxy-bypass', '--hide-scrollbars',
  '--provider', '-p', '--device', '--screenshot-dir', '--screenshot-quality',
  '--screenshot-format', '--cdp', '--color-scheme', '--download-path', '--max-output',
  '--allowed-domains', '--action-policy', '--confirm-actions', '--engine', '--model',
  '--config', '--idle-timeout', '--headers', '--profile', '--restore', '--restore-save',
  '--restore-check-url', '--restore-check-text', '--restore-check-fn', '--session-name',
  '--state', '--timeout',
]);

export interface BrowserSessionScope {
  readonly session: string;
  readonly namespace: string;
}

export interface BrowserCliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
  readonly killed: boolean;
  readonly generatedScreenshotPath?: string;
  readonly outputTruncated: boolean;
}

export interface PreparedBrowserCommand {
  readonly args: readonly string[];
  readonly generatedScreenshotPath?: string;
}

export function createBrowserSessionScope(
  runtime: AgentRuntime,
  sessionId: string,
): BrowserSessionScope {
  const namespaceHash = createHash('sha256')
    .update(`${runtime.storage('agent').root}\u0000${runtime.storage('session').root}`)
    .digest('hex')
    .slice(0, 16);
  const sessionHash = createHash('sha256')
    .update(`${runtime.storage('session').root}\u0000${sessionId}`)
    .digest('hex')
    .slice(0, 16);
  return {
    session: `f-${sessionHash}`,
    namespace: `f-${namespaceHash}`,
  };
}

export function prepareBrowserCommand(
  runtime: AgentRuntime,
  args: readonly string[],
): PreparedBrowserCommand {
  const command = findBrowserCommand(args);
  if (!command) {
    throw new Error('browser run args must start with an agent-browser command; place global options after the command.');
  }
  if (BLOCKED_MODEL_COMMANDS.has(command)) {
    throw new Error(`The browser tool does not run ${command}; use Felan's explicit dependency onboarding or host controls.`);
  }
  if (command === 'skills') {
    throw new Error('Use browser operation "skill" to retrieve version-matched agent-browser instructions.');
  }
  if (CLOSE_COMMANDS.has(command) && args.some((arg) => arg.split('=', 1)[0] === '--all')) {
    throw new Error('The browser tool closes only its own Felan session; omit --all.');
  }
  for (const arg of args.slice(1)) {
    if (arg === '--') {
      throw new Error('The browser tool does not accept the -- option terminator because Felan enforces trailing session and output policy.');
    }
    const option = arg.split('=', 1)[0];
    if (option && RESERVED_POLICY_OPTIONS.has(option)) {
      throw new Error(`The browser tool owns ${option}; omit it from args.`);
    }
  }
  const normalized = [...args];
  if (command !== 'screenshot') return { args: normalized };

  if (hasPositionalArgument(normalized.slice(1))) return { args: normalized };

  const screenshotPath = joinRuntimePath(
    runtime.storage('session').root,
    'browser/screenshots',
    `screenshot-${randomUUID()}.png`,
  );
  normalized.push(screenshotPath);
  return { args: normalized, generatedScreenshotPath: screenshotPath };
}

export async function runBrowserCli(
  runtime: AgentRuntime,
  invocation: AgentBrowserInvocation,
  args: readonly string[],
  scope: BrowserSessionScope,
  options: {
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
    readonly json?: boolean;
    readonly prepareScreenshot?: boolean;
  } = {},
): Promise<BrowserCliResult> {
  const sessionStorage = runtime.storage('session');
  const prepared = options.prepareScreenshot === false
    ? { args: [...args] }
    : prepareBrowserCommand(runtime, args);
  if (prepared.generatedScreenshotPath) await sessionStorage.mkdir('browser/screenshots', { recursive: true });
  const configPath = await writeIsolatedBrowserConfig(runtime);

  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const trustedArgs = [
    ...prepared.args,
    '--session',
    scope.session,
    '--namespace',
    scope.namespace,
    '--idle-timeout',
    BROWSER_IDLE_TIMEOUT,
    ...(options.json === false ? [] : ['--json', '--content-boundaries']),
    '--max-output',
    String(MAX_BROWSER_OUTPUT_CHARACTERS),
    '--config',
    configPath,
  ];
  let result: ExecResult;
  try {
    result = await runtime.exec(invocation.command, trustedArgs, {
      cwd: runtime.cwd,
      timeout: timeoutMs,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    return {
      stdout: '',
      stderr: boundOutput(errorMessage(error)),
      code: 1,
      killed: false,
      ...(prepared.generatedScreenshotPath === undefined ? {} : { generatedScreenshotPath: prepared.generatedScreenshotPath }),
      outputTruncated: false,
    };
  }

  return {
    stdout: boundOutput(result.stdout),
    stderr: boundOutput(result.stderr),
    code: result.code,
    killed: result.killed,
    ...(prepared.generatedScreenshotPath === undefined ? {} : { generatedScreenshotPath: prepared.generatedScreenshotPath }),
    outputTruncated: result.stdout.length > MAX_BROWSER_OUTPUT_CHARACTERS
      || result.stderr.length > MAX_BROWSER_OUTPUT_CHARACTERS,
  };
}

export async function runBrowserSkill(
  runtime: AgentRuntime,
  invocation: AgentBrowserInvocation,
  skill: string,
  full: boolean,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<BrowserCliResult> {
  const args = ['skills', 'get', skill, ...(full ? ['--full'] : [])];
  let result: ExecResult;
  try {
    const configPath = await writeIsolatedBrowserConfig(runtime);
    result = await runtime.exec(invocation.command, [
      ...args,
      '--max-output',
      String(MAX_BROWSER_SKILL_OUTPUT_CHARACTERS),
      '--config',
      configPath,
    ], {
      cwd: runtime.cwd,
      timeout: normalizeTimeout(timeoutMs),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    return {
      stdout: '',
      stderr: errorMessage(error),
      code: 1,
      killed: false,
      outputTruncated: false,
    };
  }
  return {
    stdout: boundOutput(result.stdout, MAX_BROWSER_SKILL_OUTPUT_CHARACTERS),
    stderr: boundOutput(result.stderr, MAX_BROWSER_SKILL_OUTPUT_CHARACTERS),
    code: result.code,
    killed: result.killed,
    outputTruncated: result.stdout.length > MAX_BROWSER_SKILL_OUTPUT_CHARACTERS
      || result.stderr.length > MAX_BROWSER_SKILL_OUTPUT_CHARACTERS,
  };
}

export function findBrowserCommand(args: readonly string[]): string | undefined {
  const first = args[0]?.trim();
  return !first || first.startsWith('-') ? undefined : first.toLowerCase();
}

function hasPositionalArgument(args: readonly string[]): boolean {
  let consumeValue = false;
  for (const arg of args) {
    if (consumeValue) {
      consumeValue = false;
      continue;
    }
    if (arg === '--') return true;
    if (!arg.startsWith('-')) return true;
    if (!arg.includes('=') && OPTIONS_WITH_VALUES.has(arg)) consumeValue = true;
  }
  return false;
}

async function writeIsolatedBrowserConfig(runtime: AgentRuntime): Promise<string> {
  const storage = runtime.storage('session');
  const relativePath = 'browser/agent-browser.json';
  await storage.mkdir('browser', { recursive: true });
  await storage.writeFile(relativePath, new TextEncoder().encode('{"plugins":[]}\n'));
  return joinRuntimePath(storage.root, relativePath);
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_BROWSER_TIMEOUT_MS;
  return Math.min(MAX_BROWSER_TIMEOUT_MS, Math.max(1_000, Math.floor(value!)));
}

function boundOutput(value: string, maximum = MAX_BROWSER_OUTPUT_CHARACTERS): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, maximum - 40)}\n[truncated by Felan]`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
