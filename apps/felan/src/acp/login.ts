import { emitKeypressEvents, type Key } from 'node:readline';
import { DAEMON_VERSION } from '@felan-ai/daemon';
import { SessionClient, type SessionClientOptions } from '../client/client.js';
import { clientDaemonTarget } from '../client-application.js';
import { resolveClientHostComposition, resolveInstalledDaemonEntrypoint } from '../daemon-entrypoint.js';
import { FELAN_VERSION } from '../version.js';
import { TuiSessionController } from '../tui/controller.js';
import { TerminalSetup } from '../tui/setup.js';
import type { OpenBrowser } from '../tui/browser.js';
import type { TerminalSetupUi } from '../tui/setup-ui.js';
import { sanitizeAcpErrorMessage } from './session-updates.js';

const MAX_INPUT_BYTES = 64 * 1024;
const UNSAFE_INLINE_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export interface AcpLoginChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface AcpLoginTerminal {
  select(message: string, options: readonly AcpLoginChoice[], signal: AbortSignal): Promise<string | undefined>;
  input(message: string, options: { readonly secret: boolean; readonly placeholder?: string }, signal: AbortSignal): Promise<string | undefined>;
  writeLine(message: string): void;
}

export interface AcpLoginSignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface RunLocalFelanAcpLoginOptions {
  readonly agentDir?: string;
  readonly daemonRuntime?: string;
  readonly sessionDir?: string;
  readonly terminal?: AcpLoginTerminal;
  readonly createClient?: (options: SessionClientOptions) => SessionClient;
  readonly writeError?: (message: string) => void;
  readonly signalSource?: AcpLoginSignalSource;
  readonly signal?: AbortSignal;
  readonly terminateProcess?: (exitCode: number) => void;
  readonly openBrowser: OpenBrowser;
}

class AcpLoginCancelledError extends Error {
  constructor() { super('Authentication cancelled'); this.name = 'AcpLoginCancelledError'; }
}

export async function runLocalFelanAcpLogin(options: RunLocalFelanAcpLoginOptions): Promise<number> {
  const terminal = options.terminal ?? new NodeAcpLoginTerminal();
  const writeError = options.writeError ?? ((message: string) => { process.stderr.write(`${message}\n`); });
  const signalSource = options.signalSource ?? process;
  const terminateProcess = options.terminateProcess ?? (options.signalSource === undefined && options.signal === undefined
    ? (exitCode: number) => process.exit(exitCode) : undefined);
  const abort = new AbortController();
  const secrets = new Set<string>();
  const state = { cancelled: false };
  let controller: TuiSessionController | undefined;
  let setup: TerminalSetup | undefined;
  let closing: Promise<void> | undefined;
  let signalExitCode: number | undefined;
  const stopSetup = () => { if (setup) closing ??= setup.dispose(); };
  abort.signal.addEventListener('abort', stopSetup, { once: true });
  const handlers = ([['SIGINT', 130], ['SIGTERM', 143]] as const).map(([signal, code]) => {
    const handler = () => { signalExitCode ??= code; abort.abort(); };
    signalSource.once(signal, handler); return [signal, handler] as const;
  });
  const fromCaller = () => abort.abort(options.signal?.reason);
  if (options.signal?.aborted) fromCaller(); else options.signal?.addEventListener('abort', fromCaller, { once: true });
  try {
    abort.signal.throwIfAborted();
    const target = clientDaemonTarget(options);
    const expectedComposition = options.createClient ? undefined : await resolveClientHostComposition(target);
    const client = (options.createClient ?? (settings => new SessionClient(settings)))({
      target, clientVersion: FELAN_VERSION, expectedDaemonVersion: DAEMON_VERSION, ...(expectedComposition ? { expectedComposition } : {}),
      kind: 'tui', interactionKinds: [], launch: { entrypoint: resolveInstalledDaemonEntrypoint() },
    });
    controller = new TuiSessionController(client);
    await waitForCancellation(client.connect(), abort.signal);
    abort.signal.throwIfAborted();
    setup = new TerminalSetup(controller, nodeSetupUi(terminal, abort.signal, secrets, state), options.openBrowser);
    const completed = await setup.login();
    if (abort.signal.aborted || state.cancelled && !completed) throw new AcpLoginCancelledError();
    if (!completed) {
      writeError(`Authentication failed: ${safeMessage(controller.notice || 'The daemon could not complete authentication.', secrets)}`);
      return 1;
    }
    terminal.writeLine('Authentication saved by the daemon.');
    return 0;
  } catch (error) {
    if (abort.signal.aborted || error instanceof AcpLoginCancelledError) {
      if (signalExitCode === undefined) terminal.writeLine('Authentication cancelled.');
      return signalExitCode ?? 1;
    }
    writeError(`Authentication failed: ${safeMessage(error, secrets)}`);
    return 1;
  } finally {
    abort.signal.removeEventListener('abort', stopSetup);
    try { await (closing ?? setup?.dispose()); }
    finally {
      await controller?.dispose();
      options.signal?.removeEventListener('abort', fromCaller);
      for (const [signal, handler] of handlers) signalSource.off(signal, handler);
      secrets.clear();
      if (abort.signal.aborted && terminateProcess) setImmediate(() => terminateProcess(signalExitCode ?? 1));
    }
  }
}

