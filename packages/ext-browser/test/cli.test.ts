import type { AgentBrowserInvocation } from '../src/installer.js';
import { describe, expect, it } from 'vitest';
import { formatBrowserOutput } from '../src/boundary.js';
import {
  createBrowserSessionScope,
  prepareBrowserCommand,
  runBrowserCli,
  runBrowserSkill,
} from '../src/cli.js';
import { BrowserTestRuntime, result } from './test-runtime.js';

const invocation: AgentBrowserInvocation = {
  command: 'agent-browser',
  source: 'path',
  version: '0.31.1',
};

describe('browser CLI adapter', () => {
  it('stages bare screenshots in session storage for direct image delivery', () => {
    const runtime = new BrowserTestRuntime();
    const prepared = prepareBrowserCommand(runtime, ['screenshot', '--full']);

    expect(prepared.generatedScreenshotPath).toMatch(/^\/session\/browser\/screenshots\/screenshot-.+\.png$/u);
    expect(prepared.args[0]).toBe('screenshot');
    expect(prepared.args.at(-1)).toBe(prepared.generatedScreenshotPath);
    expect(prepared.args).toContain('--full');

    const explicit = prepareBrowserCommand(runtime, ['screenshot', '--full', '/workspace/custom.png']);
    expect(explicit.args).toEqual(['screenshot', '--full', '/workspace/custom.png']);
    expect(explicit.generatedScreenshotPath).toBeUndefined();
  });

  it('blocks model-side setup, plugin, server, and raw skill commands', () => {
    const runtime = new BrowserTestRuntime();
    for (const args of [
      ['install'],
      ['upgrade'],
      ['doctor'],
      ['mcp'],
      ['stream', 'enable'],
      ['plugin', 'add', 'example'],
      ['plugins', 'add', 'example'],
      ['batch', 'open https://example.com'],
      ['confirm', 'action-1'],
      ['deny', 'action-1'],
      ['skills', 'get', 'core'],
    ]) {
      expect(() => prepareBrowserCommand(runtime, args)).toThrow();
    }
    expect(() => prepareBrowserCommand(runtime, ['--headed', 'open', 'https://example.com']))
      .toThrow('must start');
    expect(() => prepareBrowserCommand(runtime, ['open', 'https://example.com', '--session=other']))
      .toThrow('owns --session');
    expect(() => prepareBrowserCommand(runtime, ['open', 'https://example.com', '--config', './agent-browser.json']))
      .toThrow('owns --config');
    expect(() => prepareBrowserCommand(runtime, ['open', 'https://example.com', '--allowed-domains=*']))
      .toThrow('owns --allowed-domains');
    expect(() => prepareBrowserCommand(runtime, ['open', 'https://example.com', '--']))
      .toThrow('option terminator');
    expect(() => prepareBrowserCommand(runtime, ['close', '--all']))
      .toThrow('only its own');
    expect(() => prepareBrowserCommand(runtime, ['quit', '--all']))
      .toThrow('only its own');
  });

  it('allows explicitly requested browser attachment and authentication state options', () => {
    const runtime = new BrowserTestRuntime();

    expect(prepareBrowserCommand(runtime, ['connect', '9222']).args)
      .toEqual(['connect', '9222']);
    expect(prepareBrowserCommand(runtime, ['open', 'https://example.com', '--auto-connect']).args)
      .toEqual(['open', 'https://example.com', '--auto-connect']);
    expect(prepareBrowserCommand(runtime, ['open', 'https://example.com', '--profile', 'Default']).args)
      .toEqual(['open', 'https://example.com', '--profile', 'Default']);
    expect(prepareBrowserCommand(runtime, ['open', 'https://example.com', '--state=auth.json']).args)
      .toEqual(['open', 'https://example.com', '--state=auth.json']);
  });

  it('passes literal args, enforced session policy, bounded JSON output, and cancellation', async () => {
    const runtime = new BrowserTestRuntime(async () => result('{"success":true,"data":{"ok":true}}'));
    const scope = createBrowserSessionScope(runtime, 'session-1');
    expect(scope).toEqual({
      session: expect.stringMatching(/^f-[0-9a-f]{16}$/u),
      namespace: expect.stringMatching(/^f-[0-9a-f]{16}$/u),
    });
    const controller = new AbortController();
    const executed = await runBrowserCli(
      runtime,
      invocation,
      ['open', 'https://example.com', '--headed'],
      scope,
      { signal: controller.signal, timeoutMs: 12_345 },
    );

    expect(executed).toMatchObject({ code: 0, killed: false, outputTruncated: false });
    expect(runtime.calls[0]?.args).toEqual(expect.arrayContaining([
      'open',
      'https://example.com',
      '--headed',
      '--session',
      scope.session,
      '--namespace',
      scope.namespace,
      '--idle-timeout',
      '1h',
      '--json',
      '--content-boundaries',
      '--max-output',
      '44000',
      '--config',
      '/session/browser/agent-browser.json',
    ]));
    expect(runtime.calls[0]?.options).toMatchObject({ signal: controller.signal, timeout: 12_345, cwd: '/workspace' });
    expect(new TextDecoder().decode(runtime.sessionStorage.files.get('browser/agent-browser.json')!))
      .toBe('{"plugins":[]}\n');
  });

  it('does not attach model-selected screenshot paths', async () => {
    const runtime = new BrowserTestRuntime(async () => result('{"success":true,"data":{"path":"/workspace/custom.png"}}'));
    const scope = createBrowserSessionScope(runtime, 'session-1');
    const executed = await runBrowserCli(runtime, invocation, ['screenshot', '/workspace/custom.png'], scope);

    expect(executed.generatedScreenshotPath).toBeUndefined();
  });

  it('does not treat arbitrary CLI output as a screenshot path', async () => {
    const runtime = new BrowserTestRuntime(async () => result(JSON.stringify({
      success: true,
      data: {
        text: '/workspace/secret.png',
        path: '/workspace/actual.png',
      },
    })));
    const scope = createBrowserSessionScope(runtime, 'session-1');
    const executed = await runBrowserCli(runtime, invocation, ['screenshot', '/workspace/actual.png'], scope);

    expect(executed.generatedScreenshotPath).toBeUndefined();

    const nonScreenshot = await runBrowserCli(runtime, invocation, ['get', 'url'], scope);
    expect(nonScreenshot.generatedScreenshotPath).toBeUndefined();
  });

  it('retrieves skill text without turning it into a browser daemon command', async () => {
    const runtime = new BrowserTestRuntime(async (_command, args) => {
      expect(args).toEqual([
        'skills',
        'get',
        'core',
        '--full',
        '--max-output',
        '100000',
        '--config',
        '/session/browser/agent-browser.json',
      ]);
      return result('# current browser workflow');
    });
    const skill = await runBrowserSkill(runtime, invocation, 'core', true);

    expect(skill).toMatchObject({ stdout: '# current browser workflow', code: 0, killed: false });
    expect(runtime.calls[0]?.options).toMatchObject({ timeout: 60_000, cwd: '/workspace' });
  });

  it('preserves the reviewed full core skill while retaining a hard output bound', async () => {
    const fullSkill = 'x'.repeat(90_000);
    const runtime = new BrowserTestRuntime(async () => result(fullSkill));

    const skillResult = await runBrowserSkill(runtime, invocation, 'core', true);
    expect(skillResult).toMatchObject({
      stdout: fullSkill,
      outputTruncated: false,
    });
    expect(formatBrowserOutput('skill', { name: 'core', stdout: skillResult.stdout }))
      .not.toContain('[truncated by Felan]');
  });
});
