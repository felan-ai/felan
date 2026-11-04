import { Buffer } from 'node:buffer';
import {
  type AssistantImages,
  createAssistantMessageEventStream,
  type ImageApi,
  type ImageContent,
  type ImageModel,
  type ImagesContext,
  type ImagesOptions,
  type Provider,
  type Usage,
} from '@felan-ai/agent-core';

export const CODEX_IMAGES_PROVIDER_ID = 'openai-codex-images';
export const CODEX_IMAGES_API = 'openai-codex-images';
export const CODEX_IMAGE_MODEL_IDS = ['gpt-image-2', 'gpt-image-2.5'] as const;

const BASE_URL = 'https://chatgpt.com/backend-api/codex';
const AUTH_NAME = 'OpenAI Codex login';

export interface CodexImageCredentials {
  /** Checks access to the openai-codex login without refreshing tokens. */
  available(signal: AbortSignal): Promise<boolean>;
  /** Resolves the openai-codex token through Pi auth, which may refresh OAuth. */
  resolveToken(signal: AbortSignal): Promise<string | undefined>;
}

export function createCodexImageProvider(credentials: CodexImageCredentials): Provider {
  const models: ImageModel<ImageApi>[] = CODEX_IMAGE_MODEL_IDS.map((id) => ({
    type: 'image',
    id,
    name: `${id === 'gpt-image-2' ? 'GPT Image 2' : 'GPT Image 2.5'} (Codex subscription)`,
    provider: CODEX_IMAGES_PROVIDER_ID,
    api: CODEX_IMAGES_API,
    baseUrl: BASE_URL,
    input: ['text', 'image'],
    output: ['image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }));
  return {
    id: CODEX_IMAGES_PROVIDER_ID,
    name: 'OpenAI Codex images',
    baseUrl: BASE_URL,
    auth: {
      apiKey: {
        name: AUTH_NAME,
        async check({ signal }) {
          try {
            return await credentials.available(signal)
              ? { type: 'api_key', source: AUTH_NAME }
              : undefined;
          } catch {
            return undefined;
          }
        },
        async resolve({ signal }) {
          const token = await credentials.resolveToken(signal);
          return token?.trim() ? { auth: { apiKey: token }, source: AUTH_NAME } : undefined;
        },
      },
    },
    getModels: () => [],
    getAllModels: () => models,
    stream: noChatModels,
    streamSimple: noChatModels,
    generateImages,
  };
}

const noChatModels: Provider['stream'] = (model) => {
  const stream = createAssistantMessageEventStream();
  stream.push({
    type: 'error',
    reason: 'error',
    error: {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zeroUsage(),
      stopReason: 'error',
      errorMessage: 'The OpenAI Codex images provider has no chat models.',
      timestamp: Date.now(),
    },
  });
  return stream;
};

async function generateImages(
  model: ImageModel<ImageApi>,
  context: ImagesContext,
  options: ImagesOptions = {},
): Promise<AssistantImages> {
  const result: AssistantImages = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    output: [],
    stopReason: 'error',
    timestamp: Date.now(),
  };
  const fail = (errorMessage: string): AssistantImages => ({ ...result, errorMessage });
  let timeout: AbortSignal | undefined;
  try {
    timeout = AbortSignal.timeout(5 * 60 * 1000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    signal.throwIfAborted();
    const prompt = context.input.filter((block) => block.type === 'text')
      .map((block) => block.text).join('\n\n').trim();
    if (!prompt) return fail('A prompt is required to generate Codex images.');
    const images = context.input.filter((block) => block.type === 'image')
      .map((block) => ({ image_url: `data:${block.mimeType};base64,${block.data}` }));
    if (images.length > 5) return fail('Codex image edits support at most 5 reference images.');
    if (!options.apiKey?.trim()) return fail('Run /login openai-codex to generate images.');
    const accountId = getAccountId(options.apiKey);
    if (!accountId) return fail('Log in again with /login openai-codex to generate images.');

    const headers = new Headers();
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value !== null) headers.set(name, value);
    }
    headers.set('authorization', `Bearer ${options.apiKey}`);
    headers.set('chatgpt-account-id', accountId);
    headers.set('originator', 'pi');
    headers.set('accept', 'application/json');
    headers.set('content-type', 'application/json');
    const body = {
      ...(images.length ? { images } : {}),
      prompt,
      model: model.id,
      background: 'opaque',
      quality: 'auto',
      size: 'auto',
    };
    const response = await (options.fetch ?? globalThis.fetch)(
      `${model.baseUrl}/images/${images.length ? 'edits' : 'generations'}`,
      { method: 'POST', headers, body: JSON.stringify(body), signal },
    );
    signal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        return fail('The Codex login was rejected. Run /login openai-codex.');
      }
      if (response.status === 429) return fail('Codex usage limit reached.');
      return fail(`Codex image request failed (HTTP ${response.status}).`);
    }

    const payload: unknown = await response.json();
    signal.throwIfAborted();
    if (!isRecord(payload) || !Array.isArray(payload.data) || !payload.data.length) {
      return fail('Codex returned no image data.');
    }
    const output: ImageContent[] = [];
    for (const item of payload.data) {
      if (!isRecord(item) || typeof item.b64_json !== 'string') {
        return fail('Codex returned no image data.');
      }
      const data = item.b64_json;
      const bytes = Buffer.from(data, 'base64');
      if (!bytes.length || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)
        || data.length % 4 !== 0) {
        return fail('Codex returned no image data.');
      }
      output.push({ type: 'image', data, mimeType: imageMimeType(bytes, payload.output_format) });
    }
    const usage = parseUsage(payload.usage);
    const responseId = response.headers.get('x-codex-imagegen-request-id');
    return {
      ...result,
      output,
      stopReason: 'stop',
      ...(usage ? { usage } : {}),
      ...(responseId !== null ? { responseId } : {}),
    };
  } catch {
    if (options.signal?.aborted) {
      return { ...fail('Codex image request aborted.'), stopReason: 'aborted' };
    }
    return fail(timeout?.aborted ? 'Codex image request timed out.' : 'Codex image request failed.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getAccountId(token: string): string | undefined {
  try {
    const parts = token.split('.');
    const payload = parts[1];
    if (parts.length !== 3 || !payload || !/^[A-Za-z0-9_-]+$/u.test(payload)) return undefined;
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const auth = isRecord(claims) ? claims['https://api.openai.com/auth'] : undefined;
    const id = isRecord(auth) ? auth.chatgpt_account_id : undefined;
    return typeof id === 'string' && id.trim() ? id : undefined;
  } catch {
    return undefined;
  }
}

function imageMimeType(bytes: Buffer, format: unknown): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('latin1', 0, 6))) return 'image/gif';
  return typeof format === 'string' && ['png', 'jpeg', 'webp', 'gif'].includes(format)
    ? `image/${format}`
    : 'image/png';
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function parseUsage(value: unknown): Usage | undefined {
  if (!isRecord(value)) return undefined;
  const { input_tokens: input, output_tokens: output, total_tokens: totalTokens } = value;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0
    || typeof output !== 'number' || !Number.isFinite(output) || output < 0
    || typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) {
    return undefined;
  }
  return { ...zeroUsage(), input, output, totalTokens };
}
