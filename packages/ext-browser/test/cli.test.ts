import type { AgentBrowserInvocation } from '../src/installer.js';
import { describe, expect, it } from 'vitest';
import { formatBrowserOutput } from '../src/boundary.js';
import {
  createBrowserAttachmentScope,
  createBrowserSessionScope,
  findBrowserCommand,
  MAX_BROWSER_OUTPUT_CHARACTERS,
  MAX_BROWSER_SKILL_OUTPUT_CHARACTERS,
  prepareBrowserCommand,
  runBrowserCli,
  runBrowserSkill,
} from '../src/cli.js';
import { validateAttachedBrowserCommand } from '../src/command-policy.js';
import { BrowserTestRuntime, result } from './test-runtime.js';

const invocation: AgentBrowserInvocation = {
  command: 'agent-browser',
  source: 'path',
  version: '0.37.1',
};
const attachmentEndpoint = 'ws://127.0.0.1:43111/felan-browser/fixture';

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

  it('requires browser authorization for existing-browser attachment', () => {
    const runtime = new BrowserTestRuntime();

    expect(() => prepareBrowserCommand(runtime, ['connect', '9222']))
      .toThrow('browser_authorize');
    expect(() => prepareBrowserCommand(runtime, ['open', 'https://example.com', '--auto-connect']))
      .toThrow('browser_authorize');
    expect(() => prepareBrowserCommand(runtime, ['open', 'https://example.com', '--cdp=9222']))
      .toThrow('browser_authorize');
    expect(() => prepareBrowserCommand(runtime, ['open', 'https://example.com', '--profile', 'Default']))
      .toThrow('owns --profile');
    expect(() => prepareBrowserCommand(runtime, ['open', 'https://example.com', '--state=auth.json']))
      .toThrow('owns --state');
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
      expect.stringMatching(/^\/session\/browser\/controls\/isolated\/[0-9a-f]{32}\/agent-browser\.json$/u),
    ]));
    expect(runtime.calls[0]?.options).toMatchObject({
      signal: controller.signal, timeout: 12_345, cwd: '/workspace', maxOutputBytes: MAX_BROWSER_OUTPUT_CHARACTERS * 4,
    });
    expect(readConfig(runtime)).toMatchObject({
      plugins: [], initScripts: [], enable: [], extensions: [], autoConnect: false,
      profile: null, state: null, restore: null, sessionName: null, restoreSave: 'never',
      restoreCheckUrl: null, restoreCheckText: null, restoreCheckFn: null,
      cdp: null, args: null, executablePath: null, provider: null, engine: null,
      allowFileAccess: false, pinTab: false, noWebmcp: true,
    });
  });

  it('creates an attachment scope distinct from ordinary browser work', () => {
    const runtime = new BrowserTestRuntime();
    const ordinary = createBrowserSessionScope(runtime, 'session-1');
    const attached = createBrowserAttachmentScope(runtime, 'session-1');

    expect(attached.namespace).toBe(ordinary.namespace);
    expect(attached.session).not.toBe(ordinary.session);
    expect(attached.session).toMatch(/^f-[0-9a-f]{16}$/u);
  });

  it('binds every attached command to its leased endpoint across CLI daemon respawn', async () => {
    const runtime = new BrowserTestRuntime(async () => result('{"success":true,"data":{}}'));
    await runBrowserCli(runtime, invocation, ['get', 'title'], createBrowserAttachmentScope(runtime, 'test'), {
      attached: true, attachmentEndpoint,
    });
    expect(runtime.calls[0]?.args).toEqual(expect.arrayContaining(['--cdp', attachmentEndpoint, '--no-webmcp']));
    expect(readConfig(runtime).cdp).toBeNull();
  });

  it('rejects an attached command without its leased endpoint before any execution', async () => {
    const runtime = new BrowserTestRuntime();
    await expect(runBrowserCli(runtime, invocation, ['get', 'title'], createBrowserAttachmentScope(runtime, 'test'), {
      attached: true,
    })).rejects.toThrow('leased endpoint');
    expect(runtime.calls).toHaveLength(0);
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
        '/session/browser/controls/skills/agent-browser.json',
      ]);
      return result('# current browser workflow');
    });
    const skill = await runBrowserSkill(runtime, invocation, 'core', true);

    expect(skill).toMatchObject({ stdout: '# current browser workflow', code: 0, killed: false });
    expect(runtime.calls[0]?.options).toMatchObject({
      timeout: 60_000, cwd: '/workspace', maxOutputBytes: MAX_BROWSER_SKILL_OUTPUT_CHARACTERS * 4,
    });
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

