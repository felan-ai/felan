import {
  redactCredential,
  resolveJevTransport,
  type JevCredentialSources,
  type JevProvider,
} from './credentials.js';

export type JevFetch = (input: URL, init: RequestInit) => Promise<Response>;

export type JevQuestion =
  | { readonly type: 'noul'; readonly instructions: string }
  | { readonly type: 'choice'; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: 'score'; readonly instructions: string; readonly criteria: readonly string[] };

export type JevQuestions = Readonly<Record<string, JevQuestion>>;

export type JevAnswer =
  | { readonly type: 'noul'; readonly noul: number; readonly confidence?: number }
  | {
    readonly type: 'choice';
    readonly choice: string;
    readonly probabilities?: Readonly<Record<string, number>>;
    readonly confidence?: number;
  }
  | {
    readonly type: 'score';
    readonly score: number;
    readonly probabilities?: readonly number[];
    readonly confidence?: number;
  };

export type JevAnswers = Readonly<Record<string, JevAnswer>>;

export interface JevEvaluation {
  readonly provider: 'typesafe' | 'openrouter';
  readonly model: string;
  readonly answers: JevAnswers;
}

export type JevClientFailureCode =
  | 'unavailable'
  | 'invalid_request'
  | 'timeout'
  | 'aborted'
  | 'network_error'
  | 'http_error'
  | 'response_invalid';

export class JevClientError extends Error {
  readonly code: JevClientFailureCode;

  constructor(code: JevClientFailureCode, message: string) {
    super(message);
    this.name = 'JevClientError';
    this.code = code;
  }
}

export interface CreateJevClientOptions extends JevCredentialSources {
  readonly fetch?: JevFetch;
  readonly timeoutMs?: number;
}

export interface JevEvaluateOptions {
  readonly signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_STATE_BYTES = 24 * 1_024;
const MAX_REQUEST_BYTES = 28 * 1_024;
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_QUESTIONS = 64;
const MAX_INSTRUCTIONS_BYTES = 4_096;
const PINNED_HOSTS = new Set(['api.typesafe.ai', 'openrouter.ai']);

export function createJevClient(options: CreateJevClientOptions = {}) {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);

  return {
    resolveTransport(): ReturnType<typeof resolveJevTransport> {
      return resolveTransport(options);
    },
    async evaluate(
      state: unknown,
      questions: JevQuestions,
      evaluateOptions: JevEvaluateOptions = {},
    ): Promise<JevEvaluation> {
      const transport = resolveTransport(options);
      if (!transport) throw new JevClientError('unavailable', 'Jev credentials are unavailable');
      const entries = questionEntries(questions);
      const batches = partitionQuestions(state, entries);
      const answers: Record<string, JevAnswer> = {};
      for (const batch of batches) {
        Object.assign(answers, await requestAnswers(transport, fetcher, timeoutMs, state, batch, evaluateOptions.signal));
      }
      return { provider: transport.provider, model: transport.model, answers };
    },
  };
}

