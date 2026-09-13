import {
  associateExtensionConfig,
  type AgentToolResult,
  type FelanExtension,
  type FelanToolInvocationResult,
} from '@felan-ai/agent-core';
import { stripTerminalSequences, Text } from '@earendil-works/pi-tui';
import { getHostFunctionContext, run } from 'run';
import { Type, type Static } from 'typebox';
import { configuredRunToolNames, RUN_CONFIG } from './config.js';

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_TOOL_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_ENTRIES = 256;
const MAX_AUDIT_BYTES = 64 * 1024;
const MAX_AUDIT_SUMMARY_BYTES = 2 * 1024;
const MAX_AUDIT_NAME_BYTES = 128;
const MAX_AUDIT_ID_BYTES = 256;
const MAX_TERMINATION_ERROR_BYTES = 4 * 1024;
const MAX_TOOL_CONTENT_BLOCKS = 1024;
const MAX_TOOL_NAMES = 100;
const MAX_CATALOG_BYTES = 64 * 1024;
const NODE_TYPE_STRIP_WARNING = 'stripTypeScriptTypes is an experimental feature and might change at any time';
const INLINE_CONTROL_CHARACTERS = /[\u0000-\u001F\u007F-\u009F]/gu;
const SENSITIVE_AUDIT_KEY = /credential|secret|token|password|passwd|cookie|authorization|privatekey|apikey|accesskey/iu;

const RunCodeParameters = Type.Object({
  title: Type.String({
    minLength: 1,
    maxLength: 120,
    description: 'Short description of the overall operation, for example "Inspect extension wiring".',
  }),
  source: Type.String({
    minLength: 1,
    maxLength: MAX_SOURCE_BYTES,
    description: 'JavaScript or type-stripped TypeScript function body. Top-level await and return are supported.',
  }),
}, { additionalProperties: false });

type RunCodeParameters = Static<typeof RunCodeParameters>;

interface AuditCall {
  name: string;
  toolCallId?: string;
  arguments: string;
  isError: boolean;
  terminate: boolean;
  outcome: string;
}

interface AuditDetails {
  calls: AuditCall[];
  callsTruncated: boolean;
}