describe('public browser command policy', () => {
  it.each(['CONNECT', ' Connect', 'connect ', 'get url', 'Snapshot', 'snapshot\n', '', '--headed', 'open\0'])
    ('rejects a noncanonical command token %j without changing native dispatch', (command) => {
      const args = [command, 'https://example.com'];
      expect(findBrowserCommand(args)).toBeUndefined();
      expect(() => prepareBrowserCommand(new BrowserTestRuntime(), args)).toThrow('must start');
    });

  it.each([
    'state', 'auth', 'profile', 'profiles', 'restore', 'session', 'config',
    'addinitscript', 'removeinitscript', 'connect', 'autoconnect',
  ])('blocks %s globally', async (command) => {
    const runtime = new BrowserTestRuntime();
    const scope = createBrowserSessionScope(runtime, 'test');
    for (const options of [{}, { prepareScreenshot: false }, { attached: true }]) {
      await expect(runBrowserCli(runtime, invocation, [command, 'list'], scope, options)).rejects.toThrow();
    }
    expect(runtime.calls).toHaveLength(0);
    expect(runtime.sessionStorage.files.size).toBe(0);
  });

  it.each([
    '--profile', '--state', '--restore', '--restore-save', '--session-name',
    '--restore-check-url', '--restore-check-text', '--restore-check-fn', '--restore-check-unknown',
    '--cdp', '--auto-connect', '--autoconnect', '--session', '--namespace', '--idle-timeout',
    '--json', '--content-boundaries', '--max-output', '--config', '--allowed-domains',
    '--action-policy', '--confirm-actions', '--confirm-interactive', '--allow-file-access',
    '--pin-tab', '--no-pin-tab', '--no-auto-dialog', '--no-webmcp',
    '--executable-path', '--extension', '--init-script', '--enable', '--args',
    '--provider', '-p', '--engine', '--plugins', '--plugin',
  ])('blocks split and equals forms of %s, including native flag-looking text', async (option) => {
    const runtime = new BrowserTestRuntime();
    const scope = createBrowserSessionScope(runtime, 'test');
    for (const tail of [[option, 'value'], [`${option}=value`]]) {
      for (const args of [['open', 'https://example.com', ...tail], ['fill', '@e1', ...tail]]) {
        expect(() => prepareBrowserCommand(runtime, args)).toThrow();
        await expect(runBrowserCli(runtime, invocation, args, scope, { prepareScreenshot: false })).rejects.toThrow();
      }
    }
    expect(runtime.calls).toHaveLength(0);
  });

  it.each([
    '--headers', '--proxy', '--proxy-bypass', '--user-agent', '--device',
    '--color-scheme', '--download-path', '--screenshot-dir', '--screenshot-quality',
    '--screenshot-format', '--ca-cert', '--model',
  ])('prevents native global %s from consuming trailing session policy', async (option) => {
    const runtime = new BrowserTestRuntime();
    const scope = createBrowserSessionScope(runtime, 'test');
    for (const tail of [[option], [option, ''], [option, '--unknown'], [`${option}=value`]]) {
      await expect(runBrowserCli(runtime, invocation, ['open', 'https://example.com', ...tail], scope, {
        prepareScreenshot: false,
      })).rejects.toThrow();
    }
    expect(runtime.calls).toHaveLength(0);
    expect(runtime.sessionStorage.files.size).toBe(0);
    const args = ['open', 'https://example.com', option, 'value'];
    expect(prepareBrowserCommand(runtime, args).args).toEqual(args);
  });

  it('retains safe isolated browsing and literal positional text', () => {
    const runtime = new BrowserTestRuntime();
    for (const args of [
      ['open'], ['open', 'https://example.com', '--headed'], ['eval', 'document.title'],
      ['wait', '--fn', 'window.ready'], ['cookies', 'get'], ['storage', 'local', 'get'],
      ['tab', 'list'], ['network', 'requests'], ['console'], ['set', 'viewport', '1200', '800'],
      ['fill', '@e1', 'state auth --profile=Default'], ['fill', '@e1', ''],
    ]) expect(prepareBrowserCommand(runtime, args).args).toEqual(args);
    expect(() => prepareBrowserCommand(runtime, ['fill', '@e1', 'value\0'])).toThrow('NUL');
    for (const command of ['close', 'quit', 'exit']) {
      for (const option of ['--all', '--all=true', '-a']) {
        expect(() => prepareBrowserCommand(runtime, [command, option])).toThrow('only its own');
      }
    }
    expect(() => prepareBrowserCommand(runtime, ['fill', '@e1', '--', 'literal'])).toThrow('option terminator');
  });
});

