import type { ExtensionContext } from '@felan-ai/agent-core';
import { Key, matchesKey, type Component } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AskUserHostExecutionContext,
  AskUserRequest,
} from '../src/index.js';
import { createTuiAskUserHost } from '../src/tui.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createTuiAskUserHost', () => {
  it('searches single-select options with descriptions', async () => {
    const { context } = tuiContext((component) => {
      component.handleInput?.('b');
      component.handleInput?.('\r');
    });
    const outcome = await ask(singleRequest(), context);
    expect(outcome).toEqual({
      status: 'answered',
      answers: [{ questionId: 'q1', response: { kind: 'selection', selections: ['Beta'] } }],
    });
  });

  it('supports multi-select and cancellation', async () => {
    const selected = tuiContext((component) => {
      component.handleInput?.(' ');
      component.handleInput?.('\u001b[B');
      component.handleInput?.(' ');
      component.handleInput?.('\r');
    });
    const request = singleRequest({ allowMultiple: true });
    await expect(ask(request, selected.context)).resolves.toEqual({
      status: 'answered',
      answers: [{ questionId: 'q1', response: { kind: 'selection', selections: ['Alpha', 'Beta'] } }],
    });

    const cancelled = tuiContext((component) => component.handleInput?.('\u001b'));
    await expect(ask(singleRequest(), cancelled.context)).resolves.toEqual({ status: 'cancelled', reason: 'user' });
  });

  it('collects freeform answers and optional selection comments', async () => {
    const freeform = tuiContext((component) => {
      component.handleInput?.('\u001b[B');
      component.handleInput?.('\u001b[B');
      component.handleInput?.('\r');
      for (const character of 'custom answer') component.handleInput?.(character);
      component.handleInput?.('\r');
    });
    await expect(ask(singleRequest(), freeform.context)).resolves.toEqual({
      status: 'answered',
      answers: [{ questionId: 'q1', response: { kind: 'freeform', text: 'custom answer' } }],
    });

    const comment = tuiContext((component) => {
      component.handleInput?.('\u0007');
      component.handleInput?.('\r');
      for (const character of 'extra context') component.handleInput?.(character);
      component.handleInput?.('\r');
    });
    await expect(ask(singleRequest({ allowComment: true }), comment.context)).resolves.toEqual({
      status: 'answered',
      answers: [{
        questionId: 'q1',
        response: { kind: 'selection', selections: ['Alpha'], comment: 'extra context' },
      }],
    });
  });

  it('walks wizard questions, reports progress, and submits review', async () => {
    const progress = vi.fn();
    const { context } = tuiContext((component) => {
      component.handleInput?.('\r');
      component.handleInput?.('\r');
      component.handleInput?.('\r');
    });
    const request: AskUserRequest = {
      questions: [
        { ...singleRequest().questions[0]!, id: 'q1', header: 'Scope', question: 'Scope?' },
        { ...singleRequest().questions[0]!, id: 'q2', header: 'Library', question: 'Library?' },
      ],
    };
    const outcome = await ask(request, context, progress);
    expect(outcome).toMatchObject({
      status: 'answered',
      answers: [
        { questionId: 'q1', response: { selections: ['Alpha'] } },
        { questionId: 'q2', response: { selections: ['Alpha'] } },
      ],
    });
    expect(progress).toHaveBeenCalledTimes(2);
  });

  it('honors inline layout, overlay handles, and timeout', async () => {
    let customOptions: any;
    const inline = tuiContext((component, options) => {
      customOptions = options;
      component.handleInput?.('\u001b');
    });
    await ask({ ...singleRequest(), displayMode: 'inline' }, inline.context);
    expect(customOptions).toBeUndefined();

    vi.useFakeTimers();
    const overlay = tuiContext((_component, options) => {
      customOptions = options;
    });
    const pending = ask({ ...singleRequest(), timeout: 25 }, overlay.context);
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({ status: 'cancelled', reason: 'timeout' });
    expect(customOptions).toMatchObject({ overlay: true, overlayOptions: { anchor: 'center' } });
  });

  it('falls back to RPC dialogs and rejects non-interactive modes', async () => {
    const rpc = dialogContext('Beta');
    await expect(ask(singleRequest(), rpc)).resolves.toEqual({
      status: 'answered',
      answers: [{ questionId: 'q1', response: { kind: 'selection', selections: ['Beta'] } }],
    });

    const print = { mode: 'print', hasUI: false, ui: {} } as unknown as ExtensionContext;
    await expect(ask(singleRequest(), print)).resolves.toMatchObject({
      status: 'cancelled',
      reason: 'unavailable',
      message: expect.stringContaining('print'),
    });
  });

  it('reports RPC timeout and stops a wizard after abort', async () => {
    vi.useFakeTimers();
    const timeoutContext = {
      mode: 'rpc',
      hasUI: true,
      ui: {
        select: vi.fn(async (_title: string, _options: string[], settings?: { timeout?: number }) => (
          new Promise<undefined>((resolve) => setTimeout(resolve, settings?.timeout ?? 0))
        )),
        input: vi.fn(),
      },
    } as unknown as ExtensionContext;
    const timedOut = ask({ ...singleRequest(), timeout: 25 }, timeoutContext);
    await vi.advanceTimersByTimeAsync(25);
    await expect(timedOut).resolves.toEqual({ status: 'cancelled', reason: 'timeout' });

    vi.useRealTimers();
    const controller = new AbortController();
    const select = vi.fn(() => new Promise<string | undefined>(() => {}));
    const rpc = {
      mode: 'rpc',
      hasUI: true,
      ui: { select, input: vi.fn() },
    } as unknown as ExtensionContext;
    const request: AskUserRequest = {
      questions: [
        { ...singleRequest().questions[0]!, id: 'q1' },
        { ...singleRequest().questions[0]!, id: 'q2' },
      ],
    };
    const pending = ask(request, rpc, vi.fn(), controller.signal);
    await vi.waitFor(() => expect(select).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'cancelled', reason: 'abort' });
    expect(select).toHaveBeenCalledOnce();
  });
});

