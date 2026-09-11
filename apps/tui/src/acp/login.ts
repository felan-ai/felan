import {
  emitKeypressEvents,
  type Key,
} from 'node:readline';
import {
  type ModelRuntime,
} from '@felan-ai/agent-core';
import {
  createLocalModelRuntime,
  getLocalAgentDir,
} from '../runtime.js';
import { sanitizeAcpErrorMessage } from './session-updates.js';

const MAX_AUTH_METHODS = 128;
const MAX_AUTH_INTERACTIONS = 128;
const MAX_INFO_LINKS = 32;
const MAX_PROMPT_OPTIONS = 128;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_URL_BYTES = 16 * 1024;
const UNSAFE_INLINE_CHARACTERS = /[\u0000-\u001f\u007f]/u;

type AuthType = Parameters<ModelRuntime['login']>[1];
type AuthInteraction = Parameters<ModelRuntime['login']>[2];
type AuthPrompt = Parameters<AuthInteraction['prompt']>[0];
type AuthEvent = Parameters<AuthInteraction['notify']>[0];

export interface AcpLoginChoice {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface AcpLoginTerminal {
  select(
    message: string,
    options: readonly AcpLoginChoice[],
    signal: AbortSignal,
  ): Promise<string | undefined>;
  input(
    message: string,
    options: { readonly secret: boolean; readonly placeholder?: string },
    signal: AbortSignal,
  ): Promise<string | undefined>;
  writeLine(message: string): void;
}

export interface AcpLoginSignalSource {
  once(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export interface RunLocalFelanAcpLoginOptions {
  readonly agentDir?: string;
  readonly terminal?: AcpLoginTerminal;
  readonly createModelRuntime?: (
    agentDir: string,
    signal: AbortSignal,
  ) => Promise<ModelRuntime>;
  readonly writeError?: (message: string) => void;
  readonly signalSource?: AcpLoginSignalSource;
  readonly signal?: AbortSignal;
  readonly terminateProcess?: (exitCode: number) => void;
}

interface LoginMethod {
  readonly id: string;
  readonly providerId: string;
  readonly providerName: string;
  readonly authType: AuthType;
  readonly label: string;
  readonly description: string;
}

interface AuthInteractionBudget {
  remaining: number;
  cancel(): void;
}

class AcpLoginCancelledError extends Error {
  constructor() {
    super('Authentication cancelled');
    this.name = 'AcpLoginCancelledError';
  }
}

export async function runLocalFelanAcpLogin(
  options: RunLocalFelanAcpLoginOptions = {},
): Promise<number> {
  const terminal = options.terminal ?? new NodeAcpLoginTerminal();
  const writeError = options.writeError
    ?? ((message: string) => { process.stderr.write(`${message}\n`); });
  const createRuntime = options.createModelRuntime
    ?? ((agentDir: string, signal: AbortSignal) => createLocalModelRuntime(agentDir, signal));
  const signalSource = options.signalSource ?? process;
  const terminateProcess = options.terminateProcess ?? (
    options.signalSource === undefined && options.signal === undefined
      ? (exitCode: number) => process.exit(exitCode)
      : undefined
  );
  const controller = new AbortController();
  const secrets = new Set<string>();
  const interactionBudget: AuthInteractionBudget = {
    remaining: MAX_AUTH_INTERACTIONS,
    cancel: () => controller.abort(),
  };
  let interactionActive = true;
  let signalExitCode: number | undefined;
  let forcedExitCode: number | undefined;
  const signalHandlers = ([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const).map(([signal, exitCode]) => {
    const handler = () => {
      signalExitCode ??= exitCode;
      controller.abort();
    };
    signalSource.once(signal, handler);
    return [signal, handler] as const;
  });
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    controller.signal.throwIfAborted();
    const modelRuntime = await waitForCancellation(
      createRuntime(
        options.agentDir ?? getLocalAgentDir(),
        controller.signal,
      ),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const methods = loginMethods(modelRuntime, secrets);
    if (methods.length === 0) {
      writeError('No configurable model-provider authentication methods are available.');
      return 1;
    }
    const selectedId = await waitForCancellation(
      terminal.select(
        'Select a model provider and authentication method:',
        methods.map(({ id, label, description }) => ({ id, label, description })),
        controller.signal,
      ),
      controller.signal,
    );
    if (selectedId === undefined) throw new AcpLoginCancelledError();
    const selected = methods.find(({ id }) => id === selectedId);
    if (selected === undefined) throw new AcpLoginCancelledError();
    controller.signal.throwIfAborted();

    const interaction: AuthInteraction = {
      signal: controller.signal,
      prompt: (prompt) => interactionActive
        ? answerAuthPrompt(
          terminal,
          prompt,
          selected.authType,
          controller.signal,
          secrets,
          () => controller.abort(),
          interactionBudget,
        )
        : Promise.reject(new AcpLoginCancelledError()),
      notify: (event) => {
        if (interactionActive) notifyAuthEvent(terminal, event, secrets, interactionBudget);
      },
    };
    await waitForCancellation(
      modelRuntime.login(selected.providerId, selected.authType, interaction),
      controller.signal,
    );
    controller.signal.throwIfAborted();
    terminal.writeLine(`Authentication saved for ${selected.providerName}.`);
    return 0;
  } catch (error) {
    if (controller.signal.aborted || error instanceof AcpLoginCancelledError) {
      if (signalExitCode === undefined) terminal.writeLine('Authentication cancelled.');
      const exitCode = signalExitCode ?? 1;
      if (controller.signal.aborted) forcedExitCode = exitCode;
      return exitCode;
    }
    writeError(`Authentication failed: ${safeMessage(error, secrets)}`);
    return 1;
  } finally {
    interactionActive = false;
    options.signal?.removeEventListener('abort', abortFromCaller);
    for (const [signal, handler] of signalHandlers) signalSource.off(signal, handler);
    secrets.clear();
    if (forcedExitCode !== undefined && terminateProcess !== undefined) {
      const exitCode = forcedExitCode;
      // This command runs in a dedicated subprocess; a provider may retain handles after ignoring abort.
      setImmediate(() => terminateProcess(exitCode));
    }
  }
}

async function waitForCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AcpLoginCancelledError();
  let abortListener: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(new AcpLoginCancelledError());
    signal.addEventListener('abort', abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
  }
}

async function answerAuthPrompt(
  terminal: AcpLoginTerminal,
  prompt: AuthPrompt,
  authType: AuthType,
  loginSignal: AbortSignal,
  secrets: Set<string>,
  cancelLogin: () => void,
  budget: AuthInteractionBudget,
): Promise<string> {
  consumeAuthInteraction(budget);
  const signal = prompt.signal === undefined
    ? loginSignal
    : AbortSignal.any([loginSignal, prompt.signal]);
  signal.throwIfAborted();
  const message = safePromptMessage(prompt.message, secrets);
  let answer: string | undefined;
  if (prompt.type === 'select') {
    if (
      prompt.options.length === 0
      || prompt.options.length > MAX_PROMPT_OPTIONS
      || new Set(prompt.options.map(({ id }) => id)).size !== prompt.options.length
    ) throw new Error('Authentication provider returned invalid prompt options');
    const choices = prompt.options.map(({ id, label, description }) => ({
      id,
      label: safePromptSingleLine(label, secrets),
      ...(description === undefined
        ? {}
        : { description: safePromptSingleLine(description, secrets) }),
    }));
    answer = await terminal.select(message, choices, signal);
    if (answer !== undefined && !choices.some(({ id }) => id === answer)) answer = undefined;
  } else {
    answer = await terminal.input(
      message,
      {
        secret: authType === 'api_key'
          || prompt.type === 'secret'
          || prompt.type === 'manual_code',
        ...(prompt.placeholder === undefined
          ? {}
          : { placeholder: safePromptSingleLine(prompt.placeholder, secrets) }),
      },
      signal,
    );
  }
  if (answer === undefined || Buffer.byteLength(answer) > MAX_INPUT_BYTES) {
    if (!signal.aborted) cancelLogin();
    throw new AcpLoginCancelledError();
  }
  if (signal.aborted) {
    throw new AcpLoginCancelledError();
  }
  if (prompt.type !== 'select' && answer.length > 0) secrets.add(answer);
  return answer;
}

function notifyAuthEvent(
  terminal: AcpLoginTerminal,
  event: AuthEvent,
  secrets: Set<string>,
  budget: AuthInteractionBudget,
): void {
  consumeAuthInteraction(budget);
  if (event.type === 'auth_url') {
    if (event.instructions) terminal.writeLine(safePromptMessage(event.instructions, secrets));
    terminal.writeLine(authUrlLine('Open this URL to continue', event.url, secrets));
    return;
  }
  if (event.type === 'device_code') {
    terminal.writeLine(authUrlLine('Open this URL to continue', event.verificationUri, secrets));
    const code = safeSingleLine(event.userCode, new Set());
    terminal.writeLine(`Device code: ${code}`);
    if (event.userCode) secrets.add(event.userCode);
    return;
  }
  terminal.writeLine(safePromptMessage(event.message, secrets));
  if (event.type === 'info') {
    for (const link of (event.links ?? []).slice(0, MAX_INFO_LINKS)) {
      const label = link.label === undefined ? 'More information' : safeSingleLine(link.label, secrets);
      terminal.writeLine(authUrlLine(label, link.url, secrets));
    }
  }
}

function consumeAuthInteraction(budget: AuthInteractionBudget): void {
  if (budget.remaining <= 0) {
    budget.cancel();
    throw new Error('Authentication flow exceeded its interaction limit');
  }
  budget.remaining -= 1;
}

function authUrlLine(label: string, value: string, secrets: ReadonlySet<string>): string {
  const safeUrl = displayAuthUrl(value, secrets);
  return safeUrl === undefined
    ? `${label}: [invalid URL omitted]`
    : `${label}: ${safeUrl}`;
}

function displayAuthUrl(value: string, secrets: ReadonlySet<string>): string | undefined {
  if (
    !value
    || Buffer.byteLength(value) > MAX_URL_BYTES
    || UNSAFE_INLINE_CHARACTERS.test(value)
    || [...secrets].some((secret) => (
      secret
      && (value.includes(secret) || value.includes(encodeURIComponent(secret)))
    ))
  ) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
  const sensitiveQueryNames = /^(?:access_token|api_key|client_secret|password|refresh_token|token)$/iu;
  for (const [name, entry] of url.searchParams) {
    if (sensitiveQueryNames.test(name) || [...secrets].some((secret) => secret && entry.includes(secret))) {
      url.searchParams.set(name, '[REDACTED]');
    }
  }
  if (
    /(?:access_token|refresh_token|client_secret|password|token)=/iu.test(url.hash)
    || [...secrets].some((secret) => secret && url.hash.includes(secret))
  ) url.hash = '#[REDACTED]';
  return url.toString();
}

function loginMethods(modelRuntime: ModelRuntime, secrets: ReadonlySet<string>): LoginMethod[] {
  const candidates: Omit<LoginMethod, 'id'>[] = [];
  for (const provider of modelRuntime.getProviders()) {
    const providerName = safeSingleLine(provider.name || provider.id, secrets);
    const providerIdLabel = safeSingleLine(provider.id, secrets);
    const providerLabel = providerName === providerIdLabel
      ? providerName
      : `${providerName} (${providerIdLabel})`;
    if (provider.auth.oauth) {
      const methodName = provider.auth.oauth.loginLabel ?? provider.auth.oauth.name;
      candidates.push({
        providerId: provider.id,
        providerName,
        authType: 'oauth',
        label: `${providerLabel} — ${safeSingleLine(methodName, secrets)}`,
        description: modelRuntime.hasConfiguredAuth(provider.id)
          ? 'OAuth (currently configured)'
          : 'OAuth',
      });
    }
    if (provider.auth.apiKey?.login) {
      candidates.push({
        providerId: provider.id,
        providerName,
        authType: 'api_key',
        label: `${providerLabel} — ${safeSingleLine(provider.auth.apiKey.name, secrets)}`,
        description: modelRuntime.hasConfiguredAuth(provider.id)
          ? 'API key (currently configured)'
          : 'API key',
      });
    }
    if (candidates.length > MAX_AUTH_METHODS) {
      throw new Error('Too many model-provider authentication methods are configured');
    }
  }
  return candidates
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((method, index) => ({ ...method, id: `method-${index + 1}` }));
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

function safeSingleLine(value: string, secrets: ReadonlySet<string>): string {
  return safePromptSingleLine(value, secrets);
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
