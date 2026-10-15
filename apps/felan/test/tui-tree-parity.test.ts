import { beforeEach, describe, expect, it } from 'vitest';
import { setKeybindings, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { SessionManager, TreeSelectorComponent, initTheme, type SessionTreeNode } from '@earendil-works/pi-coding-agent';
import type { OperationResult } from '@felan-ai/session-protocol';
import { TreeNavigator } from '../src/tui/tree-navigator.js';
import { createClientKeybindings } from '../src/tui/keybindings.js';
import { defaultClientTheme } from '../src/tui/theme.js';

type Tree = OperationResult<'session.tree'>;

beforeEach(() => {
  setKeybindings(createClientKeybindings());
  initTheme('dark');
});

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (content: unknown[], stopReason: string, timestamp: number, errorMessage?: string) => ({
  role: 'assistant', content, api: 'fixture', provider: 'fixture', model: 'model-a', usage, stopReason, timestamp, ...(errorMessage ? { errorMessage } : {}),
}) as never;

function findNode(nodes: SessionTreeNode[], id: string): SessionTreeNode | undefined {
  for (const node of nodes) {
    const found = node.entry.id === id ? node : findNode(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/** Builds the same session in Pi and returns the protocol entries the daemon projects for it. */
function fixture() {
  const manager = SessionManager.inMemory('/fixture');
  const model = manager.appendModelChange('fixture', 'model-a');
  const user = manager.appendMessage({ role: 'user', content: 'say hi', timestamp: 1 });
  const read = manager.appendMessage(assistant([{ type: 'text', text: 'Reading' },
    { type: 'toolCall', id: 'call-read', name: 'read', arguments: { path: '/fixture/a.ts', offset: 2, limit: 3 } }], 'toolUse', 2));
  const result = manager.appendMessage({ role: 'toolResult', toolCallId: 'call-read', toolName: 'read', content: [{ type: 'text', text: 'file body' }], isError: false, timestamp: 3 } as never);
  const failed = manager.appendMessage(assistant([], 'error', 4, 'provider failed'));
  manager.branch(user);
  const other = manager.appendMessage(assistant([{ type: 'text', text: 'Other branch' }], 'stop', 5));
  const label = manager.appendLabelChange(other, 'Alternative');
  const shell = manager.appendMessage({ role: 'bashExecution', command: 'ls -la', output: 'total 0', exitCode: 0, cancelled: false, truncated: false, timestamp: 6 } as never);
  const note = manager.appendCustomMessageEntry('felan-memory', 'Remember this', true);
  manager.resetLeaf();
  const second = manager.appendMessage({ role: 'user', content: 'second root', timestamp: 10 });
  manager.branch(note);
  const labelTimestamp = Date.parse(findNode(manager.getTree(), other)!.labelTimestamp!);
  const tree: Tree = { revision: 1, branch: note, entries: [
    { id: model, kind: 'model_change', title: 'model: model-a', summary: '', timestamp: 1 },
    { id: user, parent: model, kind: 'message', role: 'user', summary: 'say hi', timestamp: 2 },
    { id: read, parent: user, kind: 'message', role: 'assistant', summary: 'Reading', stopReason: 'toolUse', timestamp: 3 },
    { id: result, parent: read, kind: 'message', role: 'toolResult', title: 'read: /fixture/a.ts:2-4', summary: 'file body', timestamp: 4 },
    { id: failed, parent: result, kind: 'message', role: 'assistant', summary: '', stopReason: 'error', errorMessage: 'provider failed', timestamp: 5 },
    { id: other, parent: user, kind: 'message', role: 'assistant', summary: 'Other branch', stopReason: 'stop', label: 'Alternative', labelTimestamp, timestamp: 6 },
    { id: label, parent: other, kind: 'label', title: 'label: Alternative', summary: '', timestamp: 7 },
    { id: shell, parent: label, kind: 'message', role: 'bashExecution', summary: 'ls -la', timestamp: 8 },
    { id: note, parent: shell, kind: 'custom_message', title: 'felan-memory', summary: 'Remember this', timestamp: 9 },
    { id: second, kind: 'message', role: 'user', summary: 'second root', timestamp: 10 },
  ] };
  return { manager, tree };
}

type Session = ReturnType<typeof fixture>;
type Run = { lines: string[]; selected: string | undefined };
const clean = (lines: string[]) => lines.map(line => stripTerminalSequences(line).trimEnd());

function runPi(session: Session, keys: string[], width: number): Run {
  const { manager } = session;
  let selected: string | undefined;
  const component = new TreeSelectorComponent(manager.getTree(), manager.getLeafId(), 30, id => { selected = id; }, () => {});
  for (const key of keys) component.handleInput(key);
  return { lines: clean(component.render(width)), selected };
}

function runNavigatorRaw(session: Session, width: number): string[] {
  return new TreeNavigator(session.tree, () => {}, undefined, undefined, async () => {}, () => {}, () => 30).render(width);
}

function runNavigator(session: Session, keys: string[], width: number): Run {
  const { tree } = session;
  let selected: string | undefined;
  const navigator = new TreeNavigator(tree, choice => { selected = choice?.action === 'select' ? choice.entryId : undefined; }, undefined, undefined, async () => {}, () => {}, () => 30);
  for (const key of keys) navigator.handleInput(key);
  return { lines: clean(navigator.render(width)), selected };
}

const scenarios: Array<{ name: string; keys: string[] }> = [
  { name: 'initial view', keys: [] },
  { name: 'up and down wrap', keys: ['\x1b[A', '\x1b[B', '\x1b[B'] },
  { name: 'page navigation', keys: ['\x1b[5~', '\x1b[6~'] },
  { name: 'user filter', keys: ['\x15'] },
  { name: 'all filter', keys: ['\x01'] },
  { name: 'no-tools toggled from all', keys: ['\x01', '\x14'] },
  { name: 'labeled filter', keys: ['\x0c'] },
  { name: 'filter cycle forwards', keys: ['\x0f'] },
  { name: 'fold and unfold branch', keys: ['\x1b[1;3D', '\x1b[1;3C'] },
  { name: 'fold current parent', keys: ['\x1b[A', '\x1b[1;3D'] },
  { name: 'search narrows rows', keys: ['h', 'i'] },
  { name: 'search clears before cancel', keys: ['z', 'z', '\x1b'] },
  { name: 'search backspace', keys: ['h', 'i', '\x7f'] },
  { name: 'second root selected', keys: ['\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[B'] },
  { name: 'label time on labeled entry', keys: ['\x1b[A', '\x1b[A', 'T'] },
  { name: 'label editor', keys: ['L'] },
  { name: 'label editor cancelled', keys: ['L', 'x', '\x1b'] },
  { name: 'select current leaf', keys: ['\r'] },
  { name: 'select after navigation', keys: ['\x1b[A', '\x1b[A', '\r'] },
];

describe('tree navigator parity with Pi TreeSelectorComponent', () => {
  for (const { name, keys } of scenarios) {
    for (const width of [40, 80, 120]) {
      it(`matches Pi for ${name} at width ${width}`, () => {
        const session = fixture();
        const pi = runPi(session, keys, width); const navigator = runNavigator(session, keys, width);
        expect(navigator.lines).toEqual(pi.lines);
        expect(navigator.selected).toBe(pi.selected);
      });
    }
  }

  it('highlights the selected row with the selection background', () => {
    const selectedBg = defaultClientTheme().getBgAnsi('selectedBg');
    expect(runNavigatorRaw(fixture(), 80).find(line => line.includes('›'))).toContain(selectedBg);
  });

  it('keeps every rendered line within the terminal width', () => {
    for (const width of [40, 80, 120]) {
      for (const line of runNavigator(fixture(), ['\x01'], width).lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