function nodeSetupUi(terminal: AcpLoginTerminal, lifetime: AbortSignal, secrets: Set<string>, state: { cancelled: boolean }): TerminalSetupUi {
  const select: TerminalSetupUi['select'] = async (message, choices, options) => {
    const signal = options?.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
    const result = await promptResult(terminal.select(safePromptMessage(message, secrets), choices.map(choice => ({
      id: choice.value, label: safePromptSingleLine(choice.label, secrets),
      ...(choice.description ? { description: safePromptSingleLine(choice.description, secrets) } : {}),
    })), signal), signal);
    if (!signal.aborted && result === undefined) state.cancelled = true;
    return result;
  };
  const ui: TerminalSetupUi = {
    isIdle: () => true,
    select,
    providers: (title, choices, _initialSearch, signal) => select(title, choices, { signal }),
    login: async (job, provider, signal) => {
      terminal.writeLine(safePromptMessage(`Login to ${provider}`, secrets));
      for (const link of job.links ?? []) terminal.writeLine(safePromptMessage(`${link.url}\n${link.label}`, secrets));
      const prompt = job.state === 'waiting' ? job.prompt : undefined;
      if (prompt) {
        terminal.writeLine(safePromptMessage(job.message, secrets));
        return prompt.kind === 'select'
          ? ui.select(prompt.message, prompt.choices.map(choice => ({ value: choice.id, label: choice.label,
            ...(choice.description ? { description: choice.description } : {}) })), { signal })
          : ui.input(prompt.message, '', { signal, secret: prompt.secret, ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}) });
      }
      await ui.progress({ ...job, links: [] }, signal);
      return undefined;
    },
    input: async (message, _initial, options) => {
      const signal = options?.signal ? AbortSignal.any([lifetime, options.signal]) : lifetime;
      const result = await promptResult(terminal.input(safePromptMessage(message, secrets), {
        secret: options?.secret ?? false,
        ...(options?.placeholder ? { placeholder: safePromptSingleLine(options.placeholder, secrets) } : {}),
      }, signal), signal);
      if (result === undefined) { if (!signal.aborted) state.cancelled = true; return undefined; }
      if (Buffer.byteLength(result) > MAX_INPUT_BYTES) throw new Error('Terminal input exceeds the maximum size');
      if (result) secrets.add(result);
      return result;
    },
    confirm: async (title, message, options) => {
      const selected = await select(`${title}\n${message}`, [{ value: 'no', label: 'No' }, { value: 'yes', label: 'Yes' }], options);
      if (selected !== 'yes' && !options?.signal?.aborted && !lifetime.aborted) state.cancelled = true;
      return selected === 'yes';
    },
    checklist: async () => undefined,
    progress: async (job, signal) => {
      terminal.writeLine(safePromptMessage(job.message || 'Waiting for daemon authentication…', secrets));
      if (job.links?.length) {
        const selected = await select('Authorization is in progress.', [
          { value: 'links', label: 'Open an authorization link through the daemon' },
          { value: 'wait', label: 'Keep waiting (Ctrl+C cancels)' },
          { value: 'cancel', label: 'Cancel authentication' },
        ], { signal });
        if (selected === 'links') return 'links';
        if (selected !== 'wait') { if (!signal.aborted) state.cancelled = true; return undefined; }
      }
      return new Promise<undefined>(resolve => {
        if (signal.aborted || lifetime.aborted) { resolve(undefined); return; }
        const combined = AbortSignal.any([signal, lifetime]);
        combined.addEventListener('abort', () => resolve(undefined), { once: true });
      });
    },
  };
  return ui;
}

