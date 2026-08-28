export interface CbmCallOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal | undefined;
  readonly allowError?: boolean;
}

export interface CbmCallResult {
  readonly ok: boolean;
  readonly data: unknown;
  readonly rawText: string;
  readonly stderr: string;
}

export interface ToolTextResult {
  readonly content: [{ readonly type: 'text'; readonly text: string }];
  readonly details: Readonly<Record<string, unknown>>;
}

export function buildToolTextResult(title: string, data: unknown, details: Readonly<Record<string, unknown>> = {}): ToolTextResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text: `${title}\n\n${text}` }], details: { ...details, data } };
}
