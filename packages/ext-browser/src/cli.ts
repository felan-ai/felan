import { createHash, randomUUID } from 'node:crypto';
import type { AgentRuntime, ExecResult } from '@felan-ai/agent-core';
import { joinRuntimePath } from './runtime-path.js';
import type { AgentBrowserInvocation } from './installer.js';
import { inspectScreenshotArguments, validateAttachedBrowserCommand, validateBrowserCommand } from './command-policy.js';

export { findBrowserCommand } from './command-policy.js';

export const MAX_BROWSER_OUTPUT_CHARACTERS = 44_000;
export const MAX_BROWSER_SKILL_OUTPUT_CHARACTERS = 100_000;
export const DEFAULT_BROWSER_TIMEOUT_MS = 60_000;
export const MAX_BROWSER_TIMEOUT_MS = 300_000;
export const BROWSER_IDLE_TIMEOUT = '1h';

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

export function createBrowserAttachmentScope(
  runtime: AgentRuntime,
  sessionId: string,
): BrowserSessionScope {
  const base = createBrowserSessionScope(runtime, sessionId);
  return {
    namespace: base.namespace,
    session: `f-${randomUUID().replaceAll('-', '').slice(0, 16)}`,
  };
}

export function prepareBrowserCommand(
  runtime: AgentRuntime,
  args: readonly string[],
): PreparedBrowserCommand {
  return preparePublicBrowserCommand(runtime, args, true);
}

