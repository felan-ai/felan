import type { AgentRuntime } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import { openChromeSetup } from '../src/browser-presentation.js';
import { registerBrowserSetupPresenter } from '../src/client/browser-presenter.js';
import { ClientInteractionPresenters, type InteractionPresenterUi } from '../src/client/presenters.js';
import { BROWSER_SETUP_PRESENTER } from '@felan-ai/ext-browser/presentation';

describe('Chrome setup presenter', () => {
  it('opens only the fixed settings page through the client runtime', async () => {
    const exec = vi.fn(async () => ({ code: 0, killed: false, truncated: false, stdout: '', stderr: '' }));
    const runtime = { kind: 'host', exec } as unknown as AgentRuntime;
    const presenters = new ClientInteractionPresenters({ notify: vi.fn() } as unknown as InteractionPresenterUi);
    registerBrowserSetupPresenter(presenters, runtime);
    const signal = new AbortController().signal;
    const result = await presenters.present({ id: 'setup', state: 'waiting', createdAt: 1, scope: { kind: 'host' }, eligibleClientKinds: ['tui'],
      request: { kind: 'custom', presenter: BROWSER_SETUP_PRESENTER, data: { applicationPath: '/Applications/Google Chrome.app' } } }, signal);
    expect(exec).toHaveBeenCalledExactlyOnceWith('/usr/bin/open', ['-a', '/Applications/Google Chrome.app', 'chrome://inspect/#remote-debugging'], {
      signal, timeout: 5_000, maxOutputBytes: 4_096,
    });
    expect(result).toMatchObject({ state: 'answered', answer: { data: { opened: true } } });
  });

  it.each(['../Chrome.app', '/Applications/Chrome.app\n'])('rejects an unsafe application path: %s', async path => {
    const exec = vi.fn(); const runtime = { kind: 'host', exec } as unknown as AgentRuntime;
    await expect(openChromeSetup(runtime, path, new AbortController().signal)).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });
});