describe('attached browser command policy', () => {
  const allowed = [
    ['open', 'https://example.com/path'], ['goto', 'https://example.com:443/path?q=1'],
    ['navigate', 'https://example.com/#section'], ['back'], ['forward'], ['reload'],
    ['close'], ['quit'], ['exit'], ['click', '@e1'], ['dblclick', '@e1'],
    ['hover', '@e1'], ['focus', '@e1'], ['check', '@e1'], ['uncheck', '@e1'],
    ['fill', '@e1', ''], ['fill', '@e1', 'STATE --fn is literal text'],
    ['type', '@e1', '-123', '--clear', '--delay', '20'],
    ['type', '@e1', '--delay', '0', 'Hello'], ['select', '@e1', 'a', 'b'], ['drag', '@e1', '@e2'],
    ['press', 'Control+a'], ['key', 'Enter'], ['keydown', 'Shift'], ['keyup', 'Shift'],
    ['keyboard', 'type', 'Hello world'], ['keyboard', 'inserttext', 'VALUE'], ['keyboard', 'insertText', 'text'],
    ['scroll'], ['scroll', 'down', '300'], ['scroll', '--selector', '#list', 'up', '300'],
    ['scrollintoview', '@e1'], ['scrollinto', '@e1'], ['highlight', '@e1'],
    ['snapshot', '-i', '-c', '-C', '-u', '-d', '3', '-s', '#main'],
    ['snapshot', '--interactive', '--compact', '--cursor', '--urls', '--depth', '0', '--selector', 'input[name="--cdp"]'],
    ['screenshot'], ['screenshot', '@e1', '--full', '--annotate', 'false'],
    ['screenshot', '-f', '--screenshot-format', 'jpeg', '--screenshot-quality', '80'],
    ['get', 'title'], ['get', 'url'], ['get', 'text', '@e1'], ['get', 'html', '@e1'],
    ['get', 'value', '@e1'], ['get', 'attr', '@e1', 'data-label'], ['get', 'count', 'input'],
    ['get', 'box', '@e1'], ['get', 'styles', '@e1'],
    ['is', 'visible', '@e1'], ['is', 'enabled', '@e1'], ['is', 'checked', '@e1'],
    ['find', 'role', 'button'], ['find', 'role', 'button', 'click', '--name', 'Save', '--exact'],
    ['find', 'text', 'Save', 'hover', '--exact'], ['find', 'label', 'Email', 'fill', 'a@b.com'],
    ['find', 'placeholder', 'Email', 'text'], ['find', 'alt', 'Logo', 'click'],
    ['find', 'title', 'Ready', 'check'], ['find', 'testid', 'submit', 'click'],
    ['find', 'first', 'button', 'click'], ['find', 'last', 'button', 'text'], ['find', 'nth', '-1', 'input', 'fill', 'hello'],
    ['mouse', 'move', '100', '200'], ['mouse', 'down'], ['mouse', 'up', 'left'], ['mouse', 'wheel', '-100', '5'],
    ['dialog', 'accept', 'hello'], ['dialog', 'dismiss'], ['dialog', 'status'],
    ['wait', '@e1'], ['wait', '100'], ['wait', '--url', '**/dashboard', '--timeout', '1000'],
    ['wait', '-u', '**/dashboard'], ['wait', '--load', 'networkidle'], ['wait', '-l', 'domcontentloaded'],
    ['wait', '--text', 'Ready'], ['wait', '-t', 'Ready'],
    ['read', '--raw', '--outline', '--filter', 'Heading', '--timeout', '1000'],
    ['a11y', '--tags', 'wcag2a', '-s', '#main'],
  ];

  it.each(allowed.map(args => ({ args })))('allows supported page arguments $args', async ({ args }) => {
    const runtime = new BrowserTestRuntime();
    validateAttachedBrowserCommand(args, 'https://example.com');
    const output = await runBrowserCli(runtime, invocation, args, createBrowserAttachmentScope(runtime, 'test'), { attached: true, attachmentEndpoint });
    expect(output.code).toBe(0);
    expect(runtime.calls[0]?.args.slice(0, args.length)).toEqual(args);
    if (['close', 'quit', 'exit'].includes(args[0]!)) {
      expect(runtime.calls[0]?.args).not.toContain('--cdp');
      expect(runtime.calls[0]?.args).not.toContain('--no-webmcp');
    } else expect(runtime.calls[0]?.args).toEqual(expect.arrayContaining(['--cdp', attachmentEndpoint, '--no-webmcp']));
  });

  const blocked = [
    ['eval', '1'], ['wait', '--fn', 'fetch("https://other.test")'], ['wait', '-f', 'true'],
    ['wait', '--fn=true'], ['wait', '-f=true'], ['wait', '--download', '/workspace/file'],
    ['wait', '-d'], ['wait', '--text', 'Ready', '--url', '**/done'],
    ['wait', '@e1', '--text', 'Ready'], ['wait', '--load', 'unknown'],
    ['wait', '--timeout', 'NaN', '@e1'], ['wait', '--text', '--fn', 'true'],
    ['cookies'], ['storage', 'local'], ['network', 'route', '*'], ['network', 'request', '1'],
    ['network', 'requests'], ['network', 'har', 'start'], ['console'], ['errors'],
    ['trace', 'start'], ['profiler', 'start'], ['record', 'start', '/tmp/capture.webm'],
    ['tab', 'list'], ['tab', 'new'], ['window', 'new'], ['frame', 'main'],
    ['clipboard', 'read'], ['inspect'], ['set', 'viewport', '1200', '800'],
    ['set', 'credentials', 'user', 'password'], ['get', 'cdp-url'],
    ['session', 'info'], ['auth', 'list'], ['state', 'save', '/tmp/state.json'],
    ['batch', 'snapshot'], ['webmcp', 'list'], ['plugin', 'run', 'test', 'command.run'],
    ['download', '@e1', '/tmp/out'], ['upload', '@e1', '/tmp/in'], ['pdf', '/tmp/out.pdf'],
    ['read', 'https://example.com'], ['read', '--llms', 'full'], ['read', '--require-md'],
    ['a11y', 'https://other.test'], ['vitals', 'https://other.test'], ['diff', 'url', 'a', 'b'],
    ['pushstate', '/other'], ['removeinitscript', '1'], ['future-command'],
    ['get', 'URL'], ['get', ' url'], ['get', 'unknown'], ['get', 'url', 'extra'],
    ['keyboard', 'InsertText', 'value'], ['keyboard', 'eval', '1'],
    ['find', 'role', 'button', 'eval', '1'], ['find', 'role', 'button', 'type', 'text'],
    ['find', 'ROLE', 'button', 'click'], ['find', 'role', 'button', '--name', 'Save'],
    ['find', 'role', 'button', '--exact', 'click'], ['find', 'nth', '1', 'button', 'click', '--exact'],
    ['find', 'label', 'Email', 'fill'], ['find', 'text', 'Go', 'click', 'unexpected'],
    ['type', '--delay', '10', '@e1', 'hello'], ['mouse', 'unknown'], ['mouse', 'move', 'NaN', '1'],
    ['dialog', 'unknown'], ['scroll', 'sideways'], ['scroll', 'down', 'NaN'],
    ['snapshot', 'eval'], ['snapshot', '--unknown'], ['snapshot', '-x'], ['snapshot', '--DEPTH', '1'],
    ['snapshot', '--depth=1'], ['snapshot', '--depth'], ['snapshot', '-d', '-1'],
    ['snapshot', '--selector', '--cdp', '9222'], ['snapshot', '--selector', '--unknown'],
    ['snapshot', '--interactive', '--interactive'], ['snapshot', '--', '--unknown'],
    ['click', '@e1', '--new-tab'], ['click', '@e1', '--new-tab=true'],
    ['close', '--all'], ['exit', '--all=true'], ['quit', '-a'],
    ['screenshot', '/workspace/custom.png'], ['screenshot', './custom.png'],
    ['screenshot', '@e1', '/workspace/custom.png'], ['screenshot', '--screenshot-dir', '/tmp'],
    ['screenshot', '--screenshot-format=jpeg'], ['screenshot', '--screenshot-format', 'webp'],
    ['screenshot', '--screenshot-quality', '101'], ['screenshot', '--quality', '80'],
    ['open'], ['goto', 'example.com'], ['navigate', '/path'], ['open', 'javascript:alert(1)'],
    ['open', 'https://example.com', '--headed'], ['open', 'https://example.com', '--headers', '{}'],
  ];

  it.each(blocked.map(args => ({ args })))('rejects attached escape or ambiguous arguments $args before I/O', async ({ args }) => {
    const runtime = new BrowserTestRuntime();
    const scope = createBrowserAttachmentScope(runtime, 'test');
    expect(() => validateAttachedBrowserCommand(args, 'https://example.com')).toThrow();
    for (const prepareScreenshot of [true, false]) {
      await expect(runBrowserCli(runtime, invocation, args, scope, { attached: true, prepareScreenshot })).rejects.toThrow();
    }
    expect(runtime.calls).toHaveLength(0);
    expect(runtime.sessionStorage.files.size).toBe(0);
  });

  it.each([
    '--headed', '--proxy', '--proxy-bypass', '--engine', '--provider', '-p', '--user-agent',
    '--device', '--model', '--headers', '--color-scheme', '--download-path', '--debug',
    '--screenshot-dir', '--init-script', '--enable', '--args', '--executable-path',
    '--pin-tab', '--no-pin-tab', '--config', '--ca-cert', '--no-ca-cert', '--webgpu',
    '--ignore-https-errors', '--hide-scrollbars', '--help', '-h', '--version', '-V',
  ])('rejects attached global override %s in split and equals forms', (option) => {
    for (const tail of [[option, 'value'], [`${option}=value`]]) {
      expect(() => validateAttachedBrowserCommand(['snapshot', ...tail])).toThrow();
    }
  });

  it.each([
    'http://example.com', 'https://other.test', 'https://example.com:444',
    'https://example.com.other.test', 'https://example.com@other.test',
    'https://user:password@example.com', ' https://example.com', 'https://example.com\n',
    'https://example.com\\@other.test', 'data:text/html,test', 'file:///tmp/page.html',
    '//example.com',
  ])('rejects navigation outside the exact origin or ambiguous URL %j', (target) => {
    for (const command of ['open', 'goto', 'navigate']) {
      expect(() => validateAttachedBrowserCommand([command, target], 'https://example.com')).toThrow();
    }
  });

  it('retains the explicit trusted path for private observations and close', async () => {
    const runtime = new BrowserTestRuntime();
    const scope = createBrowserAttachmentScope(runtime, 'test');
    for (const args of [
      ['open', 'https://example.com', '--cdp', 'ws://127.0.0.1:1/devtools/browser/test', '--pin-tab', '--no-auto-dialog'],
      ['session', 'info'], ['get', 'cdp-url'], ['tab', 'list'], ['close'],
    ]) {
      const observation = ['get', 'tab'].includes(args[0]!);
      await runBrowserCli(runtime, invocation, args, scope, { internalAttachment: true, ...(observation ? { attachmentEndpoint } : {}) });
      expect(runtime.calls.at(-1)?.args.slice(0, args.length)).toEqual(args);
      if (observation) expect(runtime.calls.at(-1)?.args).toContain('--cdp');
      else expect(runtime.calls.at(-1)?.args).not.toContain('--no-webmcp');
    }
    expect(new Set(runtime.calls.map((_call, index) => configPath(runtime, index))).size).toBe(1);
    expect(readConfig(runtime)).toMatchObject({ pinTab: true, noAutoDialog: true, noWebmcp: false, engine: null, args: null });
  });
});

