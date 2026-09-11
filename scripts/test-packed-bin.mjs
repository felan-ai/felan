import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(root, '.artifacts');
const installDir = mkdtempSync(join(tmpdir(), 'felan-packed-bin-'));
const cleanHome = join(installDir, 'home');
const cacheDir = join(installDir, 'npm-cache');
const workspace = join(installDir, 'workspace');
const agentDir = join(cleanHome, '.felan');
const npm = process.platform === 'win32' ? process.execPath : 'npm';
const npmArguments = process.platform === 'win32'
  ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  : [];
const binDirectory = join(installDir, 'node_modules', '.bin');
const felan = process.platform === 'win32'
  ? process.execPath
  : join(binDirectory, 'felan');
const felanArguments = process.platform === 'win32'
  ? [join(installDir, 'node_modules', '@felan-ai', 'felan', 'dist', 'cli.js')]
  : [];
const sourcePackages = packagePaths.map((packagePath) => JSON.parse(
  readFileSync(resolve(root, packagePath, 'package.json'), 'utf8'),
));
const sourcePackagesByName = new Map(sourcePackages.map((manifest) => [manifest.name, manifest]));
const packageNames = sourcePackages.map(({ name }) => name);
const agentCoreVersion = sourcePackagesByName.get('@felan-ai/agent-core').version;
const [agentCoreMajor, agentCoreMinor, agentCorePatch] = agentCoreVersion.split('.').map(Number);
const felanVersion = sourcePackagesByName.get('@felan-ai/felan').version;
const audit = process.argv.includes('--audit');
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => (
    !/(TOKEN|API_KEY|AUTH|PASSWORD|SECRET|CREDENTIAL|COOKIE|SESSION|(^|_)KEY$)/i.test(name)
  )),
);
Object.assign(cleanEnvironment, {
  HOME: cleanHome,
  USERPROFILE: cleanHome,
  NPM_CONFIG_CACHE: cacheDir,
  NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
  NPM_CONFIG_USERCONFIG: join(cleanHome, '.npmrc'),
  PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ''}`,
  FELAN_AGENT_DIR: agentDir,
  PACKED_SMOKE_WORKSPACE: workspace,
});

try {
  mkdirSync(cleanHome);
  mkdirSync(workspace);
  writeFileSync(join(cleanHome, '.npmrc'), 'registry=https://registry.npmjs.org/\n');

  const tarballs = readdirSync(artifacts)
    .filter((entry) => entry.endsWith('.tgz'))
    .map((entry) => join(artifacts, entry));
  if (tarballs.length !== sourcePackages.length) {
    throw new Error(`Expected ${sourcePackages.length} packed artifacts, found ${tarballs.length}`);
  }

  runNpm([
    'install',
    '--ignore-scripts',
    '--no-fund',
    '--prefix',
    installDir,
    ...tarballs,
  ], cleanEnvironment);

  for (const sourcePackage of sourcePackages) validateInstalledPackage(sourcePackage);
  assertPackedFelanThemes();
  assertPackedFelanOutputStyleDependency();
  assertPackedFelanAcpPackage();
  assertSingleAgentCoreInstallation();
  assertPackedToolBoundary();

  run(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      const packageNames = ${JSON.stringify(packageNames)};
      await Promise.all(packageNames.map((name) => import(name)));
      const app = await import('@felan-ai/felan');
      for (const packageName of app.localExtensionPackages) {
        const extension = await app.importLocalExtension(packageName);
        if (packageName === '@felan-ai/ext-subagents') {
          if (typeof extension.createSubagentsExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-ask-user') {
          if (typeof extension.createAskUserExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-mcp') {
          if (typeof extension.createMcpExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-memory') {
          if (typeof extension.createMemoryExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-session-title') {
          if (typeof extension.createSessionTitleExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-session-compaction') {
          if (typeof extension.registerSessionRecall !== 'function' || typeof extension.default !== 'function') throw new Error(packageName + ' has no session compaction extension factory');
          const { SESSION_COMPACTION_CONFIG } = extension;
          if (SESSION_COMPACTION_CONFIG?.fields?.model?.default !== 'inherit') throw new Error(packageName + ' has no inherit model configuration default');
          if (JSON.stringify(SESSION_COMPACTION_CONFIG.fields.model.values) !== JSON.stringify(['inherit', 'xhigh', 'high', 'medium', 'low'])) throw new Error(packageName + ' has unexpected model configuration values');
        } else if (typeof extension.default !== 'function') {
          throw new Error(packageName + ' has no extension factory');
        }
      }
      for (const packageName of ['@felan-ai/agent-core', '@felan-ai/unlisted-extension']) {
        try {
          await app.importLocalExtension(packageName);
          throw new Error(packageName + ' loaded without a list entry');
        } catch (error) {
          if (!String(error).includes('Unknown local extension package')) throw error;
        }
      }
      const outputStyle = await import('@felan-ai/ext-output-style');
      let outputStyleHandler;
      outputStyle.createOutputStyleExtension('concise')({
        on: (event, handler) => {
          if (event === 'before_agent_start') outputStyleHandler = handler;
        },
      });
      const styledPrompt = outputStyleHandler?.({ systemPrompt: 'Packed base prompt' })?.systemPrompt;
      if (!styledPrompt?.includes('## Output Style')
        || !styledPrompt.includes('<output_style>')
        || !styledPrompt.includes('Use the fewest words that preserve correctness')
        || !styledPrompt.includes('Keep technical terms, code, commands, paths, identifiers, API names, numbers, units, and exact error messages unchanged')
        || !styledPrompt.includes('</output_style>')) {
        throw new Error('Packed output-style extension did not apply the concise style');
      }
      try {
        outputStyle.createOutputStyleExtension('caveman');
        throw new Error('Packed output-style extension accepted the removed caveman style');
      } catch (error) {
        if (!String(error).includes('outputStyle must be one of: concise, explanatory, custom')) throw error;
      }
      let customOutputStyleHandler;
      outputStyle.createOutputStyleExtension('custom', 'Packed custom instructions.')({
        on: (event, handler) => {
          if (event === 'before_agent_start') customOutputStyleHandler = handler;
        },
      });
      const customStyledPrompt = customOutputStyleHandler?.({ systemPrompt: 'Packed base prompt' })?.systemPrompt;
      if (!customStyledPrompt?.includes('<output_style>\\nPacked custom instructions.\\n</output_style>')) {
        throw new Error('Packed output-style extension did not apply custom instructions');
      }
      const codebaseMemory = await import('@felan-ai/ext-codebase-memory');
      const codebaseMemoryTools = [];
      const codebaseMemoryCapabilities = [];
      const codebaseMemoryLogs = [];
      await codebaseMemory.createCodebaseMemoryExtension({
        log: (level, message) => codebaseMemoryLogs.push({ level, message }),
      })({
        runtime: {
          kind: 'docker',
          cwd: process.env.PACKED_SMOKE_WORKSPACE,
          storage: () => ({ root: process.env.FELAN_AGENT_DIR }),
          exec: async () => ({ code: 127, killed: false, stdout: '', stderr: 'not found' }),
        },
        config: { maxCacheBytes: 0 },
        registerTool: (tool) => codebaseMemoryTools.push(tool.name),
        registerCapability: (capability) => codebaseMemoryCapabilities.push(capability.id),
        registerCommand: () => {},
        on: () => {},
      });
      if (codebaseMemoryTools.length !== 0 || codebaseMemoryCapabilities.length !== 0) {
        throw new Error('Packed Codebase Memory exposed model behavior without its binary');
      }
      if (!codebaseMemoryLogs.some(({ level, message }) => level === 'error' && message.includes('unavailable'))) {
        throw new Error('Packed Codebase Memory did not hard-log its nonfatal cloud unavailability');
      }
      const subagents = await import('@felan-ai/ext-subagents');
      const canonicalTools = [];
      const canonicalCapabilities = [];
      const host = {
          descriptors: [{
            id: 'general',
            description: 'General agent',
            allowNesting: true,
          }],
          policy: {
            maxPromptBytes: 1024,
            maxDescriptionBytes: 128,
            maxSteerBytes: 1024,
          },
        };
      subagents.createSubagentsExtension(host)({
        registerCapability: (capability) => canonicalCapabilities.push(capability.id),
        registerTool: (tool) => canonicalTools.push(tool.name),
      });
      const expectedTools = [
        'Agent',
        'list_subagents',
        'get_subagent_result',
        'steer_subagent',
        'cancel_subagent',
      ];
      if (JSON.stringify(canonicalTools) !== JSON.stringify(expectedTools)) {
        throw new Error('Packed subagent extension tools differ from the canonical five: ' + canonicalTools.join(', '));
      }
      if (JSON.stringify(canonicalCapabilities) !== JSON.stringify(['subagents'])) {
        throw new Error('Packed subagent extension capability is unavailable');
      }
      const askUser = await import('@felan-ai/ext-ask-user');
      const askUserTui = await import('@felan-ai/ext-ask-user/tui');
      const askUserTools = [];
      const askUserCapabilities = [];
      askUser.createAskUserExtension(askUserTui.createTuiAskUserHost())({
        registerCapability: (capability) => askUserCapabilities.push(capability.id),
        registerTool: (tool) => askUserTools.push(tool.name),
      });
      if (JSON.stringify(askUserTools) !== JSON.stringify(['ask_user'])) {
        throw new Error('Packed ask-user extension tool is unavailable');
      }
      if (JSON.stringify(askUserCapabilities) !== JSON.stringify(['ask-user'])) {
        throw new Error('Packed ask-user extension capability is unavailable');
      }
      if (askUser.DEFAULT_ASK_USER_CONFIG.displayMode !== 'inline'
        || askUser.DEFAULT_ASK_USER_CONFIG.singleSelectLayout !== 'auto'
        || askUser.DEFAULT_ASK_USER_CONFIG.overlayToggleKey !== 'alt+o'
        || askUser.DEFAULT_ASK_USER_CONFIG.commentToggleKey !== 'ctrl+g') {
        throw new Error('Packed ask-user configuration defaults are unavailable');
      }
      const memory = await import('@felan-ai/ext-memory');
      const memoryCapabilities = [];
      const memoryEvents = [];
      memory.createMemoryExtension({
        role: 'root',
        host: {
          readCurrent: async () => null,
          recordCheckpoint: async () => {},
          status: async () => ({ enabled: true, state: 'idle', pendingCheckpoints: 0 }),
        },
      })({
        registerCapability: (capability) => memoryCapabilities.push(capability.id),
        on: (event) => memoryEvents.push(event),
      });
      if (JSON.stringify(memoryCapabilities) !== JSON.stringify(['memory'])) {
        throw new Error('Packed memory capability is unavailable');
      }
      if (JSON.stringify(memoryEvents) !== JSON.stringify(['session_start', 'session_compact', 'session_tree', 'agent_settled'])) {
        throw new Error('Packed memory lifecycle handlers are unavailable');
      }
      const readerEvents = [];
      memory.createMemoryExtension({
        role: 'reader',
        host: {
          readCurrent: async () => null,
          recordCheckpoint: async () => {},
          status: async () => ({ enabled: true, state: 'idle', pendingCheckpoints: 0 }),
        },
      })({
        registerCapability: () => {},
        on: (event) => readerEvents.push(event),
      });
      if (JSON.stringify(readerEvents) !== JSON.stringify(['session_start', 'session_compact', 'session_tree'])) {
        throw new Error('Packed reader memory lifecycle handlers are unavailable');
      }
      const tasks = await import('@felan-ai/ext-tasks');
      const taskTools = [];
      const taskCapabilities = [];
      tasks.default({
        runtime: {
          kind: 'packed-test',
          storage: () => ({ root: '/tmp/felan-packed-tasks' }),
        },
        registerCapability: (capability) => taskCapabilities.push(capability.id),
        registerTool: (tool) => taskTools.push(tool.name),
        on: () => {},
      });
      if (JSON.stringify(taskTools) !== JSON.stringify(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])) {
        throw new Error('Packed task extension tools differ from the canonical four: ' + taskTools.join(', '));
      }
      if (JSON.stringify(taskCapabilities) !== JSON.stringify(['tasks'])) {
        throw new Error('Packed task extension capability is unavailable');
      }
      const webAccess = await import('@felan-ai/ext-web-access');
      const webAccessTools = [];
      const webAccessCapabilities = [];
      webAccess.default({
        appendEntry: () => {},
        runtime: {
          kind: 'packed-test',
          cwd: process.env.PACKED_SMOKE_WORKSPACE,
          storage: () => ({ root: process.env.PACKED_SMOKE_WORKSPACE + '/.web-access-session' }),
        },
        registerCapability: (capability) => webAccessCapabilities.push(capability.id),
        registerTool: (tool) => webAccessTools.push(tool.name),
        on: () => {},
      });
      const expectedWebAccessTools = ['web_search', 'fetch_content'];
      if (JSON.stringify(webAccessTools) !== JSON.stringify(expectedWebAccessTools)) {
        throw new Error('Packed web access extension tools differ from the canonical two-tool surface: ' + webAccessTools.join(', '));
      }
      if (webAccessCapabilities.length !== 0) {
        throw new Error('Packed web access extension must not add always-on capability instructions');
      }
      const expectedWebAccessConfigFields = [
        'provider',
        'searchProvider',
        'openaiApiKey',
        'openaiSearchModel',
        'exaApiKey',
        'braveApiKey',
        'searxngBaseUrl',
        'searxngHeaders',
        'pdf',
        'fetchContent',
        'ssrf',
      ];
      if (JSON.stringify(Object.keys(webAccess.WEB_ACCESS_CONFIG.fields)) !== JSON.stringify(expectedWebAccessConfigFields)) {
        throw new Error('Packed web access configuration fields differ from the canonical surface');
      }
      for (const field of ['openaiApiKey', 'exaApiKey', 'braveApiKey', 'searxngHeaders']) {
        if (webAccess.WEB_ACCESS_CONFIG.fields[field].sensitive !== true) {
          throw new Error('Packed web access sensitive field is not marked sensitive: ' + field);
        }
      }
      const browser = await import('@felan-ai/ext-browser');
      const browserTools = [];
      const browserCapabilities = [];
      const browserEvents = [];
      browser.default({
        runtime: {
          kind: 'packed-test',
          cwd: process.env.PACKED_SMOKE_WORKSPACE,
          storage: (scope = 'session') => ({
            root: process.env.PACKED_SMOKE_WORKSPACE + (scope === 'agent' ? '/.browser-agent-storage' : '/.browser-session-storage'),
          }),
        },
        registerCapability: (capability) => browserCapabilities.push(capability.id),
        registerTool: (tool) => browserTools.push(tool.name),
        on: (name) => browserEvents.push(name),
      });
      if (JSON.stringify(browserTools) !== JSON.stringify(['browser'])) {
        throw new Error('Packed browser tool is unavailable');
      }
      if (JSON.stringify(browserCapabilities) !== JSON.stringify(['browser'])) {
        throw new Error('Packed browser capability is unavailable');
      }
      if (JSON.stringify(browserEvents) !== JSON.stringify(['session_shutdown'])) {
        throw new Error('Packed browser lifecycle handler is unavailable');
      }
      const markitdown = await import('@felan-ai/ext-markitdown');
      const markitdownCapabilities = [];
      const markitdownCommands = [];
      const markitdownEvents = [];
      markitdown.default({
        runtime: {
          kind: 'packed-test',
          cwd: process.env.PACKED_SMOKE_WORKSPACE,
          storage: () => ({ root: process.env.PACKED_SMOKE_WORKSPACE + '/.markitdown-storage' }),
        },
        registerCapability: (capability) => markitdownCapabilities.push(capability.id),
        registerCommand: (name) => markitdownCommands.push(name),
        on: (name) => markitdownEvents.push(name),
        events: { on: () => {}, emit: () => {} },
      });
      if (JSON.stringify(markitdownCapabilities) !== JSON.stringify(['markitdown'])) {
        throw new Error('Packed MarkItDown capability is unavailable');
      }
      if (JSON.stringify(markitdownCommands) !== JSON.stringify(['markitdown'])) {
        throw new Error('Packed MarkItDown command is unavailable');
      }
      if (JSON.stringify(markitdownEvents) !== JSON.stringify(['session_shutdown', 'tool_call', 'tool_result'])) {
        throw new Error('Packed MarkItDown read interception is unavailable');
      }
      const imageHandlers = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.gif', '.webp'];
      if (!markitdown.MARKITDOWN_EXTENSIONS.includes('.pdf')) {
        throw new Error('Packed MarkItDown extension must own PDF conversion');
      }
      if (markitdown.MARKITDOWN_EXTENSIONS.some((extension) => imageHandlers.includes(extension))
        || imageHandlers.some((extension) => !markitdown.MARKITDOWN_EXCLUDED_EXTENSIONS.includes(extension))) {
        throw new Error('Packed MarkItDown extension overlaps image handling');
      }
      const mcp = await import('@felan-ai/ext-mcp');
      const mcpTools = [];
      const mcpCapabilities = [];
      const mcpCommands = [];
      mcp.createMcpExtension({
        config: {
          mcpServers: {
            packed: { url: 'https://mcp.example.test/mcp', auth: 'oauth' },
          },
        },
        oauthHost: {
          createSession: async () => ({
            providerFor: async () => ({}),
            authenticate: async () => ({ status: 'unavailable', message: 'packed smoke' }),
            logout: async () => {},
            close: async () => {},
          }),
        },
      })({
        registerCapability: (capability) => mcpCapabilities.push(capability.id),
        registerTool: (tool) => mcpTools.push(tool.name),
        registerCommand: (name) => mcpCommands.push(name),
        on: () => {},
      });
      if (JSON.stringify(mcpTools) !== JSON.stringify(['mcp'])) {
        throw new Error('Packed MCP gateway tool is unavailable');
      }
      if (JSON.stringify(mcpCapabilities) !== JSON.stringify(['mcp'])) {
        throw new Error('Packed MCP capability is unavailable');
      }
      if (JSON.stringify(mcpCommands) !== JSON.stringify(['mcp'])) {
        throw new Error('Packed MCP commands are unavailable');
      }
      const felanApi = await import('@felan-ai/ext-felan-api');
      const felanApiTools = [];
      const felanApiCapabilities = [];
      felanApi.createFelanApiExtension({
        apiKey: 'packed-test-key',
        baseUrl: 'https://api.example.test',
        fetch: async () => new Response(JSON.stringify({ data: { ok: true } }), {
          headers: { 'content-type': 'application/json' },
        }),
      })({
        registerCapability: (capability) => felanApiCapabilities.push(capability.id),
        registerTool: (tool) => felanApiTools.push(tool),
      });
      if (JSON.stringify(felanApiTools.map((tool) => tool.name)) !== JSON.stringify(['felan_api'])) {
        throw new Error('Packed Felan API gateway tool is unavailable');
      }
      if (JSON.stringify(felanApiCapabilities) !== JSON.stringify(['felan-api'])) {
        throw new Error('Packed Felan API capability is unavailable');
      }
      const felanApiResult = await felanApiTools[0].execute('packed-api-call', {
        path: 'openapi.json',
      });
      if (felanApiResult.isError || !felanApiResult.content[0]?.text.includes('<untrusted_felan_api_content')) {
        throw new Error('Packed Felan API gateway request failed');
      }
      const core = await import('@felan-ai/agent-core');
      const fs = await import('node:fs/promises');
      const ptySessionStorage = process.env.PACKED_SMOKE_WORKSPACE + '/.pty-session';
      const ptyAgentStorage = process.env.PACKED_SMOKE_WORKSPACE + '/.pty-agent';
      await Promise.all([
        fs.mkdir(ptySessionStorage, { recursive: true }),
        fs.mkdir(ptyAgentStorage, { recursive: true }),
      ]);
      const ptyRuntime = new core.HostAgentRuntime(process.env.PACKED_SMOKE_WORKSPACE, {
        sessionStorageRoot: ptySessionStorage,
        agentStorageRoot: ptyAgentStorage,
      });
      if (!ptyRuntime.terminals) throw new Error('Packed HostAgentRuntime has no PTY capability');
      await fs.writeFile(
        process.env.PACKED_SMOKE_WORKSPACE + '/packed-pty.mjs',
        "process.stdout.write('packed-pty:' + process.stdout.isTTY)",
      );
      const terminal = await ptyRuntime.terminals.startShell(
        'node packed-pty.mjs',
        { login: false },
      );
      let terminalOffset = 0;
      let terminalOutput = '';
      let terminalSnapshot;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        terminalSnapshot = await terminal.read(terminalOffset, { waitMs: 1000 });
        terminalOffset = terminalSnapshot.nextOffset;
        terminalOutput += new TextDecoder().decode(terminalSnapshot.output);
        if (!terminalSnapshot.running) break;
      }
      await terminal.dispose();
      if (!terminalOutput.includes('packed-pty:true') || terminalSnapshot?.running !== false) {
        throw new Error('Packed HostAgentRuntime PTY smoke failed: ' + terminalOutput);
      }
      const runtime = await app.createLocalFelanRuntime({
        cwd: process.env.PACKED_SMOKE_WORKSPACE,
        agentDir: process.env.FELAN_AGENT_DIR,
      });
      const imageRuntime = new core.HostAgentRuntime(process.env.PACKED_SMOKE_WORKSPACE, {
        sessionStorageRoot: ptySessionStorage,
        agentStorageRoot: ptyAgentStorage,
      });
      await imageRuntime.writeFile(
        'packed-image.png',
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgWOUGAAGeAPFZzf6KAAAAAElFTkSuQmCC', 'base64'),
      );
      const readTool = core.createRuntimeCodingTools(imageRuntime).find((tool) => tool.name === 'read');
      const imageResult = await readTool.execute(
        'packed-image-read',
        { path: 'packed-image.png' },
        undefined,
        undefined,
        { cwd: process.env.PACKED_SMOKE_WORKSPACE, model: { input: ['text', 'image'] } },
      );
      if (!imageResult.content.some((item) => item.type === 'image' && item.mimeType === 'image/png')) {
        throw new Error('Packed runtime read tool did not return native image content');
      }
      await imageRuntime.remove('packed-image.png');
      const prompt = runtime.session.systemPrompt;
      if (!prompt.startsWith('You are Felan, an AI software development lifecycle (SDLC) and coding agent.')) {
        throw new Error('Packed runtime did not use the Agent Core base prompt');
      }
      if (prompt.includes('operating inside pi')) {
        throw new Error('Packed runtime retained the Pi base prompt');
      }
      if (prompt.includes('### web-access')) {
        throw new Error('Packed runtime retained a Web Access capability heading');
      }
      const capabilityPositions = ['### subagents', '### ask-user', '### tasks', '### prewalk', '### browser', '### markitdown', '### progressive-context']
        .map((heading) => prompt.indexOf(heading));
      if (capabilityPositions.some((position) => position < 0)
        || capabilityPositions.some((position, index) => index > 0 && position <= capabilityPositions[index - 1])) {
        throw new Error('Packed runtime capability order is incorrect');
      }
      try {
        const { testBackgroundBashTools } = await import(${JSON.stringify(new URL('./test-background-bash-tools.mjs', import.meta.url).href)});
        await testBackgroundBashTools(runtime, process.env.PACKED_SMOKE_WORKSPACE);
      } finally {
        await runtime.dispose();
      }
      process.exit(0);
    `,
  ], cleanEnvironment);

  const diagnostics = runFelan(['--diagnostics'], cleanEnvironment);
  for (const expected of [
    `Felan Code version: ${felanVersion}`,
    `Agent Core version: ${agentCoreVersion}`,
    'Pi version: 0.85.1',
    'Runtime: host',
    'Credentials: local',
  ]) {
    if (!diagnostics.stdout.includes(expected)) {
      throw new Error(`Packed felan --diagnostics output is missing ${JSON.stringify(expected)}`);
    }
  }
  const help = runFelan(['--help'], cleanEnvironment);
  if (
    !help.stdout.includes('Usage: felan [options] [message]')
    || !help.stdout.includes('-r, --resume')
    || !help.stdout.includes('--mode <text|json>')
    || !help.stdout.includes('update')
  ) {
    throw new Error('Packed felan --help did not start the local TUI CLI');
  }
  const headless = runFelanAllowFailure([
    '--mode', 'text', '--provider', 'missing-provider', '--model', 'missing-model', 'packed smoke prompt',
  ], cleanEnvironment);
  if (headless.status === 0 || headless.stdout.trim() !== '' || !headless.stderr.includes('Unknown provider')) {
    throw new Error('Packed headless Felan invocation did not fail cleanly without credentials');
  }
  await assertPackedAcpWire();
  const update = runFelanAllowFailure(['update'], cleanEnvironment);
  if (update.status === 0 || !update.stderr.includes('only supports a verified global npm installation')) {
    throw new Error('Packed felan update did not reject the isolated non-global installation');
  }
  const versionResult = runFelan(['--version'], cleanEnvironment);
  if (versionResult.stdout.trim() !== felanVersion) {
    throw new Error(`Packed felan --version reported ${JSON.stringify(versionResult.stdout.trim())}`);
  }
  const authPath = join(agentDir, 'auth.json');
  if (existsSync(authPath) && Object.keys(JSON.parse(readFileSync(authPath, 'utf8'))).length > 0) {
    throw new Error('Credential-free packed smoke unexpectedly loaded model credentials');
  }

  if (audit) {
    runNpm(['audit', '--audit-level=high', '--prefix', installDir], cleanEnvironment);
  }
} finally {
  rmSync(installDir, { recursive: true, force: true });
}