function preparePublicBrowserCommand(runtime: AgentRuntime, args: readonly string[], stageScreenshot: boolean): PreparedBrowserCommand {
  const command = validateBrowserCommand(args);
  const normalized = [...args];
  if (command !== 'screenshot') return { args: normalized };
  const screenshot = inspectScreenshotArguments(args);
  if (!stageScreenshot || screenshot.path !== undefined) return { args: normalized };

  const screenshotPath = joinRuntimePath(
    runtime.storage('session').root,
    'browser/screenshots',
    `screenshot-${randomUUID()}.${screenshot.format}`,
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
    readonly attached?: boolean;
    readonly attachmentEndpoint?: string;
    readonly internalAttachment?: boolean;
  } = {},
): Promise<BrowserCliResult> {
  const sessionStorage = runtime.storage('session');
  if (!options.internalAttachment && options.attached) validateAttachedBrowserCommand(args);
  const prepared = options.internalAttachment
    ? { args: [...args] }
    : preparePublicBrowserCommand(runtime, args, options.prepareScreenshot !== false);
  const attached = options.attached === true || options.internalAttachment === true;
  const endpoint = options.attachmentEndpoint;
  const localOnly = ['close', 'quit', 'exit'].includes(args[0] ?? '') || (args[0] === 'session' && args[1] === 'info');
  if (attached && !localOnly && !args.includes('--cdp') && !endpoint) throw new Error('Attached commands require their leased endpoint.');
  if (endpoint !== undefined) {
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { throw new Error('Invalid leased endpoint.'); }
    if (!attached || parsed.protocol !== 'ws:' || parsed.hostname !== '127.0.0.1' || Number(parsed.port) < 1
      || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.href !== endpoint
      || !/^\/(?:devtools\/browser(?:\/[A-Za-z0-9._-]+)?|felan-browser\/[A-Za-z0-9._-]+)$/u.test(parsed.pathname)
      || args.includes('--cdp')) {
      throw new Error('Invalid leased endpoint or command.');
    }
  }
  options.signal?.throwIfAborted();
  if (prepared.generatedScreenshotPath) await sessionStorage.mkdir('browser/screenshots', { recursive: true });
  const configPath = await writeBrowserConfig(runtime, attached ? 'attached' : 'isolated', scope);

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
    ...(endpoint === undefined || localOnly ? [] : ['--cdp', endpoint]),
    ...(!attached || (endpoint !== undefined && !localOnly) ? ['--no-webmcp'] : []),
  ];
  let result: ExecResult;
  try {
    options.signal?.throwIfAborted();
    result = await runtime.exec(invocation.command, trustedArgs, {
      cwd: runtime.cwd,
      timeout: timeoutMs,
      maxOutputBytes: MAX_BROWSER_OUTPUT_CHARACTERS * 4,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    const message = errorMessage(error);
    return {
      stdout: '',
      stderr: boundOutput(message),
      code: 1,
      killed: options.signal?.aborted ?? false,
      ...(prepared.generatedScreenshotPath === undefined ? {} : { generatedScreenshotPath: prepared.generatedScreenshotPath }),
      outputTruncated: message.length > MAX_BROWSER_OUTPUT_CHARACTERS,
    };
  }

  return {
    stdout: boundOutput(result.stdout),
    stderr: boundOutput(result.stderr),
    code: result.code,
    killed: result.killed || options.signal?.aborted === true,
    ...(prepared.generatedScreenshotPath === undefined ? {} : { generatedScreenshotPath: prepared.generatedScreenshotPath }),
    outputTruncated: result.truncated === true || result.stdout.length > MAX_BROWSER_OUTPUT_CHARACTERS
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
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(skill)) throw new Error('Invalid browser skill name.');
  signal?.throwIfAborted();
  const args = ['skills', 'get', skill, ...(full ? ['--full'] : [])];
  let result: ExecResult;
  try {
    const configPath = await writeBrowserConfig(runtime, 'skills');
    signal?.throwIfAborted();
    result = await runtime.exec(invocation.command, [
      ...args,
      '--max-output',
      String(MAX_BROWSER_SKILL_OUTPUT_CHARACTERS),
      '--config',
      configPath,
    ], {
      cwd: runtime.cwd,
      timeout: normalizeTimeout(timeoutMs),
      maxOutputBytes: MAX_BROWSER_SKILL_OUTPUT_CHARACTERS * 4,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    const message = errorMessage(error);
    return {
      stdout: '',
      stderr: boundOutput(message, MAX_BROWSER_SKILL_OUTPUT_CHARACTERS),
      code: 1,
      killed: signal?.aborted ?? false,
      outputTruncated: message.length > MAX_BROWSER_SKILL_OUTPUT_CHARACTERS,
    };
  }
  return {
    stdout: boundOutput(result.stdout, MAX_BROWSER_SKILL_OUTPUT_CHARACTERS),
    stderr: boundOutput(result.stderr, MAX_BROWSER_SKILL_OUTPUT_CHARACTERS),
    code: result.code,
    killed: result.killed || signal?.aborted === true,
    outputTruncated: result.truncated === true || result.stdout.length > MAX_BROWSER_SKILL_OUTPUT_CHARACTERS
      || result.stderr.length > MAX_BROWSER_SKILL_OUTPUT_CHARACTERS,
  };
}

async function writeBrowserConfig(runtime: AgentRuntime, mode: 'isolated' | 'attached' | 'skills', scope?: BrowserSessionScope): Promise<string> {
  const storage = runtime.storage('session');
  const scopeHash = scope && createHash('sha256').update(JSON.stringify([scope.namespace, scope.session])).digest('hex').slice(0, 32);
  const directory = `browser/controls/${mode}${scopeHash ? `/${scopeHash}` : ''}`;
  const relativePath = `${directory}/agent-browser.json`;
  const attached = mode === 'attached';
  const config = {
    plugins: [], extensions: [], initScripts: [], enable: [],
    autoConnect: false, profile: null, state: null, restore: null, sessionName: null,
    restoreSave: 'never', restoreCheckUrl: null, restoreCheckText: null, restoreCheckFn: null,
    cdp: null, executablePath: null, provider: null, engine: null, args: null,
    proxy: null, proxyBypass: null, userAgent: null, device: null, headers: null,
    caCert: null, clearCaCert: false, ignoreHttpsErrors: false, allowFileAccess: false,
    headed: false, webgpu: false, debug: false, colorScheme: null, downloadPath: null,
    actionPolicy: null, confirmActions: null, confirmInteractive: false, allowedDomains: null,
    pinTab: attached, noAutoDialog: attached,
    // Cleanup must not request a local launch through noWebmcp without --cdp.
    noWebmcp: !attached,
    screenshotDir: joinRuntimePath(storage.root, 'browser/screenshots'), screenshotFormat: 'png',
  };
  await storage.mkdir(directory, { recursive: true });
  await storage.writeFile(relativePath, new TextEncoder().encode(`${JSON.stringify(config)}\n`));
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
