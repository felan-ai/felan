import { beforeEach, describe, expect, it, vi } from 'vitest';

const headless = vi.hoisted(() => ({
  createModelRuntime: vi.fn(async () => ({}) as any),
  createRuntime: vi.fn(async () => ({
    services: { agentDir: '/tmp/felan-test-agent' },
    diagnostics: [
      { type: 'info', message: 'ignored info' },
      { type: 'warning', message: 'settings warning' },
    ],
  }) as any),
  resolvedModel: { provider: 'test-provider', id: 'test-model' },
  runPrintMode: vi.fn(async () => 0),
}));

vi.mock('@earendil-works/pi-coding-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent')>()),
  resolveCliModel: vi.fn(() => ({
    model: headless.resolvedModel,
    warning: undefined,
    error: undefined,
  })),
  runPrintMode: headless.runPrintMode,
}));

vi.mock('../src/runtime.js', () => ({
  createLocalFelanRuntime: headless.createRuntime,
  createLocalModelRuntime: headless.createModelRuntime,
  getLocalAgentDir: () => '/tmp/felan-test-agent',
}));

import { runLocalFelanHeadless } from '../src/application.js';

beforeEach(() => {
  headless.createModelRuntime.mockClear();
  headless.createRuntime.mockClear();
  headless.runPrintMode.mockClear();
});

describe('headless application', () => {
  it('resolves the requested model, forwards print mode, and keeps diagnostics on stderr', async () => {
    const errors: string[] = [];

    await expect(runLocalFelanHeadless({
      mode: 'json',
      initialMessage: 'inspect this project',
      provider: 'test-provider',
      model: 'test-model',
      thinkingLevel: 'high',
      writeError: (line) => errors.push(line),
    })).resolves.toBe(0);

    expect(headless.createModelRuntime).toHaveBeenCalledOnce();
    expect(headless.createRuntime).toHaveBeenCalledWith(expect.objectContaining({
      model: headless.resolvedModel,
      thinkingLevel: 'high',
    }));
    expect(headless.runPrintMode).toHaveBeenCalledWith(expect.anything(), {
      mode: 'json',
      initialMessage: 'inspect this project',
    });
    expect(errors).toEqual(['Warning: settings warning']);
  });

  it('returns a non-zero status and writes model errors to stderr', async () => {
    const errors: string[] = [];
    const resolveCliModel = (await import('@earendil-works/pi-coding-agent')).resolveCliModel;
    vi.mocked(resolveCliModel).mockReturnValueOnce({
      model: undefined,
      warning: undefined,
      error: 'Model "missing" not found',
    });

    await expect(runLocalFelanHeadless({
      mode: 'text',
      initialMessage: 'prompt',
      model: 'missing',
      writeError: (line) => errors.push(line),
    })).resolves.toBe(1);

    expect(errors).toEqual(['Model "missing" not found']);
    expect(headless.runPrintMode).not.toHaveBeenCalled();
  });
});