function assertPackedToolBoundary() {
  const forbidden = [
    'spawn_agent',
    'sessions_spawn',
    'sessions_list',
    'sessions_kill',
    'sessions_steer',
    'createLocalSessionHost',
    'supportedIsolation',
    'defaultIsolation',
    'SubagentIsolation',
    'unsupported_isolation',
    'createLocalWorktree',
    'worktreePath',
    'worktreeBranch',
  ];
  for (const sourcePackage of sourcePackages) {
    const dist = join(installDir, 'node_modules', ...sourcePackage.name.split('/'), 'dist');
    for (const path of filesBelow(dist)) {
      if (path.replaceAll('\\', '/').includes('/subagents/worktree.')) {
        throw new Error(`${sourcePackage.name} packed dist contains a subagent worktree module`);
      }
      const content = readFileSync(path, 'utf8');
      for (const name of forbidden) {
        if (content.includes(name)) throw new Error(`${sourcePackage.name} packed dist contains ${name}`);
      }
    }
  }
}

function assertPackedFelanThemes() {
  const themesDirectory = join(installDir, 'node_modules', '@felan-ai', 'felan', 'dist', 'themes');
  for (const name of ['felan-light.json', 'felan-dark.json']) {
    const path = join(themesDirectory, name);
    if (!existsSync(path)) throw new Error(`Packed Felan is missing ${name}`);
    const theme = JSON.parse(readFileSync(path, 'utf8'));
    const requiredVars = ['bg', 'fg', 'surface1', 'surface2', 'surface3', 'brand', 'border', 'muted', 'success', 'warning', 'error', 'info'];
    if (theme.name !== name.slice(0, -5) || Object.keys(theme.colors ?? {}).length < 51
      || requiredVars.some((variable) => typeof theme.vars?.[variable] !== 'string')) {
      throw new Error(`Packed Felan theme ${name} is invalid`);
    }
  }
}