describe('browser configuration, screenshot, and execution boundaries', () => {
  it('separates skills, isolated scopes, and every attachment scope without changing another control file', async () => {
    const runtime = new BrowserTestRuntime();
    const first = createBrowserAttachmentScope(runtime, 'test');
    const second = createBrowserAttachmentScope(runtime, 'test');
    await runBrowserCli(runtime, invocation, ['snapshot'], first, { attached: true, attachmentEndpoint });
    const attachedPath = configPath(runtime);
    const attachedConfig = runtime.sessionStorage.files.get(attachedPath.slice('/session/'.length))!.slice();
    await runBrowserSkill(runtime, invocation, 'core', true);
    await runBrowserCli(runtime, invocation, ['snapshot'], first);
    await runBrowserCli(runtime, invocation, ['snapshot'], second, { attached: true, attachmentEndpoint });
    await runBrowserCli(runtime, invocation, ['snapshot'], second);
    expect(new Set(runtime.calls.map((_call, index) => configPath(runtime, index))).size).toBe(5);
    expect(attachedPath).toMatch(/\/controls\/attached\/[0-9a-f]{32}\/agent-browser\.json$/u);
    expect(runtime.sessionStorage.files.get(attachedPath.slice('/session/'.length))).toEqual(attachedConfig);
    expect(readConfig(runtime, 1)).toMatchObject({ pinTab: false, plugins: [] });
    expect(readConfig(runtime, 2)).toMatchObject({ pinTab: false, plugins: [] });
    await runBrowserCli(runtime, invocation, ['snapshot'], first, { attached: true, attachmentEndpoint });
    expect(configPath(runtime, 5)).toBe(attachedPath);
  });

  it('hashes scope identifiers rather than interpolating paths', async () => {
    const runtime = new BrowserTestRuntime();
    await runBrowserCli(runtime, invocation, ['snapshot'], { namespace: '../skills', session: '../../../other' });
    expect(configPath(runtime)).toMatch(/^\/session\/browser\/controls\/isolated\/[0-9a-f]{32}\/agent-browser\.json$/u);
  });

  it('stages selectors and consumes option values exactly as native screenshot parsing does', () => {
    const runtime = new BrowserTestRuntime();
    for (const args of [
      ['screenshot', '@e1'], ['screenshot', '#main'], ['screenshot', '.hidden.png'],
      ['screenshot', '#a[href="/"]', '--full'], ['screenshot', '--annotate', 'false'],
      ['screenshot', '--headed', 'false', '--hide-scrollbars', 'true'],
      ['screenshot', '--screenshot-quality', '80', '--screenshot-dir', '/tmp'],
    ]) {
      const prepared = prepareBrowserCommand(runtime, args);
      expect(prepared.generatedScreenshotPath).toMatch(/\/browser\/screenshots\/screenshot-.+\.png$/u);
      expect(prepared.args).toEqual([...args, prepared.generatedScreenshotPath]);
    }
    expect(prepareBrowserCommand(runtime, ['screenshot', '--screenshot-format', 'jpeg']).generatedScreenshotPath).toMatch(/\.jpeg$/u);
    for (const args of [
      ['screenshot', './custom.png'], ['screenshot', '../custom.png'],
      ['screenshot', '/workspace/custom.png'], ['screenshot', 'C:\\images\\custom.png'],
      ['screenshot', '@e1', '/workspace/custom.png', '--full'],
    ]) expect(prepareBrowserCommand(runtime, args)).toEqual({ args });
  });

  it('makes prepareScreenshot false suppress staging, not public validation', async () => {
    const runtime = new BrowserTestRuntime();
    const scope = createBrowserSessionScope(runtime, 'test');
    const output = await runBrowserCli(runtime, invocation, ['screenshot', '@e1'], scope, { prepareScreenshot: false });
    expect(output.generatedScreenshotPath).toBeUndefined();
    expect(runtime.calls[0]?.args).not.toEqual(expect.arrayContaining([expect.stringMatching(/screenshot-.+\.png/u)]));
    for (const args of [
      ['screenshot', '--unknown'], ['screenshot', '--screenshot-format=jpeg'],
      ['screenshot', '--screenshot-quality'], ['screenshot', '--screenshot-format', 'webp'],
      ['screenshot', '@e1', 'path.png', 'extra'], ['open', '--', '--cdp', '9222'],
    ]) await expect(runBrowserCli(runtime, invocation, args, scope, { prepareScreenshot: false })).rejects.toThrow();
    expect(runtime.calls).toHaveLength(1);
  });

  it('propagates the runtime byte-truncation signal even for short output', async () => {
    const runtime = new BrowserTestRuntime(async () => ({ ...result('partial'), truncated: true }));
    const scope = createBrowserSessionScope(runtime, 'test');
    expect(await runBrowserCli(runtime, invocation, ['get', 'url'], scope)).toMatchObject({ stdout: 'partial', outputTruncated: true });
    expect(await runBrowserSkill(runtime, invocation, 'core', true)).toMatchObject({ stdout: 'partial', outputTruncated: true });
    expect(runtime.calls[0]?.options).toMatchObject({ maxOutputBytes: MAX_BROWSER_OUTPUT_CHARACTERS * 4 });
    expect(runtime.calls[1]?.options).toMatchObject({ maxOutputBytes: MAX_BROWSER_SKILL_OUTPUT_CHARACTERS * 4 });
  });

  it('bounds stdout, stderr, and thrown failures for run and skill', async () => {
    for (const throws of [true, false]) {
      const runtime = new BrowserTestRuntime(async () => {
        if (throws) throw new Error('x'.repeat(200_000));
        return result('x'.repeat(200_000), 0, 'y'.repeat(200_000));
      });
      const scope = createBrowserSessionScope(runtime, 'test');
      const run = await runBrowserCli(runtime, invocation, ['snapshot'], scope);
      const skill = await runBrowserSkill(runtime, invocation, 'core', true);
      for (const [output, maximum] of [[run, MAX_BROWSER_OUTPUT_CHARACTERS], [skill, MAX_BROWSER_SKILL_OUTPUT_CHARACTERS]] as const) {
        expect(output.outputTruncated).toBe(true);
        expect(output.stdout.length).toBeLessThanOrEqual(maximum);
        expect(output.stderr.length).toBeLessThanOrEqual(maximum);
        expect(output.stderr).toContain('[truncated by Felan]');
      }
    }
  });

  it('does not execute or write config when already cancelled', async () => {
    const runtime = new BrowserTestRuntime();
    const scope = createBrowserSessionScope(runtime, 'test');
    const signal = AbortSignal.abort(new Error('cancelled'));
    await expect(runBrowserCli(runtime, invocation, ['screenshot'], scope, { signal })).rejects.toThrow('cancelled');
    await expect(runBrowserSkill(runtime, invocation, 'core', true, signal)).rejects.toThrow('cancelled');
    expect(runtime.calls).toHaveLength(0);
    expect(runtime.sessionStorage.files.size).toBe(0);
  });

  it('rechecks cancellation after asynchronous setup and marks interrupted exec failures killed', async () => {
    const controller = new AbortController();
    const runtime = new BrowserTestRuntime(async () => {
      controller.abort(new Error('cancelled'));
      throw new Error('interrupted');
    });
    const scope = createBrowserSessionScope(runtime, 'test');
    expect(await runBrowserCli(runtime, invocation, ['snapshot'], scope, { signal: controller.signal }))
      .toMatchObject({ code: 1, killed: true, stderr: 'interrupted' });

    const setupController = new AbortController();
    const setupRuntime = new BrowserTestRuntime();
    const originalWrite = setupRuntime.sessionStorage.writeFile.bind(setupRuntime.sessionStorage);
    setupRuntime.sessionStorage.writeFile = async (path, content) => {
      await originalWrite(path, content);
      setupController.abort(new Error('cancelled during setup'));
    };
    expect(await runBrowserCli(setupRuntime, invocation, ['snapshot'], scope, { signal: setupController.signal }))
      .toMatchObject({ code: 1, killed: true });
    expect(setupRuntime.calls).toHaveLength(0);
  });

  it('marks late runtime success killed when its caller has cancelled', async () => {
    for (const skill of [false, true]) {
      const controller = new AbortController();
      const runtime = new BrowserTestRuntime(async () => {
        controller.abort();
        return result('late success');
      });
      const output = skill
        ? await runBrowserSkill(runtime, invocation, 'core', true, controller.signal)
        : await runBrowserCli(runtime, invocation, ['snapshot'], createBrowserSessionScope(runtime, 'test'), { signal: controller.signal });
      expect(output.killed).toBe(true);
    }
  });

  it('validates skill names for direct helper callers before I/O', async () => {
    const runtime = new BrowserTestRuntime();
    for (const skill of ['../core', '--cdp', '--config=other', 'core --full', 'Core', ' core', 'core\0']) {
      await expect(runBrowserSkill(runtime, invocation, skill, true)).rejects.toThrow('Invalid browser skill');
    }
    expect(runtime.calls).toHaveLength(0);
    expect(runtime.sessionStorage.files.size).toBe(0);
  });
});

function configPath(runtime: BrowserTestRuntime, call = 0): string {
  const args = runtime.calls[call]!.args;
  return args[args.indexOf('--config') + 1]!;
}

function readConfig(runtime: BrowserTestRuntime, call = 0): Record<string, unknown> {
  const path = configPath(runtime, call).slice('/session/'.length);
  return JSON.parse(new TextDecoder().decode(runtime.sessionStorage.files.get(path)!));
}
