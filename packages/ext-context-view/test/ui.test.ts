import { createUnavailableExtensionUi, type ExtensionUi, type UiElementHandle, type UiPresentOptions } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import type { ContextReport, ContextViewPresentationHost } from '../src/report.js';
import { CONTEXT_DOCUMENT_HINT, createContextViewUiHost } from '../src/ui.js';


function report(): ContextReport {
  return {
    breakdown: { systemPrompt: 1, systemTools: 2, extensions: 3, contextFiles: 4, skills: 5, memory: 6, messages: 7, other: 8, available: 64 },
    usedTokens: 36, contextWindow: 100, usagePercent: 36, estimated: true,
    systemToolCount: 1, extensionToolCount: 12, contextFileCount: 1, skillCount: 12,
    memory: { summary: 1, index: 2, schema: 3, recalls: 4 },
    extensionDetails: Array.from({ length: 12 }, (_, index) => ({ label: `extension-${index}`, toolCount: 1, tokens: index })),
    skillDetails: Array.from({ length: 12 }, (_, index) => ({ label: `skill-${index}`, tokens: index, promptVisible: index !== 0 })),
    modelLabel: 'Test model',
  };
}

function harness() {
  const close = vi.fn(async () => {});
  const handle: UiElementHandle = { close, update: vi.fn(async () => {}) };
  const present = vi.fn<ExtensionUi['present']>(async () => handle);
  const ui: ExtensionUi = {
    ...createUnavailableExtensionUi(),
    present, notify: vi.fn(async () => {}), status: vi.fn(async () => {}), removeStatus: vi.fn(async () => {}),
    request: vi.fn<ExtensionUi['request']>(async () => ({ state: 'cancelled', reason: 'unsupported' })),
  };
  return { present, close, handle, host: createContextViewUiHost(ui) };
}

async function closeDocument(options: UiPresentOptions | undefined, id: string, signal: AbortSignal, revision = 1) {
  await options?.onAction?.({ elementId: id, revision, actionId: 'close', outcome: 'cancel', values: {} }, { requestId: 'close', signal });
}

describe('portable context report document', () => {
  it('emits every category, memory measurement, and detail row without a hint dependency', async () => {
    const h = harness();
    const controller = new AbortController();
    const work = h.host.show(report(), controller.signal);
    const [document, options] = h.present.mock.calls[0]!;
    expect(document).toMatchObject({ kind: 'document', revision: 1, title: 'Context usage' });
    expect(document.hint).toEqual(CONTEXT_DOCUMENT_HINT);
    if (document.kind !== 'document') throw new Error('Expected report document');
    expect(document.markdown).toContain('| Free Space | 64 |');
    expect(document.markdown).toContain('| recalls | 4 |');
    expect(document.markdown).toContain('| extension-11 | 1 | 11 |');
    expect(document.markdown).toContain('| skill-11 | 11 | yes |');
    expect(document.markdown).toContain('estimates, not provider billing measurements');
    expect(document.actions).toEqual([{ id: 'close', label: 'Close report', target: 'element', outcome: 'cancel' }]);
    await closeDocument(options, document.id, controller.signal);
    await work;
    expect(h.close).toHaveBeenCalledOnce();
  });

  it('escapes untrusted labels rather than interpreting HTML, links, controls, or table rows', async () => {
    const h = harness();
    const controller = new AbortController();
    const data = report();
    data.modelLabel = '<script>x</script> [link](javascript:alert(1))\u001b';
    data.extensionDetails[0]!.label = 'name|forged\n# heading';
    const work = h.host.show(data, controller.signal);
    const [document, options] = h.present.mock.calls[0]!;
    if (document.kind !== 'document') throw new Error('Expected report document');
    expect(document.markdown).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(document.markdown).toContain('&#91;link&#93;');
    expect(document.markdown).toContain('\\u001b');
    expect(document.markdown).toContain('name\\|forged\\u000a\\# heading');
    expect(document.markdown).not.toMatch(/<\/?[a-z]|\]\(|\u001b/iu);
    await closeDocument(options, document.id, controller.signal);
    await work;
  });

  it('retains unknown context windows and percentages', async () => {
    const h = harness();
    const controller = new AbortController();
    const original = report();
    const data = { ...original, breakdown: { ...original.breakdown, available: 0 }, contextWindow: null, usagePercent: null };
    const work = h.host.show(data, controller.signal);
    const [document, options] = h.present.mock.calls[0]!;
    expect(document).toHaveProperty('markdown', expect.stringContaining('Usage: 36 / unknown tokens\nUsage percent: unknown'));
    await closeDocument(options, document.id, controller.signal);
    await work;
  });

  it('rejects oversized and incomplete reports before presenting instead of truncating', async () => {
    const h = harness();
    const data = report();
    data.modelLabel = 'x'.repeat(256 * 1024);
    await expect(h.host.show(data, new AbortController().signal)).rejects.toThrow('byte limit');
    await expect(h.host.show({ ...report(), skillDetailsTotal: 13 }, new AbortController().signal))
      .rejects.toThrow('every extension and skill detail row');
    expect(h.present).not.toHaveBeenCalled();
  });

  it('closes a late presentation after abort and waits for close to settle', async () => {
    const h = harness();
    let presented!: (handle: UiElementHandle) => void;
    let finishClose!: () => void;
    h.present.mockImplementation(() => new Promise<UiElementHandle>(resolve => { presented = resolve; }));
    h.close.mockImplementation(() => new Promise<void>(resolve => { finishClose = resolve; }));
    const controller = new AbortController();
    let settled = false;
    const work = h.host.show(report(), controller.signal).then(() => { settled = true; });
    controller.abort();
    presented(h.handle);
    await vi.waitFor(() => expect(h.close).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishClose();
    await work;
    expect(settled).toBe(true);
  });

  it('rejects stale close actions and only closes the matching document', async () => {
    const h = harness();
    const controller = new AbortController();
    const work = h.host.show(report(), controller.signal);
    const [document, options] = h.present.mock.calls[0]!;
    await expect(closeDocument(options, document.id, controller.signal, 2)).rejects.toThrow('Invalid context report action');
    expect(h.close).not.toHaveBeenCalled();
    await closeDocument(options, document.id, controller.signal);
    await work;
  });

  it('reports unavailable common UI rather than silently emitting a partial report', async () => {
    const host = createContextViewUiHost(createUnavailableExtensionUi());
    await expect(host.show(report(), new AbortController().signal)).rejects.toThrow('Extension UI is unavailable');
  });
});
