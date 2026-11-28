import type { ModelRuntime } from '@felan-ai/agent-core';
import { parseOperationResult } from '@felan-ai/session-protocol';
import { expect, it, vi } from 'vitest';
import { createClaudeCodeUsageExtension, createClaudeCodeUsageRecorder, createHostSubscriptions } from '../../src/providers/host-subscriptions.js';
import { createSubscriptionUsageCache } from '../../src/providers/models-subscription.js';

const NOW = Date.parse('2026-11-28T10:00:00.000Z');
const IN_ONE_HOUR = NOW / 1_000 + 3_600;
const ACCOUNT_ID = 'account-secret-id';
const CODEX_TOKEN = `header.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT_ID } })).toString('base64url')}.signature`;
const ANTHROPIC_TOKEN = 'anthropic-oauth-secret';

function models(signedIn: readonly string[]): ModelRuntime {
  const tokens: Record<string, string> = { 'openai-codex': CODEX_TOKEN, anthropic: ANTHROPIC_TOKEN, xai: 'xai-secret' };
  return {
    isUsingSubscription: vi.fn((provider: string) => signedIn.includes(provider)),
    getAuth: vi.fn(async (provider: string) => signedIn.includes(provider) ? { auth: { apiKey: tokens[provider] }, source: 'OAuth' } : undefined),
  } as unknown as ModelRuntime;
}

const codexUsage = { rate_limit: {
  primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: IN_ONE_HOUR },
  secondary_window: { used_percent: 55.5, limit_window_seconds: 604_800, reset_at: IN_ONE_HOUR + 86_400 },
} };

function upstream(responses: Record<string, () => Response>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const [, respond] = Object.entries(responses).find(([prefix]) => url.startsWith(prefix)) ?? [];
    if (!respond) throw new Error(`Unexpected request: ${url}`);
    return respond();
  });
}

it('maps signed-in subscriptions to validated usage and omits signed-out providers without exposing credentials', async () => {
  const fetch = upstream({
    'https://chatgpt.com/backend-api/wham/usage': () => Response.json(codexUsage),
    'https://api.anthropic.com/api/oauth/usage': () => new Response('{}', { status: 429, headers: { 'retry-after': '120' } }),
  });
  const host = createHostSubscriptions({ models: models(['openai-codex', 'anthropic']), usage: createSubscriptionUsageCache(fetch, () => NOW), now: () => NOW });
  const result = await host.read();
  expect(result).toEqual({ subscriptions: [
    { provider: 'anthropic', modelProvider: 'anthropic', label: 'Claude Plan', windows: [], error: { code: 'HTTP_ERROR', httpStatus: 429 } },
    { provider: 'codex', modelProvider: 'openai-codex', label: 'Codex Plan', updatedAt: NOW, windows: [
      { label: '5h', usedPercent: 20, resetAt: new Date(IN_ONE_HOUR * 1_000).toISOString() },
      { label: 'Week', usedPercent: 55.5, resetAt: new Date((IN_ONE_HOUR + 86_400) * 1_000).toISOString() },
    ] },
  ] });
  expect(parseOperationResult('host.subscriptions', result)).toEqual(result);
  expect(fetch.mock.calls.map(([url]) => String(url)).some(url => url.includes('grok'))).toBe(false);
  const serialized = JSON.stringify(result);
  for (const secret of [CODEX_TOKEN, ANTHROPIC_TOKEN, ACCOUNT_ID, 'chatgpt.com', 'anthropic.com', 'retry']) expect(serialized).not.toContain(secret);
});