function resolveTransport(options: CreateJevClientOptions) {
  return resolveJevTransport({
    provider: options.provider ?? 'auto',
    ...(options.typesafeApiKey === undefined ? {} : { typesafeApiKey: options.typesafeApiKey }),
    ...(options.openrouterApiKey === undefined ? {} : { openrouterApiKey: options.openrouterApiKey }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
}

async function requestAnswers(
  transport: NonNullable<ReturnType<typeof resolveJevTransport>>,
  fetcher: JevFetch,
  timeoutMs: number,
  state: unknown,
  questions: JevQuestions,
  signal: AbortSignal | undefined,
): Promise<JevAnswers> {
  if (!PINNED_HOSTS.has(transport.url.hostname) || transport.url.protocol !== 'https:') {
    throw new JevClientError('invalid_request', 'Jev endpoint is not pinned');
  }
  const body = JSON.stringify({ model: transport.model, state, questions });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    throw new JevClientError('invalid_request', 'Jev request exceeds the size budget');
  }

  const controller = createTimeout(signal, timeoutMs);
  let response: Response;
  try {
    response = await fetcher(transport.url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${transport.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
      redirect: 'error',
    });
  } catch (error) {
    controller.dispose();
    if (signal?.aborted) throw new JevClientError('aborted', 'Jev request was aborted');
    if (controller.timedOut) throw new JevClientError('timeout', 'Jev request timed out');
    throw new JevClientError('network_error', sanitizeError('Jev request failed before a response', error, transport.apiKey));
  }

  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (error) {
    if (signal?.aborted) throw new JevClientError('aborted', 'Jev request was aborted');
    if (controller.timedOut) throw new JevClientError('timeout', 'Jev request timed out');
    throw new JevClientError('response_invalid', sanitizeError('Jev response could not be read', error, transport.apiKey));
  } finally {
    controller.dispose();
  }

  if (!response.ok) {
    throw new JevClientError(
      'http_error',
      sanitizeError(`Jev request failed (${response.status})`, text.slice(0, 200), transport.apiKey),
    );
  }
  return parseAnswers(text, questions, transport.apiKey);
}

function questionEntries(questions: JevQuestions): Array<readonly [string, JevQuestion]> {
  const entries = Object.entries(questions);
  if (entries.length === 0) throw new JevClientError('invalid_request', 'Jev questions are required');
  if (entries.length > MAX_QUESTIONS) throw new JevClientError('invalid_request', 'Jev question count exceeds the budget');
  for (const [name, question] of entries) {
    if (!name.trim() || name.length > 128) throw new JevClientError('invalid_request', 'Jev question id is invalid');
    validateQuestion(question);
  }
  return entries;
}

function validateQuestion(question: JevQuestion): void {
  if (Buffer.byteLength(question.instructions, 'utf8') === 0
    || Buffer.byteLength(question.instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES) {
    throw new JevClientError('invalid_request', 'Jev question instructions are invalid');
  }
  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    if (options.length < 2 || options.length > 16) throw new JevClientError('invalid_request', 'Jev choice criteria are invalid');
  }
  if (question.type === 'score' && (question.criteria.length < 2 || question.criteria.length > 16)) {
    throw new JevClientError('invalid_request', 'Jev score criteria are invalid');
  }
}

function partitionQuestions(
  state: unknown,
  entries: Array<readonly [string, JevQuestion]>,
): JevQuestions[] {
  const stateBytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
  if (stateBytes === 0 || stateBytes > MAX_STATE_BYTES) {
    throw new JevClientError('invalid_request', 'Jev state exceeds the size budget');
  }
  const overhead = Buffer.byteLength(JSON.stringify({ model: 'x', state, questions: {} }), 'utf8');
  const batches: JevQuestions[] = [];
  let current: Record<string, JevQuestion> = {};
  let currentBytes = overhead;
  for (const [name, question] of entries) {
    const added = Buffer.byteLength(JSON.stringify({ [name]: question }), 'utf8') + 1;
    if (overhead + added > MAX_REQUEST_BYTES) {
      throw new JevClientError('invalid_request', 'Jev question exceeds the size budget');
    }
    if (Object.keys(current).length > 0 && currentBytes + added > MAX_REQUEST_BYTES) {
      batches.push(current);
      current = {};
      currentBytes = overhead;
    }
    current[name] = question;
    currentBytes += added;
  }
  batches.push(current);
  return batches;
}

function parseAnswers(text: string, questions: JevQuestions, apiKey: string): JevAnswers {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new JevClientError('response_invalid', 'Jev returned malformed JSON');
  }
  if (!isRecord(parsed) || !isRecord(parsed.answers)) {
    throw new JevClientError('response_invalid', 'Jev response is missing answers');
  }
  const answers: Record<string, JevAnswer> = {};
  for (const [name, question] of Object.entries(questions)) {
    const raw = parsed.answers[name];
    const answer = parseAnswer(question, raw);
    if (!answer) {
      throw new JevClientError(
        'response_invalid',
        sanitizeError(`Jev answer for ${name} is invalid`, raw, apiKey),
      );
    }
    answers[name] = answer;
  }
  return answers;
}

function parseAnswer(question: JevQuestion, value: unknown): JevAnswer | undefined {
  if (!isRecord(value)) return undefined;
  const confidence = optionalUnit(value.confidence);
  if (question.type === 'noul') {
    const noul = unitNumber(value.noul);
    return noul === undefined ? undefined : {
      type: 'noul',
      noul,
      ...(confidence === undefined ? {} : { confidence }),
    };
  }
  if (question.type === 'choice') {
    if (typeof value.choice !== 'string' || !Object.hasOwn(question.criteria, value.choice)) return undefined;
    return {
      type: 'choice',
      choice: value.choice,
      ...(isStringNumberRecord(value.probabilities) ? { probabilities: value.probabilities } : {}),
      ...(confidence === undefined ? {} : { confidence }),
    };
  }
  const score = finiteNumber(value.score);
  if (score === undefined) return undefined;
  return {
    type: 'score',
    score,
    ...(isNumberArray(value.probabilities) ? { probabilities: value.probabilities } : {}),
    ...(confidence === undefined ? {} : { confidence }),
  };
}

async function readBoundedText(response: Response): Promise<string> {
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > MAX_RESPONSE_BYTES) throw new JevClientError('response_invalid', 'Jev response exceeds the size budget');
  return new TextDecoder().decode(buffer);
}

function createTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (signal?.aborted) controller.abort(signal.reason);
  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    dispose() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new JevClientError('invalid_request', 'Jev timeout is invalid');
  }
  return Math.floor(value);
}

function sanitizeError(prefix: string, detail: unknown, credential: string): string {
  const raw = detail instanceof Error ? detail.message : typeof detail === 'string' ? detail : '';
  const redacted = redactCredential(`${prefix}${raw ? `: ${raw}` : ''}`, credential)
    .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]');
  return redacted.slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unitNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined || number < 0 || number > 1 ? undefined : number;
}

function optionalUnit(value: unknown): number | undefined {
  return value === undefined ? undefined : unitNumber(value);
}

function isStringNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}
