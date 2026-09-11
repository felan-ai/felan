import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';

const VERSION = '0.37.1';
const MAX_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 8_000;
const SESSION_KEYS = ['active', 'namespace', 'pid', 'runtime', 'runtimeError', 'session', 'socketDir', 'version'];
const RUNTIME_KEYS = [
  'backgroundPid', 'browserLaunched', 'compatibilityStatus', 'effectiveLaunch', 'engine',
  'launchHash', 'lifecycle', 'namespace', 'pageCount', 'restoreCheckFn', 'restoreCheckText',
  'restoreCheckUrl', 'restoreKey', 'restoreLoadedPath', 'restoreSave', 'restoreSavedPath',
  'restoreStatus', 'restoreStatusDetail', 'restoreValidationPending', 'saveStatus', 'session', 'socketDir',
].sort();
const utf8 = new TextDecoder('utf-8', { fatal: true });

class FixtureFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function check(condition, code) {
  if (!condition) throw new FixtureFailure(code);
}

function failureName(error) {
  if (error instanceof FixtureFailure) return error.code;
  return typeof error?.code === 'string' && /^E[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : 'unexpected_fixture_error';
}

function keysEqual(value, expected) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

async function deadline(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new FixtureFailure(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate, code) {
  const end = Date.now() + COMMAND_TIMEOUT_MS;
  while (!await predicate()) {
    check(Date.now() < end, code);
    await delay(20);
  }
}

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function reviewedBinary(path) {
  check(['darwin', 'linux'].includes(process.platform), 'unsupported_platform_requires_unix_sockets');
  check(['arm64', 'x64'].includes(process.arch), 'unsupported_architecture');
  const installer = await readFile(new URL('../packages/ext-browser/src/installer.ts', import.meta.url), 'utf8');
  check(installer.match(/export const MANAGED_AGENT_BROWSER_VERSION = '([^']+)';/u)?.[1] === VERSION,
    'reviewed_source_version_changed');
  const assets = installer.match(/const REVIEWED_ASSETS = \{([^}]+)\} as const;/u)?.[1];
  check(assets, 'reviewed_asset_table_unavailable');
  const musl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
  const name = `agent-browser-${process.platform}-${musl ? 'musl-' : ''}${process.arch}`;
  const digest = assets.match(new RegExp(`'${name}': '([a-f0-9]{64})'`, 'u'))?.[1];
  check(digest, 'reviewed_platform_digest_unavailable');
  const metadata = await stat(path);
  check(metadata.isFile() && metadata.size > 0 && metadata.size <= 128 * 1024 * 1024, 'invalid_binary_file');
  const bytes = await readFile(path);
  check(createHash('sha256').update(bytes).digest('hex') === digest, 'binary_digest_mismatch');
  return bytes;
}

function spawnOwned(context, args, env, timeout = COMMAND_TIMEOUT_MS, cleanup = false) {
  check(!context.globalSignal?.aborted || cleanup, 'fixture_interrupted');
  const child = spawn(context.binary, args, { cwd: context.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const record = { child, done: false, stdout: '', stderr: '', failure: undefined };
  context.children.push(record);
  const timer = setTimeout(() => {
    record.failure ??= 'child_timeout';
    if (!record.done) child.kill('SIGKILL');
  }, timeout);
  let size = 0;
  for (const channel of ['stdout', 'stderr']) {
    child[channel].on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BYTES) {
        record.failure ??= 'child_output_limit';
        child.kill('SIGKILL');
      } else {
        record[channel] += chunk.toString('utf8');
      }
    });
  }
  child.on('error', () => { record.failure ??= 'child_spawn_failed'; });
  record.result = new Promise((resolveResult) => {
    child.once('close', (code, signal) => {
      record.done = true;
      clearTimeout(timer);
      resolveResult({ code, signal });
    });
  });
  return record;
}

async function cli(context, args) {
  const record = spawnOwned(context, [...context.flags, ...args], context.env);
  const result = await deadline(record.result, COMMAND_TIMEOUT_MS + 1_000, 'cli_exit_timeout');
  check(!record.failure, record.failure);
  check(result.code === 0 && result.signal === null, 'cli_failed');
  return record.stdout.trim();
}

function parseJson(text, code) {
  try { return JSON.parse(text); }
  catch { throw new FixtureFailure(code); }
}

function successfulCliData(result, code) {
  check(result.code === 0 && !result.killed && !result.truncated, code);
  const payload = parseJson(result.stdout, code);
  check(keysEqual(payload, ['data', 'success']) && payload.success === true
    && payload.data !== null && typeof payload.data === 'object' && !Array.isArray(payload.data), code);
  return payload.data;
}

async function sessionInfo(context, active, browserLaunched) {
  // main.rs run_session_info wraps actions.rs handle_session_info; neither envelope is mocked.
  const payload = parseJson(await cli(context, ['session', 'info']), 'invalid_session_info_json');
  check(keysEqual(payload, ['data', 'success']) && payload.success === true, 'session_info_envelope');
  const data = payload.data;
  check(keysEqual(data, SESSION_KEYS), 'session_info_data_schema');
  check(data.active === active && data.session === context.session
    && data.namespace === context.namespace && data.socketDir === context.socketDir
    && data.runtimeError === null, 'session_info_identity');
  if (active) {
    check(data.pid === context.daemon.child.pid && data.version === VERSION, 'session_info_daemon_identity');
    const runtime = data.runtime;
    check(keysEqual(runtime, RUNTIME_KEYS), 'session_info_runtime_schema');
    check(runtime.backgroundPid === data.pid && runtime.session === data.session
      && runtime.namespace === data.namespace && runtime.socketDir === data.socketDir
      && runtime.browserLaunched === browserLaunched && runtime.engine === 'chrome'
      && runtime.compatibilityStatus === 'current'
      && runtime.effectiveLaunch.browserLaunched === browserLaunched, 'session_info_runtime_values');
  } else {
    check(data.pid === null && data.version === null && data.runtime === null, 'inactive_session_info_values');
  }
  return data;
}

