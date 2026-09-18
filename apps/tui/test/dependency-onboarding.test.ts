import type { ExtensionContext } from '@felan-ai/agent-core';
import { visibleWidth } from '@earendil-works/pi-tui';
import { describe, expect, it, vi } from 'vitest';
import {
  DependencyInstallationChecklist,
  DependencyOnboardingView,
} from '../src/dependency-onboarding.js';

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as ExtensionContext['ui']['theme'];

const options = [
  { id: 'browser', label: 'Browser', description: 'Install browser tools.' },
  { id: 'memory', label: 'Codebase Memory', description: 'Install structural tools.' },
  { id: 'markitdown', label: 'MarkItDown', description: 'Install document tools.' },
];

function createChecklist() {
  let result: readonly string[] | undefined = undefined;
  const done = vi.fn((value: readonly string[] | undefined) => { result = value; });
  const checklist = new DependencyInstallationChecklist(
    { requestRender: vi.fn() },
    theme,
    { matches: () => false } as never,
    options,
    done,
  );
  return { checklist, done, get result() { return result; } };
}

describe('DependencyInstallationChecklist', () => {
  it('renders unchecked install options and instructions', () => {
    const { checklist } = createChecklist();
    const lines = checklist.render(64).join('\n');
    expect(lines).toContain('[ ] Browser');
    expect(lines).toContain('[ ] Codebase Memory');
    expect(lines).toContain('Unchecked extensions will use their safe fallback.');
    expect(lines).not.toContain('[✓]');
  });

  it('returns selected IDs in option order', () => {
    const { checklist, done } = createChecklist();
    checklist.handleInput(' ');
    checklist.handleInput('\u001b[B');
    checklist.handleInput(' ');
    checklist.handleInput('\r');
    expect(done).toHaveBeenCalledExactlyOnceWith(['browser', 'memory']);
  });

  it('submits an empty selection separately from cancellation', () => {
    const submitted = createChecklist();
    submitted.checklist.handleInput('\r');
    expect(submitted.result).toEqual([]);

    const cancelled = createChecklist();
    cancelled.checklist.handleInput('\u001b');
    expect(cancelled.result).toBeUndefined();
    expect(cancelled.done).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('truncates content to constrained terminal widths', () => {
    const { checklist } = createChecklist();
    expect(checklist.render(20).every((line) => visibleWidth(line) <= 20)).toBe(true);
  });
});

describe('DependencyOnboardingView', () => {
  it('keeps the checklist visible until install progress starts', () => {
    const onSubmit = vi.fn();
    const view = new DependencyOnboardingView(
      { requestRender: vi.fn() },
      theme,
      { matches: () => false } as never,
      options,
      { onCancel: vi.fn(), onSubmit },
    );

    view.handleInput(' ');
    view.handleInput('\r');

    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(['browser']);
    expect(view.render(64).join('\n')).toContain('Install optional extensions');

    view.beginInstall('Installing Browser...');
    expect(view.render(64).join('\n')).toContain('Installing Browser...');
    expect(view.render(64).join('\n')).not.toContain('Install optional extensions');

    view.setInstallMessage('Downloading the pinned installer...');
    expect(view.render(64).join('\n')).toContain('Downloading the pinned installer...');
    view.dispose();
  });
});