it('keeps the last successful windows and time with a later error and drops windows past their reset', async () => {
  let time = NOW;
  let failing = false;
  const fetch = upstream({ 'https://chatgpt.com/backend-api/wham/usage': () => failing ? new Response('', { status: 503 }) : Response.json(codexUsage) });
  const host = createHostSubscriptions({ models: models(['openai-codex']), usage: createSubscriptionUsageCache(fetch, () => time), now: () => time });
  await host.read();
  failing = true; time = NOW + 3_600_001;
  expect(await host.read()).toEqual({ subscriptions: [{ provider: 'codex', modelProvider: 'openai-codex', label: 'Codex Plan', updatedAt: NOW,
    windows: [{ label: 'Week', usedPercent: 55.5, resetAt: new Date((IN_ONE_HOUR + 86_400) * 1_000).toISOString() }],
    error: { code: 'HTTP_ERROR', httpStatus: 503 } }] });
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('bounds upstream window labels and counts to the protocol limits', async () => {
  const additional = Array.from({ length: 12 }, (_, index) => ({ limit_name: `${'\u001b[31m'}${'x'.repeat(200)}${index}`, rate_limit: codexUsage.rate_limit }));
  const fetch = upstream({ 'https://chatgpt.com/backend-api/wham/usage': () => Response.json({ ...codexUsage, additional_rate_limits: additional }) });
  const result = await createHostSubscriptions({ models: models(['openai-codex']), usage: createSubscriptionUsageCache(fetch, () => NOW), now: () => NOW }).read();
  const windows = result.subscriptions[0]!.windows;
  expect(windows).toHaveLength(16);
  expect(windows.every(window => Buffer.byteLength(window.label) <= 128 && !/[\u0000-\u001f]/u.test(window.label))).toBe(true);
  expect(parseOperationResult('host.subscriptions', result)).toEqual(result);
});

const claudeCodeHeaders = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.42',
  'anthropic-ratelimit-unified-5h-reset': String(IN_ONE_HOUR),
  'anthropic-ratelimit-unified-7d-utilization': '0.1',
  'anthropic-ratelimit-unified-7d-reset': String(IN_ONE_HOUR + 86_400),
};
const claudeCodeEntry = { provider: 'anthropic', modelProvider: 'claude-code', label: 'Claude Plan', updatedAt: NOW, windows: [
  { label: '5h', usedPercent: 42, resetAt: new Date(IN_ONE_HOUR * 1_000).toISOString() },
  { label: 'Week', usedPercent: 10, resetAt: new Date((IN_ONE_HOUR + 86_400) * 1_000).toISOString() },
] };

function memoryStorage(initial?: string) {
  const files = new Map<string, Uint8Array>(initial === undefined ? [] : [['claude-code-usage.json', new TextEncoder().encode(initial)]]);
  return {
    files,
    readFile: vi.fn(async (path: string) => { const file = files.get(path); if (!file) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return file; }),
    writeFile: vi.fn(async (path: string, content: Uint8Array) => { files.set(path, content); }),
  };
}

it('reports Claude Code usage from the session headers of claude-code models only', async () => {
  const recorder = createClaudeCodeUsageRecorder(() => NOW);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
  const extension = createClaudeCodeUsageExtension(recorder);
  if (typeof extension === 'function') throw new Error('Expected a named inline extension');
  await extension.factory({ on: (name: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(name, handler); } } as never);
  const respond = handlers.get('after_provider_response')!;
  respond({ type: 'after_provider_response', status: 200, headers: claudeCodeHeaders }, { model: { provider: 'anthropic', id: 'claude' } });
  respond({ type: 'after_provider_response', status: 200, headers: { 'content-type': 'application/json' } }, { model: { provider: 'claude-code', id: 'opus' } });
  expect(recorder.latest()).toBeUndefined();
  respond({ type: 'after_provider_response', status: 200, headers: claudeCodeHeaders }, { model: { provider: 'claude-code', id: 'opus' } });

  const result = await createHostSubscriptions({ models: models([]), claudeCode: recorder, now: () => NOW }).read();
  expect(result).toEqual({ subscriptions: [claudeCodeEntry] });
  expect(parseOperationResult('host.subscriptions', result)).toEqual(result);
});

it('returns the OAuth and Claude Code entries side by side, distinguished by model provider', async () => {
  const recorder = createClaudeCodeUsageRecorder(() => NOW);
  recorder.observe(claudeCodeHeaders);
  const fetch = upstream({ 'https://api.anthropic.com/api/oauth/usage': () => Response.json({ five_hour: { utilization: 5 } }) });
  const result = await createHostSubscriptions({ models: models(['anthropic']), claudeCode: recorder,
    usage: createSubscriptionUsageCache(fetch, () => NOW), now: () => NOW }).read();
  expect(result.subscriptions.map(entry => [entry.provider, entry.modelProvider])).toEqual([['anthropic', 'anthropic'], ['anthropic', 'claude-code']]);
});

it('persists Claude Code usage for the next daemon and keeps newer session usage over the persisted record', async () => {
  const storage = memoryStorage();
  const first = createClaudeCodeUsageRecorder(() => NOW);
  await first.restore(storage);
  first.observe(claudeCodeHeaders);
  await first.settle();
  expect(storage.writeFile).toHaveBeenCalledOnce();

  const next = createClaudeCodeUsageRecorder(() => NOW + 1);
  await next.restore(storage);
  expect(await createHostSubscriptions({ models: models([]), claudeCode: next, now: () => NOW }).read()).toEqual({ subscriptions: [claudeCodeEntry] });

  const newer = createClaudeCodeUsageRecorder(() => NOW + 5);
  newer.observe({ ...claudeCodeHeaders, 'anthropic-ratelimit-unified-5h-utilization': '0.9' });
  await newer.restore(storage); await newer.settle();
  expect(newer.latest()).toMatchObject({ lastSuccessAt: NOW + 5, windows: [{ label: '5h', usedPercent: 90 }, { label: 'Week' }] });
  const reloaded = createClaudeCodeUsageRecorder();
  await reloaded.restore(storage);
  expect(reloaded.latest()).toMatchObject({ lastSuccessAt: NOW + 5 });
});

it.each([
  ['malformed JSON', '{'],
  ['an unknown version', JSON.stringify({ version: 2, providers: { anthropic: { snapshot: { windows: [{ label: '5h', usedPercent: 1 }] } } } })],
  ['windows without labels or percentages', JSON.stringify({ version: 1, providers: { anthropic: { snapshot: { windows: [{ usedPercent: 1 }, { label: '5h', usedPercent: 'high' }] } } } })],
])('ignores persisted Claude Code usage with %s', async (_name, contents) => {
  const recorder = createClaudeCodeUsageRecorder();
  await recorder.restore(memoryStorage(contents));
  expect(recorder.latest()).toBeUndefined();
  expect(await createHostSubscriptions({ models: models([]), claudeCode: recorder }).read()).toEqual({ subscriptions: [] });
});

it('omits invalid persisted fetch times and keeps the validated windows', async () => {
  const recorder = createClaudeCodeUsageRecorder();
  await recorder.restore(memoryStorage(JSON.stringify({ version: 1, providers: { anthropic: { rateLimitedCount: 0,
    snapshot: { windows: [{ label: 'Extra [on]', usedPercent: 250, resetDescription: 'later' }], lastSuccessAt: -1.5, token: 'secret' } } } })));
  const result = await createHostSubscriptions({ models: models([]), claudeCode: recorder }).read();
  expect(result).toEqual({ subscriptions: [{ provider: 'anthropic', modelProvider: 'claude-code', label: 'Claude Plan', windows: [{ label: 'Extra [on]', usedPercent: 100 }] }] });
  expect(parseOperationResult('host.subscriptions', result)).toEqual(result);
});

it('persists Claude Code usage only when its windows change, at most once per 30 seconds, and flushes the latest on settle', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: NOW });
  try {
    const storage = memoryStorage();
    const recorder = createClaudeCodeUsageRecorder();
    await recorder.restore(storage);
    const usage = (percent: string) => ({ ...claudeCodeHeaders, 'anthropic-ratelimit-unified-5h-utilization': percent });
    const written = () => storage.writeFile.mock.calls.map(([, content]) => JSON.parse(new TextDecoder().decode(content))
      .providers.anthropic.snapshot.windows[0].usedPercent as number);
    recorder.observe(usage('0.1'));
    await vi.advanceTimersByTimeAsync(1_000);
    recorder.observe(usage('0.1'));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(written()).toEqual([10]);
    recorder.observe(usage('0.2'));
    recorder.observe(usage('0.3'));
    await vi.advanceTimersByTimeAsync(0);
    expect(written()).toEqual([10, 20]);
    recorder.observe(usage('0.4'));
    recorder.observe(usage('0.5'));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(written()).toEqual([10, 20]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(written()).toEqual([10, 20, 50]);
    recorder.observe(usage('0.6'));
    await recorder.settle();
    expect(written()).toEqual([10, 20, 50, 60]);
    await recorder.settle();
    expect(written()).toHaveLength(4);
  } finally { vi.useRealTimers(); }
});