function singleRequest(overrides: Partial<AskUserRequest['questions'][number]> = {}): AskUserRequest {
  return {
    questions: [{
      id: 'q1',
      question: 'Choose?',
      header: 'Q1',
      options: [
        { title: 'Alpha', description: 'First option' },
        { title: 'Beta', description: 'Second option' },
      ],
      allowMultiple: false,
      allowFreeform: true,
      allowComment: false,
      ...overrides,
    }],
  };
}

function tuiContext(driver: (component: Component, options: unknown) => void) {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
  const keybindings = {
    getKeys: (binding: string) => [binding],
    matches: (data: string, binding: string) => {
      if (binding === 'tui.select.confirm' || binding === 'tui.input.submit') return data === '\r';
      if (binding === 'tui.select.cancel') return data === '\u001b';
      if (binding === 'tui.select.up') return matchesKey(data, Key.up);
      if (binding === 'tui.select.down') return matchesKey(data, Key.down);
      if (binding === 'tui.editor.deleteCharBackward') return matchesKey(data, Key.backspace);
      return false;
    },
  };
  const tui = { terminal: { rows: 40 }, requestRender: vi.fn() };
  const ui = {
    theme,
    custom: (_factory: any, options: unknown) => new Promise((resolve) => {
      const component = _factory(tui, theme, keybindings, resolve);
      driver(component, options);
    }),
    onTerminalInput: vi.fn(() => vi.fn()),
    notify: vi.fn(),
  };
  return {
    context: { mode: 'tui', hasUI: true, ui } as unknown as ExtensionContext,
    ui,
  };
}

function dialogContext(selected: string | undefined): ExtensionContext {
  return {
    mode: 'rpc',
    hasUI: true,
    ui: {
      select: vi.fn(async () => selected),
      input: vi.fn(),
    },
  } as unknown as ExtensionContext;
}

function ask(
  request: AskUserRequest,
  extensionContext: ExtensionContext,
  reportProgress = vi.fn(),
  signal = new AbortController().signal,
) {
  const execution: AskUserHostExecutionContext = {
    requestId: 'call-1',
    sessionId: 'session-1',
    signal,
    extensionContext,
    reportProgress,
  };
  return createTuiAskUserHost().ask(request, execution);
}