async function command(context, action, extra = {}, success = true) {
  const id = String(++context.commandCount);
  const request = { id, action, plugins: [], ...extra };
  const response = await deadline(new Promise((resolveResponse, reject) => {
    const socket = createConnection(context.socketPath);
    context.ipcSockets.add(socket);
    let buffer = Buffer.alloc(0);
    const finish = (error, value) => {
      socket.destroy();
      if (error) reject(error); else resolveResponse(value);
    };
    socket.setTimeout(COMMAND_TIMEOUT_MS, () => finish(new FixtureFailure('ipc_timeout')));
    socket.once('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('error', () => finish(new FixtureFailure('ipc_connection_failed')));
    socket.on('close', () => {
      context.ipcSockets.delete(socket);
      reject(new FixtureFailure('ipc_closed_without_response'));
    });
    socket.on('data', (chunk) => {
      try {
        check(buffer.length + chunk.length <= MAX_BYTES, 'ipc_response_limit');
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf(10);
        if (end >= 0) finish(undefined, parseJson(utf8.decode(buffer.subarray(0, end)), 'invalid_ipc_json'));
      } catch (error) { finish(error); }
    });
  }), COMMAND_TIMEOUT_MS + 100, 'ipc_deadline');
  context.fake.assertHealthy();
  check(response.id === id && response.success === success, `native_${action}_unexpected_result`);
  return response;
}

function websocketFrame(payload, opcode = 1) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  check(body.length <= MAX_BYTES, 'outgoing_websocket_frame_limit');
  const header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = 0x80 | opcode;
  header[1] = body.length < 126 ? body.length : 126;
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function fakeCdp({ path = '/devtools/browser/fixture', rejectConnections = false } = {}) {
  const sockets = new Set();
  const sessions = new Map();
  const existingId = 'fixture-existing';
  const pinnedId = 'fixture-pinned';
  const pages = new Map([[existingId, {
    targetId: existingId, type: 'page', title: 'Fixture existing', url: 'https://example.test/existing', attached: false,
  }]]);
  const counts = { tcpConnections: 0, webSocketConnections: 0, peerDisconnects: 0, failedReconnects: 0, httpRequests: 0, frames: 0 };
  const methods = new Map();
  const evaluations = [];
  const navigations = [];
  const events = new Map();
  let connected;
  let rejectReconnects = rejectConnections;
  let failure;
  const fail = (error, socket) => {
    failure ??= failureName(error);
    socket?.destroy();
  };
  const send = (socket, payload, opcode) => {
    check(socket.writableLength < MAX_BYTES, 'websocket_write_limit');
    socket.write(websocketFrame(payload, opcode));
  };
  const event = (socket, method, params, sessionId) => {
    events.set(method, (events.get(method) ?? 0) + 1);
    send(socket, { method, params, ...(sessionId ? { sessionId } : {}) });
  };
  const receive = (socket, text) => {
    const input = parseJson(text, 'invalid_cdp_json');
    const { id, method, params = {}, sessionId } = input;
    check(Number.isSafeInteger(id) && id > 0 && typeof method === 'string'
      && /^[A-Za-z]+\.[A-Za-z]+$/u.test(method), 'invalid_cdp_envelope');
    check(params !== null && typeof params === 'object' && !Array.isArray(params), 'invalid_cdp_params');
    methods.set(method, (methods.get(method) ?? 0) + 1);
    const page = pages.get(sessions.get(sessionId));
    if (sessionId !== undefined) check(page, 'unknown_cdp_session');
    const respond = (result) => send(socket, { id, result, ...(sessionId ? { sessionId } : {}) });
    switch (method) {
      case 'Target.setDiscoverTargets':
        check(params.discover === true && sessionId === undefined, 'unexpected_target_discovery');
        respond({});
        for (const targetInfo of pages.values()) event(socket, 'Target.targetCreated', { targetInfo });
        return;
      case 'Target.getTargets':
        check(sessionId === undefined, 'unexpected_target_scope');
        respond({ targetInfos: [...pages.values()] });
        return;
      case 'Target.createTarget': {
        check(params.url === 'about:blank' && !pages.has(pinnedId) && sessionId === undefined,
          'unexpected_target_creation');
        const targetInfo = { targetId: pinnedId, type: 'page', title: '', url: 'about:blank', attached: false };
        pages.set(pinnedId, targetInfo);
        respond({ targetId: pinnedId });
        event(socket, 'Target.targetCreated', { targetInfo });
        return;
      }
      case 'Target.attachToTarget': {
        const targetInfo = pages.get(params.targetId);
        check(targetInfo && params.flatten === true && sessionId === undefined, 'unexpected_target_attachment');
        const attachedSession = `session-${params.targetId}`;
        check(!sessions.has(attachedSession), 'duplicate_target_attachment');
        sessions.set(attachedSession, params.targetId);
        targetInfo.attached = true;
        respond({ sessionId: attachedSession });
        event(socket, 'Target.attachedToTarget', { sessionId: attachedSession, targetInfo, waitingForDebugger: false });
        return;
      }
      case 'Browser.getVersion':
        check(sessionId === undefined, 'unexpected_browser_scope');
        respond({ protocolVersion: '1.3', product: 'Fixture/0.0', revision: 'fixture', userAgent: 'Fixture', jsVersion: '0' });
        return;
      case 'Page.enable':
      case 'Runtime.enable':
      case 'Network.enable':
      case 'Runtime.runIfWaitingForDebugger':
        check(page, 'missing_page_session');
        respond({});
        return;
      case 'Target.setAutoAttach':
        check(page && params.autoAttach === true && params.flatten === true
          && params.waitForDebuggerOnStart === true, 'unexpected_auto_attach');
        respond({});
        return;
      case 'WebMCP.enable':
        check(page, 'missing_webmcp_session');
        send(socket, { id, error: { code: -32601, message: 'WebMCP is not supported by this fixture' }, sessionId });
        return;
      case 'Runtime.evaluate': {
        check(page && params.returnByValue === true, 'unexpected_runtime_evaluation');
        const values = { '1': 1, 'location.href': page.url, 'document.title': page.title };
        check(Object.hasOwn(values, params.expression), 'unsupported_runtime_expression');
        const value = values[params.expression];
        evaluations.push({ targetId: page.targetId, expression: params.expression });
        respond({ result: { type: typeof value, value } });
        return;
      }
      case 'Page.navigate': {
        check(page?.targetId === pinnedId && ['https://example.test', 'https://example.test/', 'https://example.test/first', 'https://example.test/second'].includes(params.url),
          'unexpected_page_navigation');
        page.url = params.url;
        page.title = `Fixture ${new URL(params.url).pathname.slice(1)}`;
        navigations.push(page.targetId);
        const frameId = 'fixture-frame';
        const loaderId = `fixture-loader-${navigations.length}`;
        respond({ frameId, loaderId });
        event(socket, 'Target.targetInfoChanged', { targetInfo: page });
        event(socket, 'Page.frameNavigated', { frame: {
          id: frameId, loaderId, url: page.url, domainAndRegistry: 'example.test',
          securityOrigin: 'https://example.test', mimeType: 'text/html',
        } }, sessionId);
        event(socket, 'Page.domContentEventFired', { timestamp: navigations.length }, sessionId);
        event(socket, 'Page.loadEventFired', { timestamp: navigations.length }, sessionId);
        return;
      }
      default:
        throw new FixtureFailure(`unsupported_cdp_method_${method.replace('.', '_')}`);
    }
  };
  const server = createServer({ maxHeaderSize: 8_192, requestTimeout: 2_000, headersTimeout: 2_000 }, (_request, response) => {
    counts.httpRequests += 1;
    failure ??= 'unexpected_http_discovery';
    response.writeHead(404).end();
  });
  server.on('error', () => { failure ??= 'fake_server_error'; });
  server.on('connection', (socket) => {
    counts.tcpConnections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.once('end', () => {
      if (socket === connected) counts.peerDisconnects += 1;
      // HTTP upgrade sockets permit half-close; finish the fixture side after the native peer exits.
      socket.end();
    });
    socket.setTimeout(15_000, () => fail(new FixtureFailure('fake_socket_timeout'), socket));
    if (counts.tcpConnections > 8) fail(new FixtureFailure('fake_connection_limit'), socket);
  });
  server.on('upgrade', (request, socket, head) => {
    try {
      check(request.url === path && request.method === 'GET'
        && request.headers['sec-websocket-version'] === '13'
        && request.headers.upgrade?.toLowerCase() === 'websocket'
        && typeof request.headers['sec-websocket-key'] === 'string'
        && Buffer.from(request.headers['sec-websocket-key'], 'base64').length === 16, 'unexpected_websocket_upgrade');
      if (rejectReconnects) {
        counts.failedReconnects += 1;
        socket.end('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
        return;
      }
      check(counts.webSocketConnections === 0, 'unexpected_second_websocket');
      counts.webSocketConnections += 1;
      connected = socket;
      const accept = createHash('sha1').update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      let buffered = Buffer.alloc(0);
      const consume = (chunk) => {
        try {
          check(buffered.length + chunk.length <= MAX_BYTES * 2, 'websocket_buffer_limit');
          buffered = Buffer.concat([buffered, chunk]);
          while (buffered.length >= 2) {
            check((buffered[0] & 0xf0) === 0x80 && (buffered[1] & 0x80) !== 0, 'unsupported_websocket_frame');
            const opcode = buffered[0] & 0x0f;
            let length = buffered[1] & 0x7f;
            let offset = 2;
            if (length === 126) {
              if (buffered.length < 4) return;
              length = buffered.readUInt16BE(2);
              offset = 4;
            } else if (length === 127) {
              if (buffered.length < 10) return;
              check(buffered.readBigUInt64BE(2) <= BigInt(MAX_BYTES), 'websocket_frame_limit');
              length = Number(buffered.readBigUInt64BE(2));
              offset = 10;
            }
            check(length <= MAX_BYTES && (opcode < 8 || length <= 125), 'websocket_frame_limit');
            if (buffered.length < offset + 4 + length) return;
            check(++counts.frames <= 256, 'websocket_message_limit');
            const mask = buffered.subarray(offset, offset + 4);
            const body = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
            for (let index = 0; index < length; index += 1) body[index] ^= mask[index % 4];
            buffered = buffered.subarray(offset + 4 + length);
            if (opcode === 1) receive(socket, utf8.decode(body));
            else if (opcode === 8) { send(socket, body, 8); socket.end(); return; }
            else if (opcode === 9) send(socket, body, 10);
            else check(opcode === 10, 'unsupported_websocket_opcode');
          }
        } catch (error) { fail(error, socket); }
      };
      socket.on('data', consume);
      if (head.length) consume(head);
    } catch (error) { fail(error, socket); }
  });
  return {
    counts, methods, evaluations, navigations, events, pages, pinnedId,
    assertHealthy() { check(!failure, failure); },
    async start(port = 0) {
      await deadline(new Promise((resolveListening, reject) => {
        server.once('error', () => reject(new FixtureFailure('fake_server_listen_failed')));
        server.listen(port, '127.0.0.1', resolveListening);
      }), 2_000, 'fake_server_listen_timeout');
      return `ws://127.0.0.1:${server.address().port}${path}`;
    },
    destroyPinnedTarget() {
      check(connected && pages.has(pinnedId), 'missing_pinned_target');
      pages.delete(pinnedId);
      event(connected, 'Target.targetDestroyed', { targetId: pinnedId });
    },
    loseConnection() {
      check(connected, 'missing_connection');
      rejectReconnects = true;
      connected.destroy();
    },
    disconnected() { return sockets.size === 0; },
    async stop() {
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await deadline(new Promise((resolveClosed) => server.close(resolveClosed)), 2_000, 'fake_server_close_timeout');
      }
    },
  };
}

async function createContext(root, binary, contexts, globalSignal) {
  globalSignal.throwIfAborted();
  const directory = await mkdtemp(join(root, 'f-'));
  const context = {
    directory, binary, children: [], ipcSockets: new Set(), commandCount: 0,
    abort: new AbortController(), globalSignal, pending: new Set(), diagnostics: [], observations: [], commands: [], sealed: false, stopping: false,
    session: `s${randomBytes(2).toString('hex')}`, namespace: `n${randomBytes(2).toString('hex')}`,
    fake: fakeCdp(),
  };
  contexts.push(context);
  if (globalSignal.aborted) { context.stopping = true; context.abort.abort(); }
  context.cwd = join(directory, 'work');
  const home = join(directory, 'home');
  const bin = join(directory, 'bin');
  const temp = join(directory, 'tmp');
  const socketBase = join(directory, 's');
  context.socketDir = join(socketBase, 'namespaces', context.namespace, 'run');
  context.socketPath = join(context.socketDir, `${context.session}.sock`);
  check(Buffer.byteLength(context.socketPath) <= 103, 'fixture_socket_path_limit');
  await Promise.all([context.cwd, home, bin, temp].map((path) => mkdir(path, { mode: 0o700 })));
  const executable = join(bin, 'no-browser');
  context.executable = executable;
  context.fallbackMarker = join(directory, 'fallback-attempts');
  await writeFile(executable, `#!/bin/sh\nprintf 'attempt\\n' >> '${context.fallbackMarker}'\nexit 97\n`, { mode: 0o700 });
  const config = join(directory, 'config.json');
  await writeFile(config, JSON.stringify({
    plugins: [], executablePath: executable, autoConnect: false, headed: false,
    pinTab: true, noWebmcp: true, restoreSave: 'never', noAutoDialog: true,
  }), { mode: 0o600 });
  context.flags = ['--config', config, '--session', context.session, '--namespace', context.namespace,
    '--executable-path', executable, '--json'];
  context.env = {
    HOME: home, USERPROFILE: home, PATH: bin, TMPDIR: temp, TMP: temp, TEMP: temp,
    XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
    LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', TERM: 'dumb',
    AGENT_BROWSER_NAMESPACE: context.namespace, AGENT_BROWSER_SOCKET_DIR: socketBase,
  };
  context.daemonEnv = {
    ...context.env,
    AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_SESSION: context.session,
    AGENT_BROWSER_EXECUTABLE_PATH: executable, AGENT_BROWSER_PLUGINS: '[]',
    AGENT_BROWSER_PIN_TAB: '1', AGENT_BROWSER_NO_WEBMCP: '1', AGENT_BROWSER_RESTORE_SAVE: 'never',
    AGENT_BROWSER_NO_AUTO_DIALOG: '1', AGENT_BROWSER_IDLE_TIMEOUT_MS: '20000',
    AGENT_BROWSER_DEFAULT_TIMEOUT: '3000',
  };
  return context;
}

async function validateWrapperExecution(context, args, localOnly) {
  const forbidden = new Set(['--auto-connect', '--autoconnect', '--profile', '--state', '--restore', '--session-name',
    '--executable-path', '--provider', '-p', '--engine', '--proxy', '--args', '--extensions', '--init-script', '--enable']);
  check(args.every(value => !forbidden.has(value.split('=')[0])), 'unsafe_wrapper_launch_override');
  if (!localOnly) {
    const index = args.indexOf('--cdp');
    check(index >= 0 && args.filter(value => value === '--cdp').length === 1
      && args[index + 1] === `ws://127.0.0.1:${context.lease.connection.port}${context.lease.connection.webSocketPath}`,
    'unsafe_wrapper_connection');
  }
  if (args[0] !== 'close') return;
  const valued = new Set(['--session', '--namespace', '--idle-timeout', '--max-output', '--config']);
  const bare = new Set(['--json', '--content-boundaries']);
  for (let index = 1; index < args.length; index += 1) {
    if (valued.has(args[index])) { check(typeof args[++index] === 'string', 'unsafe_cleanup_argv'); }
    else check(bare.has(args[index]), 'unsafe_cleanup_argv');
  }
  const rawPath = args[args.indexOf('--config') + 1];
  check(typeof rawPath === 'string', 'unsafe_cleanup_config_path');
  const path = resolve(rawPath);
  check(path.startsWith(`${context.directory}/`), 'unsafe_cleanup_config_path');
  const config = parseJson(await readFile(path, 'utf8'), 'unsafe_cleanup_config_json');
  const expected = {
    plugins: [], extensions: [], initScripts: [], enable: [],
    autoConnect: false, profile: null, state: null, restore: null, sessionName: null,
    restoreSave: 'never', restoreCheckUrl: null, restoreCheckText: null, restoreCheckFn: null,
    cdp: null, executablePath: null, provider: null, engine: null, args: null,
    proxy: null, proxyBypass: null, userAgent: null, device: null, headers: null,
    caCert: null, clearCaCert: false, ignoreHttpsErrors: false, allowFileAccess: false,
    headed: false, webgpu: false, debug: false, colorScheme: null, downloadPath: null,
    actionPolicy: null, confirmActions: null, confirmInteractive: false, allowedDomains: null,
    pinTab: true, noAutoDialog: true, noWebmcp: false,
    screenshotDir: join(context.directory, 'session/browser/screenshots'), screenshotFormat: 'png',
  };
  check(keysEqual(config, Object.keys(expected)) && Object.entries(expected).every(([key, value]) => (
    JSON.stringify(config[key]) === JSON.stringify(value)
  )), 'unsafe_cleanup_configuration');
}

async function wrapperScenario(context, connectionLoss) {
  const { createBrowserExtension } = await import('../packages/ext-browser/dist/index.js');
  const { createChromeConnectionLease } = await import('../apps/tui/dist/browser/connection-lease.js');
  const upstream = new URL(await context.fake.start());
  const tools = new Map();
  const shutdown = [];
  const contained = path => {
    const absolute = resolve(path);
    check(absolute.startsWith(`${context.directory}/`), 'wrapper_storage_escape');
    return absolute;
  };
  const mutation = action => { check(!context.sealed, 'fixture_storage_sealed'); return action(); };
  const track = promise => {
    context.pending.add(promise);
    void promise.then(() => context.pending.delete(promise), () => context.pending.delete(promise));
    return promise;
  };
  const storage = root => ({
    root,
    readFile: async path => new Uint8Array(await readFile(contained(join(root, path)))),
    writeFile: (path, bytes) => mutation(() => writeFile(contained(join(root, path)), bytes)),
    mkdir: (path, options) => mutation(() => mkdir(contained(join(root, path)), options)),
    remove: (path, options) => mutation(() => rm(contained(join(root, path)), { force: true, ...options })),
    listFiles: async () => [],
  });
  const agent = storage(join(context.directory, 'agent'));
  const session = storage(join(context.directory, 'session'));
  const runtime = {
    kind: 'host', cwd: context.cwd,
    storage: scope => scope === 'agent' ? agent : session,
    readFile: async path => new Uint8Array(await readFile(contained(path))),
    async exec(commandName, args, options = {}) {
      context.commands.push(args.slice(0, ['get', 'session', 'tab'].includes(args[0]) ? 2 : 1).join(' '));
      check(commandName === 'agent-browser', 'unexpected_wrapper_executable');
      const localOnly = args[0] === '--version' || args[0] === 'close' || (args[0] === 'session' && args[1] === 'info');
      if (args[0] === 'get' && args[1] === 'title') context.recoveryArgs = [...args];
      check(!context.sealed && (!context.stopping || localOnly), 'fixture_stopping');
      if (options.signal?.aborted) return { stdout: '', stderr: '', code: 143, killed: true };
      try { await validateWrapperExecution(context, args, localOnly); }
      catch (error) { context.diagnostics.push(failureName(error)); throw error; }
      if (args.includes('--cdp')) {
        context.session = args[args.indexOf('--session') + 1];
        context.namespace = args[args.indexOf('--namespace') + 1];
        check(/^f-[a-f0-9]{16}$/u.test(context.session) && /^f-[a-f0-9]{16}$/u.test(context.namespace), 'unexpected_wrapper_scope');
        context.socketDir = join(context.env.AGENT_BROWSER_SOCKET_DIR, 'namespaces', context.namespace, 'run');
        context.socketPath = join(context.socketDir, `${context.session}.sock`);
        check(Buffer.byteLength(context.socketPath) <= 103, 'wrapper_socket_path_limit');
      }
      const env = { ...context.env, AGENT_BROWSER_NAMESPACE: context.namespace };
      // Any accidental local launch, including daemon respawn, must execute only the sentinel.
      if (!localOnly) env.AGENT_BROWSER_EXECUTABLE_PATH = context.executable;
      const record = spawnOwned(context, args, env, COMMAND_TIMEOUT_MS, localOnly && args[0] !== '--version');
      const abort = () => { if (!record.done) record.child.kill('SIGTERM'); };
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
      try {
        const exit = await record.result;
        if (args[0] === 'session' && args[1] === 'info') {
          try {
            const data = JSON.parse(record.stdout).data;
            context.observations.push({ active: data.active, pidPresent: data.pid !== null,
              runtimePresent: data.runtime !== null, runtimeError: data.runtimeError !== null });
          } catch {}
        }
        if (exit.code !== 0 || record.failure) {
          let message;
          try { message = JSON.parse(record.stdout).error; } catch {}
          context.diagnostics.push(String(message ?? record.failure ?? record.stderr)
            .replace(/\b(?:wss?|https?):\/\/[^\s"']+/gu, '<endpoint>')
            .replace(/\b127\.0\.0\.1:\d+[^\s"']*/gu, '<endpoint>')
            .replace(/\/(?:private\/)?tmp\/fbp-[^\s"']+/gu, '<fixture>')
            .slice(0, 512));
        }
        return {
          stdout: record.stdout, stderr: record.stderr, code: exit.code ?? 143,
          killed: exit.signal !== null || record.failure === 'child_timeout',
          truncated: record.failure === 'child_output_limit',
        };
      } finally { options.signal?.removeEventListener('abort', abort); }
    },
  };
  const ctx = { sessionManager: { getSessionId: () => 'offline-wrapper' }, model: { input: ['text'] } };
  createBrowserExtension({
    authorizationHost: {
      authorize(request) {
        return track((async () => {
          context.lease = await createChromeConnectionLease({ port: Number(upstream.port), webSocketPath: upstream.pathname }, request.signal);
          const attached = await request.attach(context.lease.connection, context.lease);
          return { status: attached.ready ? 'authorized' : 'unavailable' };
        })());
      },
    },
  })({ runtime, registerCapability() {}, registerTool: tool => tools.set(tool.name, tool), on: (_event, handler) => shutdown.push(handler) });
  context.disposeWrapper = async () => { for (const handler of shutdown) await handler({}, ctx); };
  const call = async (name, params) => {
    context.abort.signal.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    context.abort.signal.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20_000);
    try {
      const value = await deadline(track(Promise.resolve().then(() => tools.get(name).execute('fixture', params, controller.signal, undefined, ctx))),
        21_000, 'wrapper_tool_timeout');
      check(!timedOut, 'wrapper_tool_timeout');
      return value;
    } catch (error) {
      check(!timedOut, 'wrapper_tool_timeout');
      throw error;
    } finally {
      clearTimeout(timer);
      context.abort.signal.removeEventListener('abort', onAbort);
    }
  };
  const output = [];
  const authorized = await call('browser_authorize', { operation: 'authorize', origin: 'https://example.test' });
  output.push(authorized);
  check(authorized.details.state === 'authorized', 'wrapper_authorization_failed');
  for (const args of [['get', 'title'], ['open', 'https://example.test/first'], ['get', 'url']]) {
    const result = await call('browser', { operation: 'run', args });
    output.push(result);
    check(!result.isError && result.details.code === 0, 'wrapper_command_failed');
  }
  const reused = await call('browser_authorize', { operation: 'authorize', origin: 'https://example.test' });
  check(reused.details.reused === true, 'wrapper_grant_not_reused');
  check(context.fake.counts.webSocketConnections === 1 && context.fake.counts.tcpConnections === 1, 'wrapper_connection_not_reused');
  if (connectionLoss === 'target') {
    context.fake.destroyPinnedTarget();
    let blocked = false;
    try { await call('browser', { operation: 'run', args: ['get', 'title'] }); }
    catch (error) { blocked = error.message === 'Existing-browser authorization was lost or its target changed. No further browser action is permitted.'; }
    check(blocked, 'wrapper_target_loss_not_blocked');
  } else if (connectionLoss) {
    context.fake.loseConnection();
    await waitUntil(() => context.lease.signal.aborted, 'wrapper_lease_not_revoked_on_loss');
    let blocked = false;
    try { await call('browser', { operation: 'run', args: ['get', 'title'] }); }
    catch (error) { blocked = error.message === 'Existing-browser authorization is inactive or quarantined; authorize again before using browser.'; }
    check(blocked, 'wrapper_connection_loss_not_blocked');
  }
  const revoked = await call('browser_authorize', { operation: 'revoke' });
  output.push(revoked);
  check(revoked.details.state === 'revoked', 'wrapper_revoke_not_verified');
  check(context.lease.signal.aborted, 'wrapper_authority_survived_revoke');
  await deadline(context.disposeWrapper(), 20_000, 'wrapper_shutdown_timeout');
  await waitUntil(() => context.fake.disconnected(), 'wrapper_upstream_not_disconnected');
  await waitUntil(async () => (await privateDaemons(context)).length === 0, 'wrapper_daemon_did_not_exit');
  const infoArgs = ['session', 'info', '--json', '--config', context.recoveryArgs[context.recoveryArgs.indexOf('--config') + 1],
    '--session', context.session, '--namespace', context.namespace];
  context.recoveryPeer = fakeCdp({ path: context.lease.connection.webSocketPath, rejectConnections: true });
  await context.recoveryPeer.start(context.lease.connection.port);
  const cold = await runtime.exec('agent-browser', context.recoveryArgs);
  check(!cold.killed && !cold.truncated && cold.code !== 0 && parseJson(cold.stdout, 'cold_cli_json').success === false,
    'cold_cli_did_not_fail_closed');
  const coldInfo = successfulCliData(await runtime.exec('agent-browser', infoArgs), 'cold_session_info_json');
  check(coldInfo.active === true && Number.isSafeInteger(coldInfo.pid) && coldInfo.runtime?.backgroundPid === coldInfo.pid
    && coldInfo.runtime.browserLaunched === false, 'cold_daemon_state_unexpected');
  check(context.recoveryPeer.counts.failedReconnects === 1 && context.recoveryPeer.counts.webSocketConnections === 0,
    'cold_cli_proxy_not_rejected');
  await command(context, 'close');
  await waitUntil(async () => (await privateDaemons(context)).length === 0, 'cold_daemon_did_not_exit');
  const inactive = successfulCliData(await runtime.exec('agent-browser', infoArgs), 'closed_session_info_json');
  check(inactive.active === false && inactive.pid === null && inactive.runtime === null, 'cold_daemon_cleanup_unconfirmed');
  context.recoveryPeer.assertHealthy();
  await context.recoveryPeer.stop();
  const printed = JSON.stringify(output);
  check(!printed.includes(context.directory) && !printed.includes(context.lease.connection.webSocketPath)
    && !printed.includes(upstream.href) && !printed.includes('fixture-existing')
    && !printed.includes('Fixture existing') && !printed.includes('https://example.test/existing'), 'wrapper_private_metadata_exposed');
  context.fake.assertHealthy();
  check(!await exists(context.fallbackMarker), 'local_browser_fallback_attempted');
  check(context.fake.counts.tcpConnections === 1 && context.fake.counts.httpRequests === 0
    && (context.fake.methods.get('Browser.close') ?? 0) === 0, 'wrapper_unexpected_connection_or_close');
  check(context.fake.methods.get('Target.createTarget') === 1 && context.fake.evaluations.every(value => value.expression === '1'
    || value.targetId === context.fake.pinnedId), 'wrapper_pinned_target_changed');
  return {
    ...context.fake.counts, connectionLossTested: connectionLoss === true, targetLossTested: connectionLoss === 'target', authorizationReused: true,
    authorityRevoked: true, publicCliTested: true, cliAutoSpawnTested: true,
    coldRecoveryRejected: true, sessionInactiveAfterClose: true, localBrowserFallbackAttempts: 0, privateMetadataExposed: false,
  };
}

async function privateDaemons(context) {
  const canonical = await realpath(context.binary);
  const text = await deadline(new Promise((resolveText, reject) => {
    const child = spawn('/bin/ps', ['-ax', '-ww', '-o', 'pid=,uid=,comm='], {
      env: context.env ?? { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'],
    });
    let value = '';
    let failure;
    const timer = setTimeout(() => { failure = 'process_inspection_timeout'; child.kill('SIGKILL'); }, 3_000);
    child.stdout.on('data', bytes => {
      if (value.length + bytes.length > 256 * 1024) { failure = 'process_inspection_limit'; child.kill('SIGKILL'); }
      else value += bytes;
    });
    child.on('error', () => { failure = 'process_inspection_failed'; });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(new FixtureFailure(failure ?? 'process_inspection_failed'));
      else resolveText(value);
    });
  }), 4_000, 'process_inspection_deadline');
  const found = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match || Number(match[2]) !== process.getuid()) continue;
    let executable = match[3];
    if (process.platform === 'linux') {
      if (executable !== 'agent-browser') continue;
      try { executable = await readlink(`/proc/${match[1]}/exe`); }
      catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    }
    if ([context.binary, canonical].includes(executable)) found.push(Number(match[1]));
  }
  return found;
}

async function closePrivateDaemons(contexts) {
  if (!contexts.length) return;
  await waitUntil(async () => {
    if (!(await privateDaemons(contexts[0])).length) return true;
    for (const context of contexts) {
      if (await exists(context.socketPath)) {
        try { await command(context, 'close'); } catch {}
      }
    }
    return (await privateDaemons(contexts[0])).length === 0;
  }, 'owned_daemon_cleanup_unconfirmed');
}

async function scenario(context, connectionLoss) {
  const endpoint = await context.fake.start();
  await sessionInfo(context, false, false);
  // Native daemon mode skips CLI config parsing. Supply the same owned settings explicitly.
  // Owning this child avoids cleanup based on a PID read from an arbitrary sidecar file.
  context.daemon = spawnOwned(context, context.flags, { ...context.daemonEnv, AGENT_BROWSER_CDP: endpoint }, 45_000);
  await waitUntil(async () => {
    check(!context.daemon.done, 'daemon_exited_before_ready');
    return exists(context.socketPath);
  }, 'daemon_start_timeout');
  await sessionInfo(context, true, false);
  const launch = { cdpUrl: endpoint, pinTab: true, restoreSave: 'never', webmcp: false };
  await command(context, 'launch', launch);
  const info = await sessionInfo(context, true, true);
  check(info.runtime.pageCount === 2, 'unexpected_page_count');
  const bindingPath = join(context.socketDir, `${context.session}.target`);
  const assertPinned = async () => {
    const tabs = (await command(context, 'tab_list')).data.tabs;
    check(Array.isArray(tabs) && tabs.length === 2, 'tab_list_schema');
    const active = tabs.filter((tab) => tab.active === true);
    check(active.length === 1 && active[0].targetId === context.fake.pinnedId, 'active_target_changed');
    const binding = parseJson(await readFile(bindingPath, 'utf8'), 'invalid_binding_json');
    check(binding.pinned === true && binding.targetId === active[0].targetId, 'target_not_pinned');
  };
  await assertPinned();
  for (const page of ['first', 'second']) {
    const navigation = await command(context, 'navigate', { url: `https://example.test/${page}`, waitUntil: 'load' });
    check(navigation.data.url === `https://example.test/${page}` && navigation.data.title === `Fixture ${page}`
      && navigation.data.targetId === context.fake.pinnedId, 'navigation_result');
    const title = await command(context, 'title');
    check(title.data.title === `Fixture ${page}` && title.data.lifecycle.reused === true
      && title.data.lifecycle.launched === false && title.data.lifecycle.relaunchedBrowser === false, 'command_not_reused');
    const reuse = await command(context, 'launch', launch);
    check(reuse.data.reused === true && reuse.data.relaunchedBrowser === false, 'launch_not_reused');
    await assertPinned();
  }
  check(context.fake.counts.webSocketConnections === 1 && context.fake.counts.tcpConnections === 1, 'connection_not_reused');
  check(context.fake.methods.get('Target.createTarget') === 1
    && context.fake.methods.get('Target.attachToTarget') === 2, 'attachment_count_changed');
  check(context.fake.events.get('Page.loadEventFired') === 2
    && context.fake.events.get('Page.domContentEventFired') === 2, 'missing_navigation_lifecycle');
  check(context.fake.evaluations.every(({ targetId, expression }) => expression === '1'
    || targetId === context.fake.pinnedId), 'evaluated_neighboring_target');
  let tabGoneFailedClosed = false;
  if (connectionLoss) {
    context.fake.loseConnection();
    const result = await command(context, 'title', {}, false);
    check(typeof result.error === 'string' && result.error.includes('CDP'), 'unexpected_connection_loss_failure');
    check(context.fake.counts.failedReconnects > 0, 'stock_reconnect_not_observed');
    await sessionInfo(context, true, false);
  } else {
    context.fake.destroyPinnedTarget();
    await waitUntil(async () => {
      const tabs = (await command(context, 'tab_list')).data.tabs;
      return tabs.length === 1 && tabs.every((tab) => tab.active === false);
    }, 'target_destroy_event_not_applied');
    const evaluationsBefore = context.fake.evaluations.length;
    const result = await command(context, 'url', {}, false);
    check(result.code === 'tab_gone', 'missing_tab_gone_error');
    check(context.fake.evaluations.length === evaluationsBefore
      && context.fake.methods.get('Target.createTarget') === 1
      && context.fake.counts.webSocketConnections === 1, 'pinned_target_fallback');
    tabGoneFailedClosed = true;
  }
  const closed = await command(context, 'close');
  check(closed.data.closed === true, 'disconnect_not_acknowledged');
  const daemonExit = await deadline(context.daemon.result, COMMAND_TIMEOUT_MS, 'daemon_did_not_exit');
  check(daemonExit.code === 0 && daemonExit.signal === null && !context.daemon.failure, 'daemon_abnormal_exit');
  await waitUntil(() => context.fake.disconnected(), 'websocket_not_disconnected');
  check(connectionLoss || context.fake.counts.peerDisconnects === 1, 'native_disconnect_not_observed');
  for (const suffix of ['sock', 'pid', 'version', 'stream']) {
    check(!await exists(join(context.socketDir, `${context.session}.${suffix}`)), 'daemon_artifact_not_removed');
  }
  await sessionInfo(context, false, false);
  context.fake.assertHealthy();
  check(!await exists(context.fallbackMarker), 'local_browser_fallback_attempted');
  check((context.fake.methods.get('Browser.close') ?? 0) === 0, 'browser_close_sent');
  check(context.fake.counts.httpRequests === 0 && context.fake.counts.webSocketConnections === 1, 'unexpected_discovery_or_reconnection');
  return {
    ...context.fake.counts, nativeCommands: context.commandCount, targetCreations: context.fake.methods.get('Target.createTarget'),
    navigations: context.fake.navigations.length, browserCloseCommands: 0, localBrowserFallbackAttempts: 0,
    stablePinnedTarget: true, nativeCommandReuse: true, tabGoneFailedClosed,
    connectionLossTested: connectionLoss, stockReconnectObserved: context.fake.counts.failedReconnects > 0,
    liveDisconnectTested: !connectionLoss, daemonExited: true, sessionInactiveAfterClose: true,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(JSON.stringify({ skipped: true, binaryOptInRequired: true }));
    return;
  }
  const report = { passed: false, reviewedDigestMatched: false, versionExact: false, wrapperGuaranteeTested: false, cliAutoSpawnTested: false };
  const failures = [];
  const contexts = [];
  let root;
  let interrupted = false;
  const cancellation = new AbortController();
  let quiescent = true;
  let daemonsClosed = false;
  const interrupt = () => {
    interrupted = true;
    cancellation.abort();
    for (const context of contexts) {
      context.stopping = true;
      context.abort.abort();
      void context.lease?.close();
      for (const record of context.children) if (!record.done) record.child.kill('SIGTERM');
      for (const socket of context.ipcSockets) socket.destroy();
    }
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const watchdog = setTimeout(interrupt, 60_000);
  try {
    check(args[0] === '--binary' && typeof args[1] === 'string' && !args[1].startsWith('--')
      && args.slice(2).every(value => ['--connection-loss', '--wrapper'].includes(value))
      && new Set(args.slice(2)).size === args.length - 2, 'invalid_opt_in_arguments');
    const bytes = await reviewedBinary(resolve(args[1]));
    report.reviewedDigestMatched = true;
    // A private copy closes the hash-to-exec race with upgrades of the managed installation.
    root = await mkdtemp('/tmp/fbp-');
    await chmod(root, 0o700);
    const binary = join(root, 'agent-browser');
    await writeFile(binary, bytes, { mode: 0o500 });
    const first = await createContext(root, binary, contexts, cancellation.signal);
    check(await cli(first, ['--version']) === `agent-browser ${VERSION}`, 'native_version_mismatch');
    report.versionExact = true;
    const run = args.includes('--wrapper') ? wrapperScenario : scenario;
    report.normal = await run(first, false);
    if (args.includes('--connection-loss')) {
      check(!interrupted, 'fixture_interrupted');
      report.connectionLoss = await run(await createContext(root, binary, contexts, cancellation.signal), true);
    }
    if (args.includes('--wrapper')) report.pinnedTargetLoss = await wrapperScenario(await createContext(root, binary, contexts, cancellation.signal), 'target');
    report.wrapperGuaranteeTested = args.includes('--wrapper');
    report.cliAutoSpawnTested = args.includes('--wrapper');
    report.sessionInfoKeys = SESSION_KEYS;
    report.runtimeKeys = RUNTIME_KEYS;
  } catch (error) {
    failures.push(failureName(error));
  } finally {
    clearTimeout(watchdog);
    for (const context of contexts) {
      context.stopping = true;
      context.abort.abort();
      try { await deadline(Promise.resolve(context.lease?.close()), 5_000, 'lease_cleanup_timeout'); }
      catch { quiescent = false; failures.push('lease_cleanup_failed'); }
      try { await deadline(Promise.resolve(context.disposeWrapper?.()), 20_000, 'wrapper_shutdown_timeout'); }
      catch (error) {
        if (error instanceof FixtureFailure && error.code === 'wrapper_shutdown_timeout') quiescent = false;
        failures.push('wrapper_shutdown_failed');
      }
      context.sealed = true;
      try { await deadline(Promise.allSettled([...context.pending]), 10_000, 'wrapper_callers_not_settled'); }
      catch { quiescent = false; failures.push('wrapper_callers_not_settled'); }
      if (context.pending.size) quiescent = false;
      for (const socket of context.ipcSockets) socket.destroy();
      try { await context.fake.stop(); } catch (error) { failures.push(failureName(error)); }
      try { await context.recoveryPeer?.stop(); } catch (error) { failures.push(failureName(error)); }
      for (const record of context.children) {
        if (!record.done) record.child.kill('SIGTERM');
        try {
          await deadline(record.result, 1_000, 'child_term_timeout');
        } catch {
          if (!record.done) record.child.kill('SIGKILL');
          try { await deadline(record.result, 2_000, 'owned_child_cleanup_failed'); }
          catch (error) { failures.push(failureName(error)); }
        }
      }
      try { check(!context.fallbackMarker || !await exists(context.fallbackMarker), 'local_browser_fallback_attempted'); }
      catch (error) { failures.push(failureName(error)); }
    }
    try { await closePrivateDaemons(contexts); daemonsClosed = true; }
    catch (error) { failures.push(failureName(error)); }
    if (root && quiescent && daemonsClosed && contexts.every(context => context.children.every(record => record.done))) {
      try { await rm(root, { recursive: true, force: true }); }
      catch (error) { failures.push(failureName(error)); }
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  if (interrupted) failures.push('fixture_interrupted');
  report.cleanupComplete = quiescent && daemonsClosed && contexts.every((context) => context.fake.disconnected()
    && context.children.every((record) => record.done))
    && (!root || !await exists(root));
  report.passed = failures.length === 0 && report.cleanupComplete;
  if (!report.passed) {
    report.failures = [...new Set(failures)];
    report.diagnostics = [...new Set(contexts.flatMap(context => context.diagnostics))];
    report.daemonsClosed = daemonsClosed;
    report.pendingCalls = contexts.reduce((count, context) => count + context.pending.size, 0);
    report.lastObservations = contexts.flatMap(context => context.observations.slice(-4));
    report.lastCommands = contexts.flatMap(context => context.commands.slice(-6));
    report.fixtureConnections = contexts.map(context => context.fake.counts);
    if (root && await exists(root)) report.retainedFixture = root;
    process.exitCode = 1;
  }
  console.log(JSON.stringify(report));
}

await main();