function assertSingleAgentCoreInstallation() {
  const installedRoots = new Set(readdirSync(installDir, {
    recursive: true,
    withFileTypes: true,
  }).filter((entry) => (
    entry.isDirectory()
    && entry.name === 'agent-core'
    && basename(entry.parentPath) === '@felan-ai'
    && basename(dirname(entry.parentPath)) === 'node_modules'
  )).map((entry) => realpathSync(join(entry.parentPath, entry.name))));
  if (installedRoots.size !== 1) {
    throw new Error(`Packed install resolved ${installedRoots.size} Agent Core copies`);
  }
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : entry.isFile() ? [path] : [];
  });
}

function validateInstalledPackage(sourcePackage) {
  const packageRoot = join(installDir, 'node_modules', ...sourcePackage.name.split('/'));
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.version !== sourcePackage.version) {
    throw new Error(`${manifest.name} packed version is ${manifest.version}, expected ${sourcePackage.version}`);
  }
  if (
    manifest.repository?.url !== 'git+https://github.com/felan-ai/felan.git'
    || manifest.repository?.directory !== sourcePackage.repository.directory
  ) {
    throw new Error(`${manifest.name} packed manifest lost public source provenance`);
  }
  for (const requiredFile of ['LICENSE', 'NOTICE', 'README.md']) {
    if (!existsSync(join(packageRoot, requiredFile))) {
      throw new Error(`${manifest.name} packed artifact is missing ${requiredFile}`);
    }
  }
  if (!existsSync(join(packageRoot, 'dist'))) {
    throw new Error(`${manifest.name} packed artifact is missing dist`);
  }
  for (const entry of readdirSync(packageRoot)) {
    if (!['dist', 'LICENSE', 'NOTICE', 'README.md', 'node_modules', 'package.json'].includes(entry)) {
      throw new Error(`${manifest.name} packed unexpected top-level entry ${entry}`);
    }
  }

  for (const [dependency, version] of Object.entries(manifest.dependencies ?? {})) {
    const sourceDependency = sourcePackagesByName.get(dependency);
    if (sourceDependency && version !== sourceDependency.version) {
      throw new Error(`${manifest.name} packed dependency ${dependency} is ${version}, expected ${sourceDependency.version}`);
    }
    if (dependency.startsWith('@felan-cloud/')) {
      throw new Error(`${manifest.name} packed private dependency ${dependency}`);
    }
    if (/workspace:|^(?:file|link|portal|git|git\+|https?|github|bitbucket):|^\.{0,2}\//.test(version)) {
      throw new Error(`${manifest.name} packed non-registry dependency ${dependency}@${version}`);
    }
  }

  if (manifest.name.startsWith('@felan-ai/ext-')) {
    if (manifest.dependencies?.['@felan-ai/agent-core'] !== undefined) {
      throw new Error(`${manifest.name} packed Agent Core as a direct dependency`);
    }
    const peerRange = manifest.peerDependencies?.['@felan-ai/agent-core'];
    const sourcePeerRange = sourcePackage.peerDependencies?.['@felan-ai/agent-core'];
    if (peerRange !== sourcePeerRange) {
      throw new Error(
        `${manifest.name} packed Agent Core peer is ${peerRange}, expected ${sourcePeerRange}`,
      );
    }
    const compatibleMinor = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(peerRange ?? '');
    if (
      !compatibleMinor
      || Number(compatibleMinor[1]) !== agentCoreMajor
      || Number(compatibleMinor[2]) !== agentCoreMinor
      || Number(compatibleMinor[3]) > agentCorePatch
    ) {
      throw new Error(`${manifest.name} Agent Core peer ${peerRange} is incompatible with ${agentCoreVersion}`);
    }
  }

  if (manifest.name === '@felan-ai/felan') {
    const extensionSource = readFileSync(join(packageRoot, 'dist', 'extensions.js'), 'utf8');
    if (!/import\(packageName\)/.test(extensionSource)) {
      throw new Error('Packed TUI did not preserve its app-anchored native dynamic importer');
    }
  }
}

