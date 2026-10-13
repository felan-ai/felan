import type { ExtensionContext } from '@felan-ai/agent-core';
import { Key, matchesKey, type Component } from '@earendil-works/pi-tui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AskUserConfig,
  AskUserHostExecutionContext,
  AskUserRequest,
} from '../../../../packages/ext-ask-user/src/index.js';
import { createTuiAskUserPresenter, presentAskUserForm } from '../../src/tui/renderers/ask-user.js';
import { createUiAskUserHost } from '../../../../packages/ext-ask-user/src/ui.js';
import { createUnavailableExtensionUi, type UiForm } from '@felan-ai/agent-core';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('ask-user form hint', () => {
  async function present(request: AskUserRequest, drive: (component: Component) => void) {
    const { context } = tuiContext(drive);
    let form!: UiForm;
    const host = createUiAskUserHost({ ...createUnavailableExtensionUi(), request: async value => {
      form = value;
      const answer = await presentAskUserForm(value, { ui: context.ui, signal: new AbortController().signal });
      return answer ? { state: 'answered', answer } : { state: 'cancelled', reason: 'abort' };
    } });
    const outcome = await host.ask(request, { requestId: 'call', sessionId: 'session', signal: new AbortController().signal,
      extensionContext: context, reportProgress: vi.fn() });
    return { form, outcome };
  }

  it('drives the wizard from generic fields and preserves stable choices, comments and skipped questions', async () => {
    const request: AskUserRequest = { questions: [
      { ...singleRequest({ allowMultiple: true, allowComment: true }).questions[0]!, id: 'first' },
      { ...singleRequest().questions[0]!, id: 'second' },
    ] };
    const { form, outcome } = await present(request, component => {
      component.handleInput?.(' '); component.handleInput?.('\u001b[B'); component.handleInput?.(' ');
      component.handleInput?.('\u0007'); component.handleInput?.('\r');
      for (const char of 'context') component.handleInput?.(char);
      component.handleInput?.('\r');
      component.handleInput?.('\t'); component.handleInput?.('\r');
    });
    expect(form.hint).toEqual({ id: 'ask-user.wizard', version: '1' });
    expect(outcome).toEqual({ status: 'answered', answers: [
      { questionId: 'first', response: { kind: 'selection', selections: ['Alpha', 'Beta'], comment: 'context' } },
      { questionId: 'second', response: null },
    ] });
  });

  it('preserves duplicate option identities and freeform answers', async () => {
    const duplicate = singleRequest({ options: [{ title: 'Same' }, { title: 'Same' }] });
    const selected = await present(duplicate, component => { component.handleInput?.('\u001b[B'); component.handleInput?.('\r'); });
    expect(selected.outcome).toMatchObject({ status: 'answered', answers: [{ response: { selections: ['Same'] } }] });
    const freeform = await present(singleRequest({ options: [], allowFreeform: true }), component => {
      component.handleInput?.('\r');
      for (const char of 'literal answer') component.handleInput?.(char);
      component.handleInput?.('\r');
    });
    expect(freeform.outcome).toMatchObject({ status: 'answered', answers: [{ response: { kind: 'freeform', text: 'literal answer' } }] });
  });

  it('uses the declared cancellation and preserves complete literal question content', async () => {
    const question = 'Literal *question* <tag> & \\backslash';
    const { outcome } = await present(singleRequest({ question, context: 'Important context' }), component => {
      expect(component.render(120).join('\n')).toContain(question);
      expect(component.render(120).join('\n')).toContain('Important context');
      component.handleInput?.('\u001b');
    });
    expect(outcome).toMatchObject({ status: 'cancelled', reason: 'user' });
  });
});