async function promptResult<T>(operation: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  try { return await waitForCancellation(operation, signal); }
  catch (error) { if (signal.aborted) return undefined; throw error; }
}

async function waitForCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => {}); throw new AcpLoginCancelledError(); }
  let listener!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new AcpLoginCancelledError());
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) listener();
  });
  try { return await Promise.race([operation, cancelled]); }
  finally { signal.removeEventListener('abort', listener); }
}

function safeMessage(value: unknown, secrets: ReadonlySet<string>): string {
  let message: string;
  try {
    message = value instanceof Error ? value.message : String(value);
  } catch {
    message = 'Operation failed';
  }
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[REDACTED_SECRET]');
  }
  message = truncateUtf8(message, MAX_INPUT_BYTES);
  return sanitizeAcpErrorMessage(message);
}

function safePromptMessage(value: string, secrets: ReadonlySet<string>): string {
  let message = value;
  for (const secret of secrets) {
    if (secret) message = message.replaceAll(secret, '[REDACTED_SECRET]');
  }
  message = truncateUtf8(message, MAX_INPUT_BYTES)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu, '[REDACTED_PRIVATE_KEY]')
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*$/gu, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gu, '[REDACTED_TOKEN]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[REDACTED_TOKEN]')
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|client[-_ ]?secret)\s*[:=]\s*)[^\s]+/giu, '$1[REDACTED_SECRET]')
    .replace(/([?&](?:access_token|api_key|client_secret|password|refresh_token|token)=)[^&#\s]*/giu, '$1[REDACTED_SECRET]')
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
  return truncateUtf8(message, MAX_INPUT_BYTES);
}

function safePromptSingleLine(value: string, secrets: ReadonlySet<string>): string {
  return safePromptMessage(value, secrets).replace(/\s+/gu, ' ').trim() || 'Unnamed';
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  return Buffer.from(value, 'utf8')
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/�$/u, '');
}

export class NodeAcpLoginTerminal implements AcpLoginTerminal {
  readonly #input: NodeJS.ReadStream;
  readonly #output: NodeJS.WriteStream;

  constructor(
    input: NodeJS.ReadStream = process.stdin,
    output: NodeJS.WriteStream = process.stdout,
  ) {
    this.#input = input;
    this.#output = output;
  }