function assertPackedFelanOutputStyleDependency() {
  const felanManifest = JSON.parse(readFileSync(
    join(installDir, 'node_modules', '@felan-ai', 'felan', 'package.json'),
    'utf8',
  ));
  const outputStyleVersion = sourcePackagesByName.get('@felan-ai/ext-output-style')?.version;
  if (!outputStyleVersion) throw new Error('Output-style package is missing from the public package list');
  if (felanManifest.dependencies?.['@felan-ai/ext-output-style'] !== outputStyleVersion) {
    throw new Error(
      `Packed TUI output-style dependency is ${felanManifest.dependencies?.['@felan-ai/ext-output-style']}, expected ${outputStyleVersion}`,
    );
  }
}

function assertPackedFelanAcpPackage() {
  const packageRoot = join(installDir, 'node_modules', '@felan-ai', 'felan');
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.dependencies?.['@agentclientprotocol/sdk'] !== '1.4.0') {
    throw new Error(
      `Packed TUI ACP SDK dependency is ${manifest.dependencies?.['@agentclientprotocol/sdk']}, expected 1.4.0`,
    );
  }
  for (const file of [
    'dist/acp/interactions.js',
    'dist/acp/login.js',
    'dist/acp/server.js',
    'dist/acp/session-registry.js',
    'dist/acp/session-updates.js',
    'dist/acp/stdio.js',
  ]) {
    if (!existsSync(join(packageRoot, file))) {
      throw new Error(`Packed TUI is missing compiled ACP module ${file}`);
    }
  }
  if (existsSync(join(packageRoot, 'dist/acp/session-mcp.js'))) {
    throw new Error('Packed TUI contains the removed ACP session MCP implementation');
  }
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: installDir,
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}${result.error ? `: ${result.error.message}` : ''}`);
  }
  return result;
}

function runFelan(args, env = process.env) {
  return run(felan, [...felanArguments, ...args], env);
}

function runFelanAllowFailure(args, env = process.env) {
  return runAllowFailure(felan, [...felanArguments, ...args], env);
}

function runAllowFailure(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: installDir,
    encoding: 'utf8',
    env,
  });
  if (result.error) throw result.error;
  return result;
}

function runNpm(args, env = process.env) {
  return run(npm, [...npmArguments, ...args], env);
}

async function assertPackedAcpWire() {
  const registryInitialize = {
    protocolVersion: 1,
    clientInfo: { name: 'ACP Registry Validator', version: '1.0.0' },
    clientCapabilities: {
      terminal: true,
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      _meta: {
        terminal_output: true,
        'terminal-auth': true,
      },
    },
  };
  const stableInitialize = {
    protocolVersion: 1,
    clientCapabilities: {
      auth: { terminal: true },
      elicitation: { form: {} },
    },
    clientInfo: { name: 'packed-smoke', version: '1.0.0' },
  };

  const unauthenticated = createPackedAcpClient();
  try {
    const initialized = await unauthenticated.request(1, 'initialize', registryInitialize);
    if (
      initialized.result?.protocolVersion !== 1
      || initialized.result?.agentCapabilities?.loadSession !== true
      || initialized.result?.agentInfo?.name !== 'felan'
      || initialized.result?.agentInfo?.title !== 'Felan Code'
      || initialized.result?.authMethods?.length !== 1
      || initialized.result?.authMethods?.[0]?.id !== 'felan-terminal-login'
      || initialized.result?.authMethods?.[0]?.name !== 'Log in to Felan Code'
      || initialized.result?.authMethods?.[0]?.type !== 'terminal'
      || JSON.stringify(initialized.result?.authMethods?.[0]?.args) !== JSON.stringify(['login'])
    ) {
      throw new Error(`Packed ACP initialize response is invalid: ${JSON.stringify(initialized)}`);
    }
    const rejectedSession = await unauthenticated.request(2, 'session/new', {
      cwd: workspace,
      mcpServers: [],
    });
    if (rejectedSession.error?.code !== -32000) {
      throw new Error(`Packed ACP did not require authentication: ${JSON.stringify(rejectedSession)}`);
    }
    await unauthenticated.end();
  } finally {
    await unauthenticated.stop();
  }

  const modelRequest = Promise.withResolvers();
  const modelServer = createServer((_request, _response) => modelRequest.resolve());
  await new Promise((resolveListen, rejectListen) => {
    modelServer.once('error', rejectListen);
    modelServer.listen(0, '127.0.0.1', resolveListen);
  });
  let authenticated;
  try {
    const address = modelServer.address();
    if (!address || typeof address === 'string') throw new Error('Packed model test server has no TCP address');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'auth.json'), JSON.stringify({
      anthropic: { type: 'api_key', key: 'packed-placeholder-key' },
    }), { mode: 0o600 });
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({
      providers: {
        anthropic: { baseUrl: `http://127.0.0.1:${address.port}` },
      },
    }));
    authenticated = createPackedAcpClient();
    const secondInitialize = await authenticated.request(1, 'initialize', stableInitialize);
    if (
      secondInitialize.result?.protocolVersion !== 1
      || secondInitialize.result?.agentInfo?.title !== 'Felan Code'
      || secondInitialize.result?.authMethods?.[0]?.type !== 'terminal'
    ) {
      throw new Error(`Packed authenticated ACP initialize failed: ${JSON.stringify(secondInitialize)}`);
    }
    const created = await authenticated.request(2, 'session/new', {
      cwd: workspace,
      mcpServers: [
        {
          name: 'ignored-local',
          command: join(installDir, 'missing-mcp-executable'),
          args: [],
          env: [],
        },
        {
          type: 'http',
          name: 'ignored-remote',
          url: 'http://127.0.0.1:1/mcp',
          headers: [],
        },
      ],
    });
    const sessionId = created.result?.sessionId;
    if (typeof sessionId !== 'string' || !sessionId) {
      throw new Error(`Packed authenticated ACP session creation failed: ${JSON.stringify(created)}`);
    }
    const prompt = authenticated.request(3, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Wait until this request is cancelled.' }],
    });
    await authenticated.waitForNotification((message) => (
      message.method === 'session/update'
      && message.params?.sessionId === sessionId
      && message.params?.update?.sessionUpdate === 'user_message_chunk'
    ));
    await withTimeout(
      modelRequest.promise,
      20_000,
      'Packed ACP model request did not reach the local test server',
    );
    authenticated.notify('session/cancel', { sessionId });
    const promptResponse = await prompt;
    if (promptResponse.result?.stopReason !== 'cancelled') {
      throw new Error(`Packed ACP prompt cancellation failed: ${JSON.stringify(promptResponse)}`);
    }
    const closed = await authenticated.request(4, 'session/close', { sessionId });
    if (closed.error !== undefined || JSON.stringify(closed.result) !== '{}') {
      throw new Error(`Packed ACP session close failed: ${JSON.stringify(closed)}`);
    }
    await authenticated.end();
  } finally {
    try {
      await authenticated?.stop();
    } finally {
      modelServer.closeAllConnections();
      await new Promise((resolveClose) => modelServer.close(resolveClose));
      if (existsSync(agentDir)) writeFileSync(join(agentDir, 'auth.json'), '{}\n', { mode: 0o600 });
    }
  }
  console.log('Validated packed Felan ACP wire framing, cancellation, close, and process cleanup');
}