describe('ask-user client presenter', () => {
  it('presents directly without an extension session context', async () => {
    const { context } = tuiContext(component => {
      component.handleInput?.('\u001b[B'); component.handleInput?.('\r');
    });
    await expect(createTuiAskUserPresenter().present(singleRequest(), {
      ui: context.ui, signal: new AbortController().signal,
    })).resolves.toMatchObject({ status: 'answered', answers: [{ questionId: 'q1', response: { selections: ['Beta'] } }] });
  });

  it('does not open a presenter for an already-aborted signal', async () => {
    const opened = vi.fn(); const { context } = tuiContext(opened);
    const controller = new AbortController(); controller.abort();
    await expect(createTuiAskUserPresenter().present(singleRequest(), { ui: context.ui, signal: controller.signal }))
      .resolves.toEqual({ status: 'cancelled', reason: 'abort' });
    expect(opened).not.toHaveBeenCalled();
  });

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
    let inlineLines: string[] = [];
    const inline = tuiContext((component, options) => {
      customOptions = options;
      inlineLines = component.render(80);
      component.handleInput?.('\u001b');
    });
    await ask({ ...singleRequest(), displayMode: 'inline' }, inline.context);
    expect(customOptions).toBeUndefined();
    expect(inlineLines[0]).toBe('─'.repeat(80));
    expect(inlineLines.at(-1)).toBe('─'.repeat(80));
    expect(inlineLines.some((line) => line.includes('│'))).toBe(false);

    vi.useFakeTimers();
    let overlayLines: string[] = [];
    const overlay = tuiContext((_component, options) => {
      customOptions = options;
      overlayLines = _component.render(80);
    });
    const pending = ask({ ...singleRequest(), displayMode: 'overlay', timeout: 25 }, overlay.context);
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({ status: 'cancelled', reason: 'timeout' });
    expect(customOptions).toMatchObject({ overlay: true, overlayOptions: { anchor: 'center' } });
    expect(overlayLines[0]).toMatch(/^╭.*╮$/u);
    expect(overlayLines.at(-1)).toMatch(/^╰.*╯$/u);
    expect(overlayLines.slice(1, -1).every((line) => line.startsWith('│') && line.endsWith('│'))).toBe(true);
  });

  it('uses inline display mode by default and accepts configured overlay mode', async () => {
    let customOptions: unknown = 'unset';
    const { context } = tuiContext((component, options) => {
      customOptions = options;
      component.handleInput?.('\u001b');
    });

    await ask(singleRequest(), context);
    expect(customOptions).toBeUndefined();

    customOptions = 'unset';
    const overlay = tuiContext((component, options) => {
      customOptions = options;
      component.handleInput?.('\u001b');
    });
    await ask(singleRequest(), overlay.context, vi.fn(), new AbortController().signal, { displayMode: 'overlay' });
    expect(customOptions).toMatchObject({ overlay: true });
  });

  it('supports list-only single-select layout from requests and configuration', async () => {
    let requestLines: string[] = [];
    const requested = tuiContext((component) => {
      requestLines = component.render(100);
      component.handleInput?.('\u001b');
    });
    await ask({ ...singleRequest(), singleSelectLayout: 'list' }, requested.context);
    expect(requestLines.find((line) => line.includes('Filter:'))).not.toContain('Alpha');

    let environmentLines: string[] = [];
    const environment = tuiContext((component) => {
      environmentLines = component.render(100);
      component.handleInput?.('\u001b');
    });
    await ask(singleRequest(), environment.context, vi.fn(), new AbortController().signal, { singleSelectLayout: 'list' });
    expect(environmentLines.find((line) => line.includes('Filter:'))).not.toContain('Alpha');

    let autoLines: string[] = [];
    const auto = tuiContext((component) => {
      autoLines = component.render(100);
      component.handleInput?.('\u001b');
    });
    await ask({ ...singleRequest(), singleSelectLayout: 'auto' }, auto.context);
    expect(autoLines.find((line) => line.includes('Filter:'))).toContain('Alpha');
  });

  it('collapses long context by default and toggles it only with ctrl+e', async () => {
    const longContext = Array.from({ length: 20 }, (_, index) => `context-${index + 1}`).join(' ');
    let collapsedLines: string[] = [];
    let afterOtherEditorControls: string[] = [];
    let expandedLines: string[] = [];
    const { context } = tuiContext((component) => {
      collapsedLines = component.render(62);
      component.handleInput?.('\u0018');
      component.handleInput?.('\u0019');
      afterOtherEditorControls = component.render(62);
      component.handleInput?.('\u0005');
      expandedLines = component.render(62);
      component.handleInput?.('\u001b');
    });

    await ask(singleRequest({ context: longContext }), context);
    expect(collapsedLines.join('\n')).toContain('Context (');
    expect(collapsedLines.join('\n')).toContain('ctrl+e expand');
    expect(collapsedLines.join('\n')).toContain('Alpha');
    expect(afterOtherEditorControls).toEqual(collapsedLines);
    expect(expandedLines.join('\n')).toContain('context-20');
    expect(expandedLines.join('\n')).toContain('ctrl+e collapse context');
  });

  it('bounds multi-select by rendered rows and keeps the active option visible', async () => {
    const options = Array.from({ length: 6 }, (_, index) => ({
      title: `Option ${index + 1}`,
      description: `Description ${index + 1} with enough detail to wrap across several rendered terminal rows`,
    }));
    let rendered: string[] = [];
    const { context } = tuiContext((component) => {
      component.render(60);
      for (let index = 0; index < 4; index += 1) component.handleInput?.('\u001b[B');
      rendered = component.render(60);
      component.handleInput?.('\u001b');
    }, 18);

    await ask({ ...singleRequest({ options, allowMultiple: true, allowFreeform: false }), displayMode: 'overlay' }, context);
    expect(rendered).toHaveLength(15);
    expect(rendered.join('\n')).toContain('Option 5');
    expect(rendered.join('\n')).toContain('(5/6)');
    expect(rendered.join('\n')).not.toContain('Option 1');

    let shortTerminal: string[] = [];
    const short = tuiContext((component) => {
      component.render(60);
      for (let index = 0; index < 5; index += 1) component.handleInput?.('\u001b[B');
      shortTerminal = component.render(60);
      component.handleInput?.('\u001b');
    }, 6);
    await ask({ ...singleRequest({ options, allowMultiple: true, allowFreeform: false }), displayMode: 'overlay' }, short.context);
    expect(shortTerminal).toHaveLength(4);
    expect(shortTerminal.join('\n')).toContain('Option 6');
    expect(shortTerminal.filter((line) => /Option \d/.test(line))).toHaveLength(1);

    let shortWizard: string[] = [];
    const wizard = tuiContext((component) => {
      shortWizard = component.render(60);
      component.handleInput?.('\u001b');
    }, 6);
    await ask({
      displayMode: 'overlay',
      questions: [
        { ...singleRequest().questions[0]!, id: 'q1', header: 'First' },
        { ...singleRequest().questions[0]!, id: 'q2', header: 'Second' },
      ],
    }, wizard.context);
    expect(shortWizard).toHaveLength(4);
    expect(shortWizard.join('\n')).toContain('Alpha');
    expect(shortWizard.join('\n')).toContain('First');
  });

  it('keeps freeform and comment editors visible on short terminals', async () => {
    let freeformLines: string[] = [];
    const freeform = tuiContext((component) => {
      component.handleInput?.('\u001b[B');
      component.handleInput?.('\u001b[B');
      component.handleInput?.('\r');
      for (const character of 'short reply') component.handleInput?.(character);
      freeformLines = component.render(60);
      component.handleInput?.('\r');
    }, 6);
    await expect(ask({ ...singleRequest(), displayMode: 'overlay' }, freeform.context)).resolves.toMatchObject({ status: 'answered' });
    expect(freeformLines).toHaveLength(4);
    expect(freeformLines.join('\n')).toContain('short reply');

    let commentLines: string[] = [];
    const comment = tuiContext((component) => {
      component.handleInput?.('\u0007');
      component.handleInput?.('\r');
      for (const character of 'short note') component.handleInput?.(character);
      commentLines = component.render(60);
      component.handleInput?.('\r');
    }, 6);
    await expect(ask({ ...singleRequest({ allowComment: true }), displayMode: 'overlay' }, comment.context)).resolves.toMatchObject({ status: 'answered' });
    expect(commentLines).toHaveLength(4);
    expect(commentLines.join('\n')).toContain('short note');
  });

  it('stops a client wizard after abort', async () => {
    const { context } = tuiContext(() => {});
    const controller = new AbortController();
    const pending = ask(singleRequest(), context, vi.fn(), controller.signal);
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'cancelled', reason: 'abort' });
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

function tuiContext(driver: (component: Component, options: unknown) => void, terminalRows = 40) {
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
  const tui = { terminal: { rows: terminalRows }, requestRender: vi.fn() };
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

function ask(
  request: AskUserRequest,
  extensionContext: ExtensionContext,
  reportProgress = vi.fn(),
  signal = new AbortController().signal,
  config?: Partial<AskUserConfig>,
) {
  const execution: AskUserHostExecutionContext = {
    requestId: 'call-1',
    sessionId: 'session-1',
    signal,
    extensionContext,
    reportProgress,
  };
  return createTuiAskUserPresenter(config).present(request, { ui: execution.extensionContext.ui, signal: execution.signal, reportProgress: execution.reportProgress });
}
