import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFelanApiExtension,
  type CreateFelanApiExtensionOptions,
} from '../src/index.js';

describe('Felan API extension', () => {
  const originalApiKey = process.env.FELAN_API_KEY;
  const originalApiUrl = process.env.FELAN_API_URL;
  const originalTeamSlug = process.env.FELAN_TEAM_SLUG;

  afterEach(() => {
    restoreEnvironment('FELAN_API_KEY', originalApiKey);
    restoreEnvironment('FELAN_API_URL', originalApiUrl);
    restoreEnvironment('FELAN_TEAM_SLUG', originalTeamSlug);
  });

  it('does not register a tool or capability without a key', () => {
    delete process.env.FELAN_API_KEY;
    const harness = createHarness();

    createFelanApiExtension()(harness.api);

    expect(harness.tools).toEqual([]);
    expect(harness.capabilities).toEqual([]);
  });

  it('activates from FELAN_API_KEY and registers exactly one gateway', () => {
    process.env.FELAN_API_KEY = 'env-key';
    const harness = createHarness();

    createFelanApiExtension()(harness.api);

    expect(harness.tools.map((tool) => tool.name)).toEqual(['felan_api']);
    expect(harness.capabilities).toEqual([
      expect.objectContaining({ id: 'felan-api' }),
    ]);
    expect(harness.tools[0]?.parameters).toMatchObject({ additionalProperties: false });
  });

  it('does not fall back to the environment when an explicit key is blank', () => {
    process.env.FELAN_API_KEY = 'environment-key';
    const harness = createHarness({ apiKey: '   ' });

    createFelanApiExtension(harness.options)(harness.api);

    expect(harness.tools).toEqual([]);
    expect(harness.capabilities).toEqual([]);
  });

  it('uses an explicit key instead of the environment key', async () => {
    process.env.FELAN_API_KEY = 'environment-key';
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer explicit-key' });
      return new Response(JSON.stringify({ data: { ok: true } }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const harness = createHarness({ apiKey: ' explicit-key ', fetch });

    createFelanApiExtension(harness.options)(harness.api);
    const result = await harness.execute({
      path: 'teams/acme/integrations',
      query: { providers: 'github,linear' },
    });

    expect(fetch).toHaveBeenCalledOnce();
    const [input, init] = fetch.mock.calls[0]!;
    expect(String(input)).toBe('https://app.felan.ai/api/v1/teams/acme/integrations?providers=github%2Clinear');
    expect(init?.method).toBe('GET');
    expect(result).toMatchObject({ details: { method: 'GET', ok: true, path: '/api/v1/teams/acme/integrations?…' } });
    expect(result.content[0]?.text).toContain('<untrusted_felan_api_content');
  });

  it('uses FELAN_TEAM_SLUG in team-scoped API guidance', () => {
    process.env.FELAN_API_KEY = 'env-key';
    process.env.FELAN_TEAM_SLUG = 'environment-team';
    const harness = createHarness();

    createFelanApiExtension()(harness.api);

    expect(harness.capabilities[0]?.instructions).toContain(
      'The configured team slug is "environment-team"',
    );
    expect(harness.tools[0]?.promptGuidelines).toContain(
      'The configured team slug is "environment-team"; use it in team-scoped API paths.',
    );
  });

  it('uses an explicit team slug instead of FELAN_TEAM_SLUG', () => {
    process.env.FELAN_TEAM_SLUG = 'environment-team';
    const harness = createHarness({ apiKey: 'key', teamSlug: ' cloud-team ' });

    createFelanApiExtension(harness.options)(harness.api);

    expect(harness.capabilities[0]?.instructions).toContain(
      'The configured team slug is "cloud-team"',
    );
    expect(harness.capabilities[0]?.instructions).not.toContain('environment-team');
  });

  it('does not fall back to FELAN_TEAM_SLUG when an explicit team slug is blank', () => {
    process.env.FELAN_TEAM_SLUG = 'environment-team';
    const harness = createHarness({ apiKey: 'key', teamSlug: '   ' });

    createFelanApiExtension(harness.options)(harness.api);

    expect(harness.capabilities[0]?.instructions).toContain(
      'Most operations require the team slug',
    );
    expect(harness.capabilities[0]?.instructions).not.toContain('environment-team');
  });

  it('normalizes an explicit API base URL and sends JSON mutations', async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.example.test/root/api/v1/teams/acme/automations');
      expect(init?.method).toBe('POST');
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer key',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(String(init?.body))).toEqual({ prompt: 'run tests' });
      return new Response(JSON.stringify({ data: { id: 'automation-1' } }), {
        headers: { 'content-type': 'application/json' },
      });
    });
    const harness = createHarness({ apiKey: 'key', baseUrl: 'https://api.example.test/root', fetch });

    createFelanApiExtension(harness.options)(harness.api);
    await harness.execute({
      method: 'POST',
      path: '/teams/acme/automations',
      body: { prompt: 'run tests' },
    });
  });

  it('uses the same gateway for public documentation without sending the API key', async () => {
    const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://docs.example.test/docs/llms.txt');
      expect(init?.headers).toMatchObject({ Accept: 'text/plain' });
      expect((init?.headers as Record<string, string>).Authorization).toBeUndefined();
      return new Response('# Felan docs', {
        headers: { 'content-type': 'text/plain' },
      });
    });
    const harness = createHarness({
      apiKey: 'key',
      docsBaseUrl: 'https://docs.example.test/docs',
      fetch,
    });
    createFelanApiExtension(harness.options)(harness.api);

    const result = await harness.execute({ target: 'docs' });

    expect(result).toMatchObject({ details: { target: 'docs', ok: true } });
    expect(result.content[0]?.text).toContain('# Felan docs');
  });

  it.each([
    '../private',
    'teams/%2e%2e/private',
    'https://attacker.example/private',
    'teams/acme?token=secret',
    'teams\\acme',
  ])('rejects unsafe path %s without making a request', async (path) => {
    const fetch = vi.fn();
    const harness = createHarness({ apiKey: 'key', fetch });
    createFelanApiExtension(harness.options)(harness.api);

    const result = await harness.execute({ path });

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ isError: true, details: { error: 'invalid_request', ok: false } });
  });

  it('refuses redirects and redacts the API key from remote output', async () => {
    const fetch = vi.fn<(input: string | URL, init?: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ leaked: 'secret-key' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
      }),
    );
    const harness = createHarness({ apiKey: 'secret-key', fetch });
    createFelanApiExtension(harness.options)(harness.api);

    const result = await harness.execute({ path: 'teams/acme' });

    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe('error');
    expect(result).toMatchObject({
      isError: true,
      details: { error: 'http_error', ok: false, status: 401 },
    });
    expect(JSON.stringify(result)).not.toContain('secret-key');
  });

  it('propagates caller aborts instead of turning them into a success result', async () => {
    const fetch = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
      throw new Error('aborted');
    });
    const harness = createHarness({ apiKey: 'key', fetch });
    createFelanApiExtension(harness.options)(harness.api);
    const controller = new AbortController();
    const execution = harness.execute({ path: 'teams/acme' }, controller.signal);
    controller.abort(new Error('caller aborted'));

    await expect(execution).rejects.toThrow('caller aborted');
  });
});

function createHarness(options: CreateFelanApiExtensionOptions = {}) {
  const tools: Array<any> = [];
  const capabilities: Array<any> = [];
  const api = {
    registerTool: (tool: any) => tools.push(tool),
    registerCapability: (capability: any) => capabilities.push(capability),
  } as unknown as FelanExtensionAPI;
  return {
    api,
    options,
    tools,
    capabilities,
    execute: (params: Record<string, unknown>, signal?: AbortSignal) => {
      const tool = tools[0];
      if (!tool) throw new Error('Felan API tool was not registered');
      return tool.execute('tool-1', params, signal, undefined, {} as never);
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