  async select(
    message: string,
    options: readonly AcpLoginChoice[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    this.writeLine(message);
    options.forEach((option, index) => {
      const description = option.description ? ` — ${option.description}` : '';
      this.writeLine(`  ${index + 1}. ${option.label}${description}`);
    });
    while (!signal.aborted) {
      const answer = await this.#readVisibleLine('Selection (Enter to cancel): ', signal);
      if (answer === undefined || answer.trim() === '') return undefined;
      const index = Number(answer.trim());
      if (Number.isSafeInteger(index) && index >= 1 && index <= options.length) {
        return options[index - 1]?.id;
      }
      this.writeLine('Enter one of the listed numbers.');
    }
    return undefined;
  }

  input(
    message: string,
    options: { readonly secret: boolean; readonly placeholder?: string },
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const placeholder = options.placeholder ? ` (${options.placeholder})` : '';
    const prompt = `${message}${placeholder}: `;
    return options.secret
      ? this.#readSecretLine(prompt, signal)
      : this.#readVisibleLine(prompt, signal);
  }

  writeLine(message: string): void {
    this.#output.write(`${message}\n`);
  }

  async #readVisibleLine(prompt: string, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) return undefined;
    this.#output.write(prompt);
    this.#input.resume();
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (value: string | undefined, error?: Error) => {
        if (settled) return;
        settled = true;
        this.#input.off('data', onData);
        this.#input.off('end', onEnd);
        this.#input.off('close', onClose);
        this.#input.off('error', onError);
        signal.removeEventListener('abort', onAbort);
        this.#input.pause();
        if (this.#input.isTTY !== true) this.#output.write('\n');
        if (error) reject(error);
        else resolve(value);
      };
      const onAbort = () => finish(undefined);
      const onEnd = () => finish(undefined);
      const onClose = () => finish(undefined);
      const onError = (error: Error) => finish(undefined, error);
      const onData = (chunk: Buffer | string) => {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        const lineFeed = bytes.indexOf(10);
        let content = lineFeed < 0 ? bytes : bytes.subarray(0, lineFeed);
        if (lineFeed >= 0 && content.at(-1) === 13) content = content.subarray(0, -1);
        if (size + content.byteLength > MAX_INPUT_BYTES) {
          finish(undefined, new Error('Terminal input exceeds the maximum size'));
          return;
        }
        if (content.byteLength > 0) {
          chunks.push(content);
          size += content.byteLength;
        }
        if (lineFeed < 0) return;
        const remainder = bytes.subarray(lineFeed + 1);
        if (remainder.byteLength > MAX_INPUT_BYTES) {
          finish(undefined, new Error('Queued terminal input exceeds the maximum size'));
          return;
        }
        try {
          const buffered = Buffer.concat(chunks, size);
          const line = buffered.at(-1) === 13 ? buffered.subarray(0, -1) : buffered;
          const value = new TextDecoder('utf-8', { fatal: true }).decode(line);
          finish(value);
          if (remainder.byteLength > 0) this.#input.unshift(remainder);
        } catch {
          finish(undefined, new Error('Terminal input is not valid UTF-8'));
        }
      };
      this.#input.on('data', onData);
      this.#input.once('end', onEnd);
      this.#input.once('close', onClose);
      this.#input.once('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  #readSecretLine(prompt: string, signal: AbortSignal): Promise<string | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    if (!this.#input.isTTY || typeof this.#input.setRawMode !== 'function') {
      return Promise.reject(new Error('Secret input requires an interactive terminal'));
    }
    this.#output.write(prompt);
    const wasRaw = this.#input.isRaw === true;
    emitKeypressEvents(this.#input);
    this.#input.setRawMode(true);
    this.#input.resume();

    return new Promise((resolve, reject) => {
      let value = '';
      let settled = false;
      const finish = (result: string | undefined, error?: Error) => {
        if (settled) return;
        settled = true;
        this.#input.off('keypress', onKeypress);
        this.#input.off('end', onEnd);
        this.#input.off('close', onClose);
        this.#input.off('error', onError);
        signal.removeEventListener('abort', onAbort);
        try {
          this.#input.setRawMode?.(wasRaw);
        } catch {}
        this.#input.pause();
        this.#output.write('\n');
        if (error) reject(error);
        else resolve(result);
      };
      const onAbort = () => finish(undefined);
      const onEnd = () => finish(undefined);
      const onClose = () => finish(undefined);
      const onError = () => finish(undefined);
      const onKeypress = (text: string | undefined, key: Key = {}) => {
        if (key.name === 'return' || key.name === 'enter') {
          finish(value);
          return;
        }
        if (
          key.name === 'escape'
          || (key.ctrl === true && (key.name === 'c' || key.name === 'd'))
        ) {
          finish(undefined);
          return;
        }
        if (key.name === 'backspace') {
          value = [...value].slice(0, -1).join('');
          return;
        }
        if (!text || key.ctrl === true || key.meta === true || UNSAFE_INLINE_CHARACTERS.test(text)) {
          return;
        }
        if (Buffer.byteLength(value) + Buffer.byteLength(text) > MAX_INPUT_BYTES) {
          finish(undefined, new Error('Terminal input exceeds the maximum size'));
          return;
        }
        value += text;
      };
      this.#input.on('keypress', onKeypress);
      this.#input.once('end', onEnd);
      this.#input.once('close', onClose);
      this.#input.once('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }
}
