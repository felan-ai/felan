import type { ExecOptions, ExecResult, ExtensionContext, FelanExtensionAPI } from '@felan-ai/agent-core';
import { describe, expect, it, vi } from 'vitest';
import browserExtension, { createBrowserExtension } from '../src/index.js';
import type {
  BrowserAuthorizationAttachment,
  BrowserAuthorizationConnection,
  BrowserAuthorizationHost,
  BrowserAuthorizationLease,
  BrowserAuthorizationOutcome,
  BrowserAuthorizationRequest,
} from '../src/authorization.js';
import { BrowserTestRuntime, result, VALID_PNG_HEADER } from './test-runtime.js';

const resizeImageMock = vi.hoisted(() => vi.fn(async () => ({
  data: 'aGVsbG8=',
  mimeType: 'image/png',
  originalWidth: 1,
  originalHeight: 1,
  width: 1,
  height: 1,
  wasResized: false,
})));

vi.mock('@felan-ai/agent-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@felan-ai/agent-core')>()),
  resizeImage: resizeImageMock,
}));

describe('browser extension', () => {
  it('registers one capability and one typed browser tool with on-demand skill guidance', async () => {
    const harness = await createHarness();
    expect(harness.capabilities).toEqual([{
      id: 'browser',
      instructions: expect.stringContaining('ask the user to confirm unless their current request already explicitly authorizes'),
    }]);
    expect([...harness.tools.keys()]).toEqual(['browser']);
    expect(harness.tools.get('browser').promptGuidelines).toEqual(expect.arrayContaining([
      expect.stringContaining('skill'),
      expect.stringContaining('existing authenticated Chrome'),
      expect.stringContaining('screenshot'),
    ]));
  });

  it('retrieves version-matched core skills and runs literal browser args with untrusted output', async () => {
    const harness = await createHarness();
    const tool = harness.tools.get('browser');

    const skill = await tool.execute('skill', {
      operation: 'skill',
      skill: 'core',
      full: true,
    }, undefined, undefined, harness.context);
    expect(skill.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('# core skill from installed CLI'),
    });
    expect(harness.runtime.calls.find((call) => call.args[0] === 'skills')?.args).toEqual([
      'skills',
      'get',
      'core',
      '--full',
      '--max-output',
      '100000',
      '--config',
      '/session/browser/controls/skills/agent-browser.json',
    ]);

    const opened = await tool.execute('open', {
      operation: 'run',
      args: ['open', 'https://example.com'],
    }, undefined, undefined, harness.context);
    expect(opened.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('<untrusted_browser_content') });
    expect(harness.runtime.calls.find((call) => call.args[0] === 'open')?.args).toEqual(expect.arrayContaining([
      'open',
      'https://example.com',
      '--json',
      '--content-boundaries',
      '--session',
      expect.stringMatching(/^f-[0-9a-f]{16}$/u),
      '--namespace',
      expect.stringMatching(/^f-[0-9a-f]{16}$/u),
    ]));
  });

  it('attaches a staged screenshot directly for image-capable models and closes on shutdown', async () => {
    const harness = await createHarness({ image: true });
    const tool = harness.tools.get('browser');
    const screenshot = await tool.execute('screenshot', {
      operation: 'run',
      args: ['screenshot'],
    }, undefined, undefined, harness.context);

    expect(screenshot.content.at(-1)).toEqual({ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
    expect(screenshot.details).toMatchObject({ screenshot: { delivered: true, mimeType: 'image/png' } });
    await harness.emit('session_shutdown');
    expect(harness.runtime.calls.at(-1)?.args).toEqual(expect.arrayContaining(['close']));
  });

  it('reports a text fallback for models without image input and blocks installation commands', async () => {
    const harness = await createHarness({ image: false });
    const tool = harness.tools.get('browser');
    const screenshot = await tool.execute('screenshot', {
      operation: 'run',
      args: ['screenshot'],
    }, undefined, undefined, harness.context);
    expect(screenshot.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('does not support image input') });

    await expect(tool.execute('install', {
      operation: 'run',
      args: ['install'],
    }, undefined, undefined, harness.context)).rejects.toThrow('does not run install');
  });

  it('propagates cancellation while retrieving a skill', async () => {
    const controller = new AbortController();
    const harness = await createHarness({ onSkill: () => controller.abort() });
    const tool = harness.tools.get('browser');

    await expect(tool.execute('skill', {
      operation: 'skill',
      skill: 'core',
    }, controller.signal, undefined, harness.context)).rejects.toThrow('aborted');
  });

  it('propagates cancellation during executable discovery', async () => {
    const controller = new AbortController();
    const harness = await createHarness({ onProbe: () => controller.abort() });
    const tool = harness.tools.get('browser');

    await expect(tool.execute('skill', {
      operation: 'skill',
      skill: 'core',
    }, controller.signal, undefined, harness.context)).rejects.toThrow('detection aborted');
    expect(harness.runtime.calls.some((call) => call.args[0] === 'skills')).toBe(false);
  });

  it('authorizes, reuses, and revokes an existing browser session', async () => {
    const lease = createLease();
    const authorizationHost = createAuthorizationHost(lease);
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');
    const browser = harness.tools.get('browser');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    await expect(authorize.execute('authorize-again', { operation: 'authorize', origin: 'https://example.com/path' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { reused: true } });
    await expect(authorize.execute('authorize-other', { operation: 'authorize', origin: 'https://example.org' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    await expect(browser.execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context))
      .resolves.toBeDefined();
    await expect(browser.execute('cookies', { operation: 'run', args: ['cookies'] }, undefined, undefined, harness.context))
      .rejects.toThrow('unavailable on an authorized existing browser session');
    await expect(authorize.execute('revoke', { operation: 'revoke' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'revoked' } });
    expect(authorizationHost.authorize).toHaveBeenCalledOnce();
    expect(harness.runtime.calls.filter((call) => call.args.includes('--pin-tab'))).toHaveLength(1);
    expect(harness.runtime.calls.some((call) => call.args.includes('--pin-tab'))).toBe(true);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('keeps attached commands and private observations on one fresh daemon scope', async () => {
    const authorizationHost = createAuthorizationHost(createLease());
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');
    const browser = harness.tools.get('browser');

    await browser.execute('isolated-open', { operation: 'run', args: ['open', 'https://isolated.example'] }, undefined, undefined, harness.context);
    const isolatedOpen = harness.runtime.calls.find((call) => call.args[0] === 'open');
    const authorized = await authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    expect(authorized).toMatchObject({ details: { state: 'authorized' } });
    const opened = await browser.execute('attached-open', { operation: 'run', args: ['open', 'https://example.com/path'] }, undefined, undefined, harness.context);
    const snapshot = await browser.execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context);

    const attachmentCall = harness.runtime.calls.find((call) => call.args[0] === 'open' && call.args.includes('--cdp'));
    const attachedOpen = harness.runtime.calls.find((call) => call.args[0] === 'open' && call.args[1] === 'https://example.com/path');
    const snapshotCall = harness.runtime.calls.find((call) => call.args[0] === 'snapshot');
    const attachedScope = cliScope(attachmentCall);
    expect(attachedScope.session).not.toBe(cliScope(isolatedOpen).session);
    expect(attachedScope.namespace).toBe(cliScope(isolatedOpen).namespace);
    expect(cliScope(attachedOpen)).toEqual(attachedScope);
    expect(cliScope(snapshotCall)).toEqual(attachedScope);
    expect(attachedOpen?.args).toEqual(expect.arrayContaining(['--cdp', 'ws://127.0.0.1:9222/devtools/browser/test']));
    expect(snapshotCall?.args).toEqual(expect.arrayContaining(['--cdp', 'ws://127.0.0.1:9222/devtools/browser/test']));
    expect(harness.runtime.calls.filter((call) => call.args.includes('--pin-tab'))).toHaveLength(1);

    const observationNames = ['session info', 'get cdp-url', 'tab list', 'get url'];
    const observations = harness.runtime.calls.filter((call) => observationNames.includes(commandKey(call.args)));
    expect(observations.map((call) => commandKey(call.args))).toEqual(expect.arrayContaining(observationNames));
    for (const observation of observations) {
      expect(cliScope(observation)).toEqual(attachedScope);
      if (observation.args[0] === 'session') expect(observation.args).not.toContain('--cdp');
      else expect(observation.args).toEqual(expect.arrayContaining(['--cdp', 'ws://127.0.0.1:9222/devtools/browser/test']));
    }
    const modelOutput = JSON.stringify([authorized, opened, snapshot]);
    for (const privateValue of ['backgroundPid', 'browserLaunched', 'cdpUrl', 'ws://127.0.0.1:9222', 'test-target']) {
      expect(modelOutput).not.toContain(privateValue);
    }
  });

  it('waits for native shutdown after close acknowledges before the daemon exits', async () => {
    let closing = false;
    let remaining = 2;
    const lease = createLease();
    const harness = await createHarness({
      authorizationHost: createAuthorizationHost(lease),
      commands: {
        close: ({ session }) => { closing = true; session.active = false; return jsonSuccess({ closed: true }); },
        'session info': () => closing && remaining-- > 0
          ? jsonSuccess({ active: true, pid: 123, runtime: { backgroundPid: 123, browserLaunched: false }, runtimeError: null })
          : undefined,
      },
    });
    const tool = harness.tools.get('browser_authorize');
    await tool.execute('grant', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    await expect(tool.execute('revoke', { operation: 'revoke' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'revoked' } });
    expect(remaining).toBeLessThan(0);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('keeps a completed grant independent of its original tool-call cancellation signal', async () => {
    const controller = new AbortController();
    const lease = createLease();
    let lifetime: AbortSignal | undefined;
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        lifetime = request.signal;
        request.signal.addEventListener('abort', () => lease.controller.abort(), { once: true });
        return attachmentOutcome(await request.attach(TEST_CONNECTION, lease));
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');
    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, controller.signal, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    controller.abort();
    expect(lifetime?.aborted).toBe(false);
    expect(lease.signal.aborted).toBe(false);
    await expect(authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    await harness.emit('session_shutdown');
    expect(lease.signal.aborted).toBe(true);
  });

  it.each([
    { operation: 'run' as const, args: ['open', 'https://example.com'] },
    { operation: 'skill' as const, skill: 'core' },
  ])('checks host execution safety before $operation invokes even executable discovery', async params => {
    const authorizationHost = {
      ...createAuthorizationHost(createLease()),
      checkExecution: vi.fn(() => { throw new Error('Unsupported inherited browser configuration.'); }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    await expect(harness.tools.get('browser').execute('blocked', params, undefined, undefined, harness.context)).rejects.toThrow('configuration');
    expect(harness.runtime.calls).toHaveLength(0);
    expect(authorizationHost.authorize).not.toHaveBeenCalled();
  });

  it('quarantines the root session after an unavailable authorization', async () => {
    const authorizationHost = createAuthorizationHost(createLease());
    const harness = await createHarness({ authorizationHost, failAttachment: true });
    const authorize = harness.tools.get('browser_authorize');
    const browser = harness.tools.get('browser');

    await authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    await expect(browser.execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context))
      .rejects.toThrow(/authorization|quarantined/u);
  });

  it('fails closed when the host attaches without a connection lease', async () => {
    const attachments: BrowserAuthorizationAttachment[] = [];
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        attachments.push(await request.attach(TEST_CONNECTION));
        return { status: 'authorized' as const };
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    expect(attachments).toMatchObject([{ ready: false }]);
    expect(harness.runtime.calls.some((call) => call.args[0] === 'open')).toBe(false);
    await expect(harness.tools.get('browser').execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context))
      .rejects.toThrow(/authorization|quarantined/u);
  });

  it('does not activate when the host claims authorization without attaching', async () => {
    const harness = await createHarness({
      authorizationHost: { authorize: vi.fn(async () => ({ status: 'authorized' as const })) },
    });
    const authorize = harness.tools.get('browser_authorize');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    expect(harness.runtime.calls.some((call) => call.args[0] === 'open')).toBe(false);
  });

  it('does not invoke native attachment commands with an already aborted lease', async () => {
    const lease = createLease();
    lease.controller.abort();
    const attachments: BrowserAuthorizationAttachment[] = [];
    let callsBeforeAttachment = 0;
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        callsBeforeAttachment = harness.runtime.calls.length;
        attachments.push(await request.attach(TEST_CONNECTION, lease));
        return { status: 'authorized' as const };
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    expect(attachments).toMatchObject([{ ready: false }]);
    expect(harness.runtime.calls).toHaveLength(callsBeforeAttachment);
    expect(harness.runtime.calls.some((call) => call.args[0] === 'open')).toBe(false);
  });

  it.each([
    { name: 'non-JSON output', response: result('connected') },
    { name: 'JSON failure', response: result('{"success":false,"error":"connection rejected"}') },
    { name: 'missing success', response: result('{"data":{"ok":true}}') },
    { name: 'non-boolean success', response: result('{"success":"true"}') },
    { name: 'a killed command', response: result('{"success":true}', 0, '', true) },
  ])('does not authorize an attachment with $name', async ({ response }) => {
    const lease = createLease();
    const attachments: BrowserAuthorizationAttachment[] = [];
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        attachments.push(await request.attach(TEST_CONNECTION, lease));
        return { status: 'authorized' as const };
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({
      authorizationHost,
      commands: { open: () => response },
    });
    const authorize = harness.tools.get('browser_authorize');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    expect(attachments).toMatchObject([{ ready: false }]);
    expect(harness.runtime.calls.filter((call) => call.args.includes('--pin-tab'))).toHaveLength(1);
    expect(harness.runtime.calls.filter((call) => call.args[0] === 'close')).toHaveLength(1);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'inactive wrapper', active: false, pid: 123 },
    { name: 'mismatched wrapper PID', active: true, pid: 456 },
  ])('rejects an attachment with an invalid session wrapper: $name', async ({ active, pid }) => {
    const lease = createLease();
    const harness = await createHarness({
      authorizationHost: createAuthorizationHost(lease),
      commands: {
        'session info': ({ session }) => session.active
          ? jsonSuccess({ active, pid, runtime: { backgroundPid: 123, browserLaunched: true }, runtimeError: null })
          : undefined,
      },
    });

    await expect(harness.tools.get('browser_authorize').execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])('never opens a second native connection for a duplicate callback (extra lease: %s)', async (extraLease) => {
    const lease = createLease();
    const duplicateLease = extraLease ? createLease() : lease;
    const attachments: BrowserAuthorizationAttachment[] = [];
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        attachments.push(...await Promise.all([
          request.attach(TEST_CONNECTION, lease),
          request.attach(TEST_CONNECTION, duplicateLease),
        ]));
        return { status: 'authorized' as const };
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: extraLease ? 'unavailable' : 'authorized' } });
    if (extraLease) {
      expect(attachments).toMatchObject([{ ready: false }, { ready: false }]);
      expect(harness.runtime.calls.some((call) => call.args[0] === 'open')).toBe(false);
      expect(lease.close).toHaveBeenCalledOnce();
      expect(lease.signal.aborted).toBe(true);
      expect(duplicateLease.close).toHaveBeenCalledOnce();
      expect(duplicateLease.signal.aborted).toBe(true);
    } else {
      expect(attachments).toMatchObject([{ ready: true }, { ready: false }]);
      expect(harness.runtime.calls.filter((call) => call.args[0] === 'open')).toHaveLength(1);
      expect(lease.close).not.toHaveBeenCalled();
    }
  });

  it('retains a rejected extra lease when its first cleanup fails', async () => {
    const lease = createLease();
    const extraLease = createLease();
    extraLease.close.mockRejectedValueOnce(new Error('lease cleanup failed'));
    const attachments: BrowserAuthorizationAttachment[] = [];
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        attachments.push(await request.attach(TEST_CONNECTION, lease));
        attachments.push(await request.attach(TEST_CONNECTION, extraLease));
        return attachmentOutcome(attachments[0]!);
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');

    await authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    await expect(authorize.execute('revoke', { operation: 'revoke' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'revoked' } });
    expect(attachments).toMatchObject([{ ready: true }, { ready: false }]);
    expect(extraLease.close).toHaveBeenCalledTimes(2);
    expect(extraLease.signal.aborted).toBe(true);
    expect(lease.signal.aborted).toBe(true);
    expect(harness.runtime.calls.filter((call) => call.args[0] === 'open')).toHaveLength(1);
  });

  it('captures connection metadata before the host can mutate it after calling attach', async () => {
    const lease = createLease();
    const connection = { ...TEST_CONNECTION } satisfies BrowserAuthorizationConnection;
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        const attachment = request.attach(connection, lease);
        connection.port = 9333;
        connection.webSocketPath = '/devtools/browser/mutated';
        return attachmentOutcome(await attachment);
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    const attachmentCalls = harness.runtime.calls.filter((call) => call.args.includes('--pin-tab'));
    expect(attachmentCalls).toHaveLength(1);
    expect(attachmentCalls[0]?.args).toEqual(expect.arrayContaining(['--cdp', 'ws://127.0.0.1:9222/devtools/browser/test']));
    expect(attachmentCalls[0]?.args).not.toContain('ws://127.0.0.1:9333/devtools/browser/mutated');
    await expect(harness.tools.get('browser').execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context))
      .resolves.toBeDefined();
    expect(lease.close).not.toHaveBeenCalled();
    await expect(authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
  });

  it.each([false, true])('shares one host request between same-origin authorizations (joined caller cancelled: %s)', async (cancelJoined) => {
    const lease = createLease();
    const controller = new AbortController();
    const hostEntered = deferred<BrowserAuthorizationRequest>();
    const releaseHost = deferred<void>();
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        hostEntered.resolve(request);
        await releaseHost.promise;
        return attachmentOutcome(await request.attach(TEST_CONNECTION, lease));
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');
    const first = authorize.execute('first', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    const request = await hostEntered.promise;
    let joinedOutcome: unknown;
    const second = authorize.execute('second', { operation: 'authorize', origin: 'https://example.com/path' }, controller.signal, undefined, harness.context)
      .then((outcome: unknown) => { joinedOutcome = outcome; return outcome; });
    try {
      if (cancelJoined) {
        controller.abort();
        await vi.waitFor(() => expect(joinedOutcome).toMatchObject({ details: { state: 'cancelled' } }));
        expect(request.signal.aborted).toBe(false);
        expect(lease.close).not.toHaveBeenCalled();
      }
    } finally {
      releaseHost.resolve();
    }

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { details: { state: 'authorized' } },
      { details: { state: cancelJoined ? 'cancelled' : 'authorized' } },
    ]);
    expect(authorizationHost.authorize).toHaveBeenCalledOnce();
    expect(harness.runtime.calls.filter((call) => call.args[0] === 'open')).toHaveLength(1);
    await expect(authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
  });

  it('rechecks target identity before activating a delayed host authorization', async () => {
    const lease = createLease();
    const hostAttached = deferred<BrowserAuthorizationAttachment>();
    const releaseHost = deferred<void>();
    let attachedSession: FakeBrowserSession | undefined;
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        const attachment = await request.attach(TEST_CONNECTION, lease);
        hostAttached.resolve(attachment);
        await releaseHost.promise;
        return attachmentOutcome(attachment);
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({
      authorizationHost,
      commands: { open: ({ session }) => { attachedSession = session; return undefined; } },
    });
    const authorize = harness.tools.get('browser_authorize');
    const pending = authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    const attachment = await hostAttached.promise;
    attachedSession!.targetId = 'changed-before-activation';
    releaseHost.resolve();

    expect(attachment).toMatchObject({ ready: true });
    await expect(pending).resolves.toMatchObject({ details: { state: 'unavailable' } });
    expect(lease.close).toHaveBeenCalledOnce();
    await expect(harness.tools.get('browser').execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context))
      .rejects.toThrow(/authorization|quarantined/u);
  });

  it('forwards cancellation to an in-flight native attachment and rejects its late success', async () => {
    const controller = new AbortController();
    const lease = createLease();
    const nativeEntered = deferred<void>();
    const releaseNative = deferred<ExecResult>();
    let nativeSignal: AbortSignal | undefined;
    const authorizationHost = createAuthorizationHost(lease);
    const harness = await createHarness({
      authorizationHost,
      commands: {
        open: ({ options }) => {
          nativeSignal = options?.signal;
          nativeEntered.resolve();
          return releaseNative.promise;
        },
      },
    });
    const authorize = harness.tools.get('browser_authorize');
    const pending = authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, controller.signal, undefined, harness.context);
    await nativeEntered.promise;
    controller.abort();
    const nativeAborted = nativeSignal?.aborted;
    const hostAborted = authorizationHost.authorize.mock.calls[0]?.[0].signal.aborted;
    releaseNative.resolve(jsonSuccess({ ok: true }));

    await expect(pending).resolves.toMatchObject({ details: { state: 'cancelled' } });
    expect(nativeAborted).toBe(true);
    expect(hostAborted).toBe(true);
    expect(lease.close).toHaveBeenCalledOnce();
    const status = await authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context);
    expect(status.details.state).not.toBe('authorized');
  });

  it('rejects a delayed attach callback after its authorization request is cancelled', async () => {
    const controller = new AbortController();
    const lease = createLease();
    const hostEntered = deferred<BrowserAuthorizationRequest>();
    const releaseHost = deferred<void>();
    const callbackFinished = deferred<BrowserAuthorizationAttachment>();
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        hostEntered.resolve(request);
        await releaseHost.promise;
        callbackFinished.resolve(await request.attach(TEST_CONNECTION, lease));
        return { status: 'authorized' as const };
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');
    const pending = authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, controller.signal, undefined, harness.context);
    const request = await hostEntered.promise;
    controller.abort();
    releaseHost.resolve();

    await expect(callbackFinished.promise).resolves.toMatchObject({ ready: false });
    await expect(pending).resolves.toMatchObject({ details: { state: 'cancelled' } });
    expect(request.signal.aborted).toBe(true);
    expect(harness.runtime.calls.some((call) => call.args[0] === 'open')).toBe(false);
    const status = await authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context);
    expect(status.details.state).not.toBe('authorized');
  });

  it('revokes an in-flight attachment without granting a late native success', async () => {
    const lease = createLease();
    const nativeEntered = deferred<void>();
    const releaseNative = deferred<ExecResult>();
    let nativeSignal: AbortSignal | undefined;
    const harness = await createHarness({
      authorizationHost: createAuthorizationHost(lease),
      commands: {
        open: ({ options }) => {
          nativeSignal = options?.signal;
          nativeEntered.resolve();
          return releaseNative.promise;
        },
      },
    });
    const authorize = harness.tools.get('browser_authorize');
    const pending = authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    await nativeEntered.promise;
    const revocation = authorize.execute('revoke', { operation: 'revoke' }, undefined, undefined, harness.context);
    try {
      await vi.waitFor(() => expect(nativeSignal?.aborted).toBe(true));
      expect(harness.runtime.calls.some((call) => call.args[0] === 'close')).toBe(false);
    } finally {
      releaseNative.resolve(jsonSuccess({ ok: true }));
    }

    await expect(revocation).resolves.toMatchObject({ details: { state: 'revoked' } });
    await expect(pending).resolves.toMatchObject({ details: { state: 'cancelled' } });
    await expect(authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'revoked' } });
    expect(lease.close).toHaveBeenCalledOnce();
    expect(harness.runtime.calls.filter((call) => call.args[0] === 'close')).toHaveLength(1);
    await expect(harness.tools.get('browser').execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context))
      .rejects.toThrow(/authorization|quarantined/u);
  });

  it('closes the lease on shutdown during executable discovery and rejects late success', async () => {
    const lease = createLease();
    const probeEntered = deferred<AbortSignal | undefined>();
    const releaseProbe = deferred<void>();
    const attachments: BrowserAuthorizationAttachment[] = [];
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        attachments.push(await request.attach(TEST_CONNECTION, lease));
        return { status: 'authorized' as const };
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({
      authorizationHost,
      onProbe: async (options) => {
        probeEntered.resolve(options?.signal);
        await releaseProbe.promise;
      },
    });
    const authorize = harness.tools.get('browser_authorize');
    const pending = authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    const probeSignal = await probeEntered.promise;
    try {
      await harness.emit('session_shutdown');
      expect(probeSignal?.aborted).toBe(true);
      expect(lease.close).toHaveBeenCalledOnce();
    } finally {
      releaseProbe.resolve();
    }

    await expect(authorizationHost.authorize.mock.results[0]!.value).resolves.toMatchObject({ status: 'authorized' });
    await expect(pending).resolves.toMatchObject({ details: { state: 'cancelled' } });
    expect(attachments).toMatchObject([{ ready: false }]);
    expect(lease.close).toHaveBeenCalledOnce();
    expect(lease.signal.aborted).toBe(true);
    expect(harness.runtime.calls.some((call) => call.args[0] === 'open' || call.args[0] === 'close')).toBe(false);
    const status = await authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context);
    expect(status.details.state).not.toBe('authorized');
    await expect(authorize.execute('authorize-after-shutdown', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'cancelled' } });
    expect(authorizationHost.authorize).toHaveBeenCalledOnce();
  });

  it('closes a pending attachment on shutdown without granting late native or host success', async () => {
    const lease = createLease();
    const nativeEntered = deferred<AbortSignal | undefined>();
    const releaseNative = deferred<ExecResult>();
    const attachments: BrowserAuthorizationAttachment[] = [];
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        attachments.push(await request.attach(TEST_CONNECTION, lease));
        return { status: 'authorized' as const };
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({
      authorizationHost,
      commands: {
        open: ({ options }) => {
          nativeEntered.resolve(options?.signal);
          return releaseNative.promise;
        },
      },
    });
    const authorize = harness.tools.get('browser_authorize');
    const pending = authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    const nativeSignal = await nativeEntered.promise;
    const shutdown = harness.emit('session_shutdown');
    try {
      await vi.waitFor(() => expect(nativeSignal?.aborted).toBe(true));
      expect(harness.runtime.calls.some((call) => call.args[0] === 'close')).toBe(false);
    } finally {
      releaseNative.resolve(jsonSuccess({ ok: true }));
    }

    await expect(shutdown).resolves.toBeUndefined();
    await expect(authorizationHost.authorize.mock.results[0]!.value).resolves.toMatchObject({ status: 'authorized' });
    await expect(pending).resolves.toMatchObject({ details: { state: 'cancelled' } });
    expect(attachments).toMatchObject([{ ready: false }]);
    expect(lease.close).toHaveBeenCalledOnce();
    expect(lease.signal.aborted).toBe(true);
    const attachmentCalls = harness.runtime.calls.filter((call) => call.args.includes('--pin-tab'));
    const closeCalls = harness.runtime.calls.filter((call) => call.args[0] === 'close');
    expect(attachmentCalls).toHaveLength(1);
    expect(closeCalls).toHaveLength(1);
    expect(cliScope(closeCalls[0])).toEqual(cliScope(attachmentCalls[0]));
    expect(harness.runtime.calls.some((call) => ['get cdp-url', 'tab list', 'get url'].includes(commandKey(call.args)))).toBe(false);
    const status = await authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context);
    expect(status.details.state).not.toBe('authorized');
    await expect(authorize.execute('authorize-after-shutdown', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'cancelled' } });
    expect(authorizationHost.authorize).toHaveBeenCalledOnce();
  });

  it('does not revoke another root session when the current session changes', async () => {
    const lease = createLease();
    const harness = await createHarness({ authorizationHost: createAuthorizationHost(lease) });
    const authorize = harness.tools.get('browser_authorize');
    const browser = harness.tools.get('browser');
    const originalContext = harness.contextFor('session-1');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, originalContext))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    const attachedScope = cliScope(harness.runtime.calls.find((call) => call.args.includes('--cdp')));
    harness.state.sessionId = 'session-2';
    await browser.execute('isolated-open', { operation: 'run', args: ['open', 'https://isolated.example'] }, undefined, undefined, harness.context);
    await authorize.execute('revoke-other', { operation: 'revoke' }, undefined, undefined, harness.context);

    expect(lease.close).not.toHaveBeenCalled();
    expect(harness.runtime.calls.filter((call) => call.args[0] === 'close').map(cliScope)).not.toContainEqual(attachedScope);
    await expect(authorize.execute('status-original', { operation: 'status' }, undefined, undefined, originalContext))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    await browser.execute('snapshot-original', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, originalContext);
    expect(cliScope(harness.runtime.calls.find((call) => call.args[0] === 'snapshot'))).toEqual(attachedScope);
  });

  it.each([
    { name: 'the same root session', sessionId: 'session-1' },
    { name: 'another root session', sessionId: 'session-2' },
  ])('does not let a revoked generation clean up a later grant in $name', async ({ sessionId }) => {
    const firstLease = createLease();
    const secondLease = createLease();
    const firstAttached = deferred<void>();
    const releaseFirstHost = deferred<void>();
    let hostRequests = 0;
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        if (++hostRequests === 1) {
          const attached = await request.attach(TEST_CONNECTION, firstLease);
          firstAttached.resolve();
          await releaseFirstHost.promise;
          return attachmentOutcome(attached);
        }
        return attachmentOutcome(await request.attach(TEST_CONNECTION, secondLease));
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');
    const firstContext = harness.contextFor('session-1');
    const first = authorize.execute('first', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, firstContext);
    await firstAttached.promise;
    await expect(authorize.execute('revoke-first', { operation: 'revoke' }, undefined, undefined, firstContext))
      .resolves.toMatchObject({ details: { state: 'revoked' } });
    harness.state.sessionId = sessionId;
    const second = await authorize.execute('second', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    releaseFirstHost.resolve();

    await expect(authorizationHost.authorize.mock.results[0]!.value).resolves.toMatchObject({ status: 'authorized' });
    await expect(first).resolves.toMatchObject({ details: { state: 'cancelled' } });
    expect(second).toMatchObject({ details: { state: 'authorized' } });
    expect(authorizationHost.authorize).toHaveBeenCalledTimes(2);
    const opens = harness.runtime.calls.filter((call) => call.args.includes('--pin-tab'));
    expect(opens).toHaveLength(2);
    expect(cliScope(opens[0])).not.toEqual(cliScope(opens[1]));
    expect(harness.runtime.calls.filter((call) => call.args[0] === 'close').map(cliScope)).toEqual([cliScope(opens[0])]);
    expect(firstLease.close).toHaveBeenCalledOnce();
    expect(secondLease.close).not.toHaveBeenCalled();
    await expect(authorize.execute('status-second', { operation: 'status' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    await harness.tools.get('browser').execute('snapshot-second', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context);
    expect(cliScope(harness.runtime.calls.find((call) => call.args[0] === 'snapshot'))).toEqual(cliScope(opens[1]));
  });

  it('blocks a newer generation resuming discovery while a revoked generation has an unclosed extra lease', async () => {
    const lease = createLease();
    const extraLease = createLease();
    const firstHostEntered = deferred<BrowserAuthorizationRequest>();
    const releaseFirstHost = deferred<void>();
    const probeEntered = deferred<void>();
    const releaseProbe = deferred<void>();
    const extraCloseEntered = deferred<void>();
    const releaseExtraClose = deferred<void>();
    extraLease.close.mockImplementation(async () => {
      extraCloseEntered.resolve();
      await releaseExtraClose.promise;
      extraLease.controller.abort();
    });
    let hostRequests = 0;
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => {
        if (++hostRequests === 1) {
          firstHostEntered.resolve(request);
          await releaseFirstHost.promise;
          return { status: 'authorized' as const };
        }
        return attachmentOutcome(await request.attach(TEST_CONNECTION, lease));
      }),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({
      authorizationHost,
      onProbe: async () => { probeEntered.resolve(); await releaseProbe.promise; },
    });
    const authorize = harness.tools.get('browser_authorize');
    const first = authorize.execute('first', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context);
    const oldRequest = await firstHostEntered.promise;
    await expect(authorize.execute('revoke-first', { operation: 'revoke' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'revoked' } });
    let secondOutcome: unknown;
    const second = authorize.execute('second', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context)
      .then((outcome: unknown) => { secondOutcome = outcome; return outcome; });
    await probeEntered.promise;
    const lateAttachment = oldRequest.attach(TEST_CONNECTION, extraLease);
    await extraCloseEntered.promise;
    releaseProbe.resolve();
    try {
      await vi.waitFor(() => expect(secondOutcome).toMatchObject({ details: { state: 'unavailable' } }));
      expect(extraLease.signal.aborted).toBe(false);
      expect(harness.runtime.calls.some((call) => call.args[0] === 'open')).toBe(false);
    } finally {
      releaseExtraClose.resolve();
      releaseFirstHost.resolve();
    }

    await expect(lateAttachment).resolves.toMatchObject({ ready: false });
    await expect(first).resolves.toMatchObject({ details: { state: 'cancelled' } });
    await expect(second).resolves.toMatchObject({ details: { state: 'unavailable' } });
    expect(extraLease.close).toHaveBeenCalledOnce();
    expect(extraLease.signal.aborted).toBe(true);
    expect(lease.close).toHaveBeenCalledOnce();
    expect(harness.runtime.calls.some((call) => call.args[0] === 'open')).toBe(false);
    const status = await authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context);
    expect(status.details.state).not.toBe('authorized');
  });

  it.each(['close', 'quit', 'exit'])('marks an attached %s as revoked and blocks runs but not skills', async (command) => {
    const lease = createLease();
    const harness = await createHarness({ authorizationHost: createAuthorizationHost(lease) });
    const authorize = harness.tools.get('browser_authorize');
    const browser = harness.tools.get('browser');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    await browser.execute('close', { operation: 'run', args: [command] }, undefined, undefined, harness.context);
    await expect(authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'revoked' } });
    await expect(browser.execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context))
      .rejects.toThrow(/authorization|quarantined/u);
    expect(harness.runtime.calls.some((call) => call.args[0] === 'snapshot')).toBe(false);
    expect(lease.close).toHaveBeenCalledOnce();
    expect(lease.signal.aborted).toBe(true);
    await expect(browser.execute('skill', { operation: 'skill', skill: 'core' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('# core skill from installed CLI') }] });
  });

  it.each([
    { operation: 'revoke', failure: 'nonzero exit', response: result('', 1, 'close failed') },
    { operation: 'revoke', failure: 'JSON failure', response: result('{"success":false,"error":"close failed"}') },
    { operation: 'revoke', failure: 'killed', response: result('{"success":true}', 0, '', true) },
    { operation: 'revoke', failure: 'daemon still active', response: result('{"success":true}') },
    { operation: 'close', failure: 'nonzero exit', response: result('', 1, 'close failed') },
    { operation: 'close', failure: 'JSON failure', response: result('{"success":false,"error":"close failed"}') },
    { operation: 'close', failure: 'killed', response: result('{"success":true}', 0, '', true) },
    { operation: 'close', failure: 'daemon still active', response: result('{"success":true}') },
  ])('marks authorization unavailable and blocks runs when $operation cleanup fails: $failure', async ({ operation, response }) => {
    const lease = createLease();
    const harness = await createHarness({
      authorizationHost: createAuthorizationHost(lease),
      commands: { close: () => response },
    });
    const authorize = harness.tools.get('browser_authorize');
    const browser = harness.tools.get('browser');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    if (operation === 'revoke') {
      await expect(authorize.execute('revoke', { operation: 'revoke' }, undefined, undefined, harness.context))
        .resolves.toMatchObject({ details: { state: 'unavailable' } });
    } else {
      await expect(browser.execute('close', { operation: 'run', args: ['close'] }, undefined, undefined, harness.context))
        .resolves.toMatchObject({ isError: true });
    }
    await expect(authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    await expect(browser.execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context))
      .rejects.toThrow(/authorization|quarantined/u);
    expect(harness.runtime.calls.some((call) => call.args[0] === 'snapshot')).toBe(false);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('does not confirm cleanup when an inactive session still reports a daemon PID', async () => {
    const lease = createLease();
    const harness = await createHarness({
      authorizationHost: createAuthorizationHost(lease),
      commands: {
        'session info': ({ session }) => session.active ? undefined : jsonSuccess({ active: false, pid: 123, runtime: null }),
      },
    });
    const authorize = harness.tools.get('browser_authorize');
    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    await expect(authorize.execute('revoke', { operation: 'revoke' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    await expect(authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it.each(['origin', 'target'] as const)('withholds output and screenshot reads after a postflight %s change', async (change) => {
    const harness = await createHarness({
      authorizationHost: createAuthorizationHost(createLease()),
      commands: {
        screenshot: ({ args, session, runtime }) => {
          if (change === 'origin') session.currentURL = 'https://other.example/private';
          else session.targetId = 'unexpected-target';
          const path = args.find((arg) => arg.endsWith('.png'))!;
          runtime.files.set(path, VALID_PNG_HEADER);
          return jsonSuccess({ path, text: 'PRIVATE_BROWSER_RESPONSE' });
        },
      },
    });
    const authorize = harness.tools.get('browser_authorize');
    const browser = harness.tools.get('browser');
    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    const readFile = vi.spyOn(harness.runtime, 'readFile');
    resizeImageMock.mockClear();

    const screenshot = browser.execute('screenshot', { operation: 'run', args: ['screenshot'] }, undefined, undefined, harness.context);
    await expect(screenshot).rejects.toThrow(/origin|target|authorization|quarantined/u);
    await expect(screenshot).rejects.not.toThrow('PRIVATE_BROWSER_RESPONSE');
    expect(harness.runtime.calls.filter((call) => call.args[0] === 'screenshot')).toHaveLength(1);
    expect(readFile).not.toHaveBeenCalled();
    expect(resizeImageMock).not.toHaveBeenCalled();
    const status = await authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context);
    expect(status.details.state).not.toBe('authorized');
    await expect(browser.execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context))
      .rejects.toThrow(/authorization|quarantined/u);
  });

  it('does not report or use authorization after the host lease aborts', async () => {
    const lease = createLease();
    const harness = await createHarness({ authorizationHost: createAuthorizationHost(lease) });
    const authorize = harness.tools.get('browser_authorize');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    lease.controller.abort();

    const status = await authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context);
    expect(status.details.state).not.toBe('authorized');
    await expect(harness.tools.get('browser').execute('snapshot', { operation: 'run', args: ['snapshot', '-i'] }, undefined, undefined, harness.context))
      .rejects.toThrow(/authorization|quarantined/u);
    expect(harness.runtime.calls.some((call) => call.args[0] === 'snapshot')).toBe(false);
  });

  it('revokes idempotently with exactly one native cleanup and one lease close', async () => {
    const lease = createLease();
    const harness = await createHarness({ authorizationHost: createAuthorizationHost(lease) });
    const authorize = harness.tools.get('browser_authorize');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    await expect(authorize.execute('revoke', { operation: 'revoke' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'revoked' } });
    await expect(authorize.execute('revoke-again', { operation: 'revoke' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'revoked' } });
    await expect(authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'revoked' } });
    const closeCalls = harness.runtime.calls.filter((call) => call.args[0] === 'close');
    expect(closeCalls).toHaveLength(1);
    expect(cliScope(closeCalls[0])).toEqual(cliScope(harness.runtime.calls.find((call) => call.args.includes('--cdp'))));
    const cleanupObservations = harness.runtime.calls.slice(harness.runtime.calls.indexOf(closeCalls[0]!) + 1)
      .filter((call) => commandKey(call.args) === 'session info');
    expect(cleanupObservations).toHaveLength(1);
    expect(cliScope(cleanupObservations[0])).toEqual(cliScope(closeCalls[0]));
    expect(lease.close).toHaveBeenCalledOnce();
    expect(lease.signal.aborted).toBe(true);
  });

  it('shares one cleanup retry between concurrent revocations after a failed close', async () => {
    const lease = createLease();
    const retryEntered = deferred<void>();
    const releaseRetry = deferred<void>();
    let closeAttempts = 0;
    const harness = await createHarness({
      authorizationHost: createAuthorizationHost(lease),
      commands: {
        close: async ({ session }) => {
          if (++closeAttempts === 1) return result('', 1, 'close failed');
          retryEntered.resolve();
          await releaseRetry.promise;
          session.active = false;
          return jsonSuccess({});
        },
      },
    });
    const authorize = harness.tools.get('browser_authorize');
    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'authorized' } });
    await expect(authorize.execute('failed-revoke', { operation: 'revoke' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    const first = authorize.execute('retry-first', { operation: 'revoke' }, undefined, undefined, harness.context);
    const second = authorize.execute('retry-second', { operation: 'revoke' }, undefined, undefined, harness.context);
    await retryEntered.promise;
    releaseRetry.resolve();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { details: { state: 'revoked' } },
      { details: { state: 'revoked' } },
    ]);
    expect(closeAttempts).toBe(2);
    expect(harness.runtime.calls.filter((call) => call.args[0] === 'close')).toHaveLength(2);
  });

  it('disconnects a failed existing-browser attachment before returning', async () => {
    const lease = createLease();
    const authorizationHost = createAuthorizationHost(lease);
    const harness = await createHarness({ authorizationHost, failAttachment: true });
    const authorize = harness.tools.get('browser_authorize');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    expect(harness.runtime.calls.filter((call) => call.args.includes('--pin-tab'))).toHaveLength(1);
    expect(harness.runtime.calls.filter((call) => call.args[0] === 'close')).toHaveLength(1);
    expect(lease.close).toHaveBeenCalledOnce();
  });

  it('rejects invalid host-provided connection metadata without invoking the CLI', async () => {
    const lease = createLease();
    const authorizationHost = {
      authorize: vi.fn(async (request: BrowserAuthorizationRequest) => attachmentOutcome(await request.attach({
        port: 9222,
        webSocketPath: '/devtools/page/not-browser',
      }, lease))),
    } satisfies BrowserAuthorizationHost;
    const harness = await createHarness({ authorizationHost });
    const authorize = harness.tools.get('browser_authorize');

    await expect(authorize.execute('authorize', { operation: 'authorize', origin: 'https://example.com' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'unavailable' } });
    expect(harness.runtime.calls.some((call) => call.args[0] === 'open')).toBe(false);
    expect(lease.close).toHaveBeenCalledOnce();
    await expect(authorize.execute('status', { operation: 'status' }, undefined, undefined, harness.context))
      .resolves.toMatchObject({ details: { state: 'blocked' } });
  });
});