const runExtension: FelanExtension = (pi) => {
  const configuredNames = configuredRunToolNames(pi.config?.toolNames);
  const pendingResults = new Map<string, { details?: AuditDetails; isError?: true }>();
  let available = new Map<string, { description: string; parameters: unknown }>();
  let availableFingerprint = '';

  const refresh = (): void => {
    const active = new Set(pi.getActiveTools());
    const next = new Map<string, { description: string; parameters: unknown }>();
    for (const tool of pi.getAllTools()) {
      if (!active.has(tool.name) || !configuredNames.includes(tool.name)) continue;
      if (isForbidden(tool.name)) continue;
      next.set(tool.name, { description: tool.description, parameters: tool.parameters });
    }
    const fingerprint = JSON.stringify([...next].map(([name, tool]) => [name, tool.description, tool.parameters]));
    if (fingerprint !== availableFingerprint) {
      available = next;
      availableFingerprint = fingerprint;
    }
  };

  const execute = async (
    toolCallId: string,
    params: RunCodeParameters,
    signal?: AbortSignal,
  ): Promise<AgentToolResult<unknown>> => {
    refresh();
    if (!pi.toolInvoker) throw new Error('Code mode requires Agent Core session composition');
    const audit = new RunAudit();
    const terminationController = new AbortController();
    const runSignal = signal
      ? AbortSignal.any([signal, terminationController.signal])
      : terminationController.signal;
    let termination: FelanToolInvocationResult | undefined;
    const exposed = [...available.entries()].slice(0, MAX_TOOL_NAMES);
    const hostTools = Object.fromEntries(exposed.map(([name]) => [
      name,
      async (input: unknown): Promise<string> => {
        runSignal.throwIfAborted();
        const context = getHostFunctionContext();
        const call = audit.start(name, input);
        let outcome: FelanToolInvocationResult | undefined;
        try {
          outcome = await pi.toolInvoker!.invoke(name, input, { signal: context.abortSignal });
          if (outcome.terminate) {
            const safeTermination = boundedTermination(outcome);
            audit.finish(call, safeTermination);
            termination ??= safeTermination;
            terminationController.abort();
            return '';
          }
          const text = nestedToolText(outcome);
          audit.finish(call, outcome);
          return text;
        } catch (error) {
          audit.finish(call, outcome, error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    ]));

    try {
      const result = await runWithoutNodeTypeStripWarning({
        source: params.source,
        hostFunctions: { tools: hostTools },
        abortSignal: runSignal,
        limits: {
          timeoutMs: 30_000,
          memoryLimitBytes: 64 * 1024 * 1024,
          maxStackSizeBytes: 2 * 1024 * 1024,
          maxSourceBytes: MAX_SOURCE_BYTES,
          maxResultBytes: MAX_RESULT_BYTES,
          maxConsoleOutputBytes: 64 * 1024,
          maxHostFunctionArgumentsBytes: 1024 * 1024,
          maxHostFunctionOutputBytes: MAX_TOOL_TEXT_BYTES,
          maxBridgeRequests: 256,
          maxInFlightBridgeRequests: 32,
        },
      }).catch((error: unknown) => {
        if (!termination) throw error;
        return undefined;
      });
      if (termination) {
        if (termination.isError) pendingResults.set(toolCallId, { isError: true });
        return { content: termination.content, terminate: true, details: audit.close() };
      }
      if (result?.status !== 'completed') {
        throw new Error('Code mode interruptions are not supported in this release');
      }
      const text = result.value === undefined ? 'undefined' : JSON.stringify(result.value);
      if (Buffer.byteLength(text, 'utf8') > MAX_RESULT_BYTES) {
        throw new Error('Code mode result exceeded its output limit');
      }
      return { content: [{ type: 'text', text }], details: audit.close() };
    } catch (error) {
      pendingResults.set(toolCallId, { details: audit.close() });
      throw error;
    }
  };

  const registerTool = (): void => {
    const catalogLines: string[] = [];
    let catalogBytes = 0;
    for (const [name, tool] of [...available.entries()].slice(0, MAX_TOOL_NAMES)) {
      const line = `- tools.${name}(input): ${tool.description}\n  schema: ${JSON.stringify(tool.parameters)}`;
      const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
      if (catalogBytes + lineBytes > MAX_CATALOG_BYTES) break;
      catalogLines.push(line);
      catalogBytes += lineBytes;
    }
    const catalog = catalogLines.join('\n');
    pi.registerTool({
      name: 'run_code',
      label: 'Run Code',
      description: [
        'Execute bounded JavaScript or type-stripped TypeScript in an isolated QuickJS worker and compose eligible active Felan tools through tools.<name>(input).',
        'Generated code has no filesystem, process, module, environment, or network access. Return a JSON-serializable value.',
        catalog.length === 0 ? 'No nested tools are currently active.' : `Available nested tools:\n${catalog}`,
      ].join('\n\n'),
      promptSnippet: 'Compose multiple bounded tools in one sandboxed program',
      promptGuidelines: [
        'Set title to a concise action phrase describing the overall operation.',
        'Use tools.<name>(input) for the exact tool names listed in this description.',
        'Use Promise.all for independent calls and return only the data needed for the answer.',
        'Nested tools are bounded and text-only; run_code cannot call itself or control planning/lifecycle state.',
      ],
      parameters: RunCodeParameters,
      executionMode: 'sequential',
      execute,
      renderCall(params, theme) {
        return new Text(theme.fg('toolTitle', theme.bold(runCallTitle(params.title))), 0, 0);
      },
    });
  };

  pi.on('session_start', () => {
    pendingResults.clear();
    refresh();
    registerTool();
  });
  pi.on('before_agent_start', () => {
    refresh();
    registerTool();
  });
  pi.on('session_shutdown', () => pendingResults.clear());
  pi.on('tool_result', (event) => {
    if (event.toolName !== 'run_code') return undefined;
    const patch = pendingResults.get(event.toolCallId);
    pendingResults.delete(event.toolCallId);
    return patch;
  });
  registerTool();
};

associateExtensionConfig(runExtension, RUN_CONFIG);

class RunAudit {
  readonly #details: AuditDetails = { calls: [], callsTruncated: false };
  readonly #pending = new Set<AuditCall>();
  #closed = false;

  start(name: string, input: unknown): AuditCall | undefined {
    if (this.#closed) return undefined;
    if (this.#details.calls.length >= MAX_AUDIT_ENTRIES) {
      this.#details.callsTruncated = true;
      return undefined;
    }
    let args: string;
    try {
      args = JSON.stringify(this.#sanitize(input)) ?? 'undefined';
    } catch {
      args = '[Unserializable arguments]';
      this.#details.callsTruncated = true;
    }
    const call: AuditCall = {
      name: this.#bound(name, MAX_AUDIT_NAME_BYTES),
      arguments: this.#bound(args, MAX_AUDIT_SUMMARY_BYTES),
      isError: false,
      terminate: false,
      outcome: 'Call started; outcome not yet observed',
    };
    this.#details.calls.push(call);
    this.#pending.add(call);
    this.#enforceBytes();
    return call;
  }

  finish(call: AuditCall | undefined, outcome?: FelanToolInvocationResult, error?: string): void {
    if (!call || !this.#pending.delete(call)) return;
    if (outcome) call.toolCallId = this.#bound(outcome.toolCallId, MAX_AUDIT_ID_BYTES);
    call.isError = error !== undefined || outcome?.isError === true;
    call.terminate = outcome?.terminate === true;
    const summary = error ?? (outcome?.content ?? []).map((content) => (
      content.type === 'text' ? content.text : `[Non-text content: ${content.type}]`
    )).join('\n');
    call.outcome = this.#bound(summary, MAX_AUDIT_SUMMARY_BYTES);
    this.#enforceBytes();
  }

  close(): AuditDetails {
    this.#closed = true;
    for (const call of this.#pending) {
      call.isError = true;
      call.outcome = 'Outcome unavailable: code mode ended before this call settled';
      this.#details.callsTruncated = true;
    }
    this.#pending.clear();
    this.#enforceBytes();
    return this.#details;
  }

  #sanitize(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') return sanitizeAuditText(value);
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'undefined') return '[Undefined]';
    if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
    if (typeof value === 'number' && Object.is(value, -0)) return '-0';
    if (value === null || typeof value !== 'object') return value;
    if (depth >= 16) {
      this.#details.callsTruncated = true;
      return '[Depth limit]';
    }
    if (value instanceof Date) return `[Date ${Number.isNaN(value.getTime()) ? 'Invalid' : value.toISOString()}]`;
    if (value instanceof RegExp) return `[RegExp ${String(value)}]`;
    if (value instanceof Map) {
      this.#details.callsTruncated = true;
      return `[Map with ${value.size} entries]`;
    }
    if (value instanceof Set) {
      this.#details.callsTruncated = true;
      return `[Set with ${value.size} values]`;
    }
    if (value instanceof ArrayBuffer) {
      this.#details.callsTruncated = value.byteLength > 0 || this.#details.callsTruncated;
      return `[ArrayBuffer with ${value.byteLength} bytes]`;
    }
    if (ArrayBuffer.isView(value)) {
      this.#details.callsTruncated = value.byteLength > 0 || this.#details.callsTruncated;
      return `[${value.constructor.name} with ${value.byteLength} bytes]`;
    }
    if (value instanceof Error) {
      this.#details.callsTruncated = true;
      return `[${sanitizeAuditText(value.name)}: ${sanitizeAuditText(value.message)}]`;
    }
    if (Array.isArray(value)) return value.map((item) => this.#sanitize(item, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      this.#details.callsTruncated = true;
      const name = typeof value.constructor?.name === 'string' ? value.constructor.name : 'Object';
      return `[${sanitizeAuditText(name)}]`;
    }
    const keys = new Set<string>();
    const entries: Array<[string, unknown]> = [];
    for (const [key, item] of Object.entries(value)) {
      const safeKey = sanitizeAuditText(key);
      if (keys.has(safeKey)) {
        this.#details.callsTruncated = true;
        continue;
      }
      keys.add(safeKey);
      entries.push([safeKey, SENSITIVE_AUDIT_KEY.test(safeKey.replace(/[^a-z]/giu, ''))
        ? '[REDACTED]'
        : this.#sanitize(item, depth + 1)]);
    }
    return Object.fromEntries(entries);
  }

  #bound(value: string, maxBytes: number): string {
    const text = sanitizeAuditText(value);
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
    this.#details.callsTruncated = true;
    const marker = '[Truncated]';
    return Buffer.from(text, 'utf8').subarray(0, maxBytes - marker.length)
      .toString('utf8').replace(/\uFFFD$/u, '') + marker;
  }

  #enforceBytes(): void {
    while (Buffer.byteLength(JSON.stringify(this.#details), 'utf8') > MAX_AUDIT_BYTES) {
      const dropped = this.#details.calls.pop();
      if (dropped) this.#pending.delete(dropped);
      this.#details.callsTruncated = true;
    }
  }
}

function sanitizeAuditText(value: string): string {
  return stripTerminalSequences(value).replace(INLINE_CONTROL_CHARACTERS, ' ');
}

function nestedToolText(outcome: FelanToolInvocationResult): string {
  if (outcome.isError) throw new Error(firstText(outcome) || 'Nested tool failed');
  return boundedTextContent(outcome).map((content) => content.text).join('\n');
}

function boundedTermination(outcome: FelanToolInvocationResult): FelanToolInvocationResult {
  try {
    return { ...outcome, content: boundedTextContent(outcome, MAX_RESULT_BYTES) };
  } catch (error) {
    return {
      ...outcome,
      content: [{ type: 'text', text: boundedTerminationError(error) }],
      isError: true,
    };
  }
}

function boundedTextContent(
  outcome: FelanToolInvocationResult,
  maxBytes = MAX_TOOL_TEXT_BYTES,
): Array<{ type: 'text'; text: string }> {
  if (!Array.isArray(outcome.content)) throw new Error('Nested tool returned invalid content');
  const textContent: Array<{ type: 'text'; text: string }> = [];
  let serializedBytes = 2;
  for (const content of outcome.content) {
    if (textContent.length >= MAX_TOOL_CONTENT_BLOCKS) {
      throw new Error('Nested tool returned too many content blocks');
    }
    if (typeof content !== 'object' || content === null) {
      throw new Error('Nested tool returned invalid content');
    }
    if (content.type !== 'text') throw new Error('Nested tool returned non-text content');
    if (typeof content.text !== 'string') throw new Error('Nested tool returned invalid text content');
    const normalized = { type: 'text' as const, text: content.text };
    const encoded = JSON.stringify(normalized);
    serializedBytes += Buffer.byteLength(encoded, 'utf8') + (textContent.length > 0 ? 1 : 0);
    if (serializedBytes > maxBytes) {
      throw new Error('Nested tool output exceeded its code-mode limit');
    }
    textContent.push(normalized);
  }
  return textContent;
}

function boundedTerminationError(error: unknown): string {
  let message = 'Nested tool returned invalid termination content';
  try {
    if (error instanceof Error && typeof error.message === 'string') message = error.message;
    else if (typeof error === 'string') message = error;
  } catch {
    return message;
  }
  const safe = sanitizeAuditText(message);
  if (Buffer.byteLength(safe, 'utf8') <= MAX_TERMINATION_ERROR_BYTES) return safe;
  const marker = '[Truncated]';
  return Buffer.from(safe, 'utf8').subarray(0, MAX_TERMINATION_ERROR_BYTES - marker.length)
    .toString('utf8').replace(/\uFFFD$/u, '') + marker;
}

function firstText(outcome: FelanToolInvocationResult): string | undefined {
  if (!Array.isArray(outcome.content)) return undefined;
  for (const content of outcome.content) {
    if (content?.type === 'text' && typeof content.text === 'string') return content.text;
  }
  return undefined;
}

function isForbidden(name: string): boolean {
  return name === 'run_code'
    || name === 'enter_prewalk'
    || name === 'exit_plan_mode'
    || name === 'enter_plan_mode';
}

function runCallTitle(value: unknown): string {
  if (typeof value !== 'string') return 'Run Code';
  const title = stripTerminalSequences(value)
    .replace(INLINE_CONTROL_CHARACTERS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return title.length > 0 ? `Run Code - ${title}` : 'Run Code';
}

function runWithoutNodeTypeStripWarning(input: Parameters<typeof run>[0]): ReturnType<typeof run> {
  const originalEmitWarning = process.emitWarning;
  const filteredEmitWarning = ((warning: string | Error, ...args: unknown[]): void => {
    if (warning === NODE_TYPE_STRIP_WARNING && args[0] === 'ExperimentalWarning') return;
    Reflect.apply(originalEmitWarning, process, [warning, ...args]);
  }) as typeof process.emitWarning;

  // Node 22 emits this once while Run synchronously transforms the guest source,
  // writing across the fullscreen TUI. Keep every other process warning visible.
  process.emitWarning = filteredEmitWarning;
  try {
    return run(input);
  } finally {
    if (process.emitWarning === filteredEmitWarning) process.emitWarning = originalEmitWarning;
  }
}

export { RUN_CONFIG } from './config.js';
export { DEFAULT_RUN_TOOL_NAMES } from './config.js';
export default runExtension;