function createPackedAcpClient() {
  const child = spawn(felan, [...felanArguments, 'acp'], {
    cwd: workspace,
    env: cleanEnvironment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = new Map();
  const notifications = [];
  const waiters = new Set();
  let stdoutBuffer = '';
  const stdoutDecoder = new TextDecoder();
  let stderr = '';
  let failure;
  let exit;
  let resolveExited;
  const exited = new Promise((resolveExit) => { resolveExited = resolveExit; });

  const wake = () => {
    for (const waiter of [...waiters]) waiter();
  };
  const fail = (error) => {
    failure ??= error instanceof Error ? error : new Error(String(error));
    wake();
  };
  child.once('error', fail);
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-64 * 1024);
  });
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += stdoutDecoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(stdoutBuffer) > 8 * 1024 * 1024) {
      fail(new Error('Packed ACP stdout line exceeded the test limit'));
      return;
    }
    let newline = stdoutBuffer.indexOf('\n');
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') {
          throw new Error(`Invalid ACP frame: ${line.slice(0, 200)}`);
        }
        if ('id' in message) responses.set(message.id, message);
        else notifications.push(message);
      } catch (error) {
        fail(new Error(`Packed ACP stdout contained non-JSON-RPC output: ${error instanceof Error ? error.message : String(error)}`));
      }
      newline = stdoutBuffer.indexOf('\n');
    }
    wake();
  });
  child.once('close', (code, signal) => {
    stdoutBuffer += stdoutDecoder.decode();
    if (stdoutBuffer.length > 0) fail(new Error('Packed ACP stdout ended with an unterminated frame'));
    exit = { code, signal };
    resolveExited(exit);
    wake();
  });

  const waitFor = async (read, label, timeoutMs = 20_000) => {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (failure) throw failure;
      const value = read();
      if (value !== undefined) return value;
      if (exit) throw new Error(`Packed ACP exited before ${label}: ${JSON.stringify(exit)}\n${stderr}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for packed ACP ${label}\n${stderr}`);
      await new Promise((resolveWait) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          waiters.delete(finish);
          resolveWait();
        };
        const timeout = setTimeout(finish, remaining);
        waiters.add(finish);
      });
    }
  };
  const send = (message) => {
    if (!child.stdin.write(`${JSON.stringify(message)}\n`)) {
      return new Promise((resolveWrite, rejectWrite) => {
        child.stdin.once('drain', resolveWrite);
        child.stdin.once('error', rejectWrite);
      });
    }
    return Promise.resolve();
  };

  return {
    async request(id, method, params) {
      await send({ jsonrpc: '2.0', id, method, params });
      return waitFor(() => responses.get(id), `response ${id}`);
    },
    notify(method, params) {
      void send({ jsonrpc: '2.0', method, params }).catch(fail);
    },
    waitForNotification(predicate) {
      return waitFor(() => notifications.find(predicate), 'notification');
    },
    async end() {
      child.stdin.end();
      const result = await waitFor(() => exit, 'clean exit');
      if (result.code !== 0 || result.signal !== null) {
        throw new Error(`Packed ACP did not exit cleanly: ${JSON.stringify(result)}\n${stderr}`);
      }
      assertProcessExited(child.pid);
    },
    async stop() {
      if (!exit) child.kill('SIGTERM');
      if (!exit) await Promise.race([exited, delay(2_000)]);
      if (!exit) child.kill('SIGKILL');
      if (!exit) await Promise.race([exited, delay(5_000)]);
      if (!exit) throw new Error(`Packed ACP process did not terminate\n${stderr}`);
      assertProcessExited(child.pid);
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    const timeout = setTimeout(resolveDelay, milliseconds);
    timeout.unref?.();
  });
}

async function withTimeout(operation, milliseconds, message) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function assertProcessExited(pid) {
  if (pid === undefined) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === 'ESRCH') return;
    throw error;
  }
  throw new Error(`Packed ACP process ${pid} is still running`);
}