const TEST_CONNECTION = {
  port: 9222,
  webSocketPath: '/devtools/browser/test',
} satisfies BrowserAuthorizationConnection;

function createLease() {
  const controller = new AbortController();
  const lease = {
    signal: controller.signal,
    close: vi.fn(async () => { controller.abort(); }),
  } satisfies BrowserAuthorizationLease;
  return { ...lease, controller };
}

function attachmentOutcome(attachment: BrowserAuthorizationAttachment): BrowserAuthorizationOutcome {
  return attachment.ready
    ? { status: 'authorized' }
    : { status: 'unavailable', ...(attachment.reason === undefined ? {} : { message: attachment.reason }) };
}

function createAuthorizationHost(lease: BrowserAuthorizationLease) {
  return {
    authorize: vi.fn(async (request: BrowserAuthorizationRequest) => attachmentOutcome(await request.attach(TEST_CONNECTION, lease))),
  } satisfies BrowserAuthorizationHost;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function cliScope(call: BrowserTestRuntime['calls'][number] | undefined) {
  expect(call).toBeDefined();
  const session = call!.args[call!.args.indexOf('--session') + 1];
  const namespace = call!.args[call!.args.indexOf('--namespace') + 1];
  expect(call!.args).toContain('--session');
  expect(call!.args).toContain('--namespace');
  expect(session).toBeTruthy();
  expect(namespace).toBeTruthy();
  return { session, namespace };
}

function commandKey(args: readonly string[]): string {
  return ['session', 'get', 'tab'].includes(args[0] ?? '') ? args.slice(0, 2).join(' ') : args[0] ?? '';
}

function jsonSuccess(data: Record<string, unknown>): ExecResult {
  return result(JSON.stringify({ success: true, data }));
}

interface FakeBrowserSession {
  active: boolean;
  currentURL: string;
  targetId: string;
  cdpUrl?: string;
}

type BrowserCommandHook = (call: {
  args: readonly string[];
  options: ExecOptions | undefined;
  session: FakeBrowserSession;
  runtime: BrowserTestRuntime;
}) => ExecResult | undefined | Promise<ExecResult | undefined>;

async function createHarness(options: {
  image?: boolean;
  onProbe?: (options: ExecOptions | undefined) => void | Promise<void>;
  onSkill?: () => void;
  authorizationHost?: BrowserAuthorizationHost;
  failAttachment?: boolean;
  commands?: Readonly<Record<string, BrowserCommandHook>>;
} = {}) {
  const state = { sessionId: 'session-1' };
  const browserSessions = new Map<string, FakeBrowserSession>();
  const runtime: BrowserTestRuntime = new BrowserTestRuntime(async (command, args, execOptions): Promise<ExecResult> => {
    if (command === 'agent-browser') {
      if (args[0] === '--version') {
        await options.onProbe?.(execOptions);
        return result('agent-browser 0.37.1');
      }
      if (args[0] === 'skills') {
        options.onSkill?.();
        return result('# core skill from installed CLI\nUse snapshot.');
      }
      const scopeKey = JSON.stringify([
        args[args.indexOf('--session') + 1],
        args[args.indexOf('--namespace') + 1],
      ]);
      let session = browserSessions.get(scopeKey);
      if (!session) {
        session = { active: false, currentURL: 'https://example.com', targetId: 'test-target' };
        browserSessions.set(scopeKey, session);
      }
      if (args[0] === 'open') {
        session.active = true;
        session.currentURL = args[1]!;
        if (args.includes('--cdp')) session.cdpUrl = args[args.indexOf('--cdp') + 1]!;
      }
      const key = commandKey(args);
      const override = await options.commands?.[key]?.({ args, options: execOptions, session, runtime });
      if (override !== undefined) return override;
      if (key === 'session info') return jsonSuccess(session.active
        ? { active: true, pid: 123, runtime: { backgroundPid: 123, browserLaunched: true }, runtimeError: null }
        : { active: false, pid: null, runtime: null });
      if (key === 'get cdp-url') return jsonSuccess({ cdpUrl: session.cdpUrl });
      if (key === 'tab list') return jsonSuccess({ tabs: [{ targetId: session.targetId, url: session.currentURL, active: true }] });
      if (key === 'get url') return jsonSuccess({ url: session.currentURL });
      if (args[0] === 'screenshot') {
        const path = args.find((arg, index) => index > 0 && arg.endsWith('.png'))!;
        runtime.files.set(path, VALID_PNG_HEADER);
        return jsonSuccess({ path });
      }
      if (args[0] === 'open' && args.includes('--cdp') && options.failAttachment) {
        return result('', 1, 'connection rejected');
      }
      if (args[0] === 'close') {
        session.active = false;
        return result('{"success":true}');
      }
      return jsonSuccess({ ok: true });
    }
    return result('', 127, 'not found');
  });
  const tools = new Map<string, any>();
  const capabilities: Array<{ id: string; instructions: string }> = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const createContext = (getSessionId: () => string) => ({
    model: {
      input: options.image === false ? ['text'] : ['text', 'image'],
    },
    sessionManager: { getSessionId },
  } as unknown as ExtensionContext);
  const context = createContext(() => state.sessionId);
  const pi = {
    runtime,
    registerCapability: (capability: { id: string; instructions: string }) => capabilities.push(capability),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as FelanExtensionAPI;

  await (options.authorizationHost ? createBrowserExtension({ authorizationHost: options.authorizationHost })(pi) : browserExtension(pi));
  return {
    runtime,
    tools,
    capabilities,
    context,
    state,
    contextFor: (sessionId: string) => createContext(() => sessionId),
    async emit(event: string, ctx = context): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    },
  };
}
