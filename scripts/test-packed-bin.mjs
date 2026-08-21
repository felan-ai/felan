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
import { spawnSync } from 'node:child_process';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(root, '.artifacts');
const installDir = mkdtempSync(join(tmpdir(), 'felan-packed-bin-'));
const cleanHome = join(installDir, 'home');
const cacheDir = join(installDir, 'npm-cache');
const workspace = join(installDir, 'workspace');
const agentDir = join(cleanHome, '.felan');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const binDirectory = join(installDir, 'node_modules', '.bin');
const felan = join(binDirectory, process.platform === 'win32' ? 'felan.cmd' : 'felan');
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

  run(npm, [
    'install',
    '--ignore-scripts',
    '--no-fund',
    '--prefix',
    installDir,
    ...tarballs,
  ], cleanEnvironment);

  for (const sourcePackage of sourcePackages) validateInstalledPackage(sourcePackage);
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
      const expectedWebAccessTools = ['web_search', 'source_check', 'fetch_content', 'get_search_content'];
      if (JSON.stringify(webAccessTools) !== JSON.stringify(expectedWebAccessTools)) {
        throw new Error('Packed web access extension tools differ from the canonical four: ' + webAccessTools.join(', '));
      }
      if (JSON.stringify(webAccessCapabilities) !== JSON.stringify(['web-access'])) {
        throw new Error('Packed web access extension capability is unavailable');
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
      });
      if (JSON.stringify(markitdownCapabilities) !== JSON.stringify(['markitdown'])) {
        throw new Error('Packed MarkItDown capability is unavailable');
      }
      if (JSON.stringify(markitdownCommands) !== JSON.stringify(['markitdown'])) {
        throw new Error('Packed MarkItDown command is unavailable');
      }
      if (JSON.stringify(markitdownEvents) !== JSON.stringify(['tool_call', 'tool_result'])) {
        throw new Error('Packed MarkItDown read interception is unavailable');
      }
      const existingBinaryHandlers = ['.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.gif', '.webp'];
      if (markitdown.MARKITDOWN_EXTENSIONS.some((extension) => existingBinaryHandlers.includes(extension))
        || existingBinaryHandlers.some((extension) => !markitdown.MARKITDOWN_EXCLUDED_EXTENSIONS.includes(extension))) {
        throw new Error('Packed MarkItDown extension overlaps PDF or image handling');
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
      const ptyScript = "process.stdout.write('packed-pty:' + process.stdout.isTTY)";
      const terminal = await ptyRuntime.terminals.startShell(
        JSON.stringify(process.execPath) + ' -e ' + JSON.stringify(ptyScript),
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
      const prompt = runtime.session.systemPrompt;
      if (!prompt.startsWith('You are Felan, an AI software development lifecycle (SDLC) and coding agent.')) {
        throw new Error('Packed runtime did not use the Agent Core base prompt');
      }
      if (prompt.includes('operating inside pi')) {
        throw new Error('Packed runtime retained the Pi base prompt');
      }
      const capabilityPositions = ['### subagents', '### ask-user', '### tasks', '### prewalk', '### web-access', '### browser', '### markitdown', '### progressive-context']
        .map((heading) => prompt.indexOf(heading));
      if (capabilityPositions.some((position) => position < 0)
        || capabilityPositions.some((position, index) => index > 0 && position <= capabilityPositions[index - 1])) {
        throw new Error('Packed runtime capability order is incorrect');
      }
      await runtime.dispose();
    `,
  ], cleanEnvironment);

  const diagnostics = run(felan, ['--diagnostics'], cleanEnvironment);
  for (const expected of [
    `Felan version: ${felanVersion}`,
    `Agent Core version: ${agentCoreVersion}`,
    'Pi version: 0.84.2',
    'Runtime: host',
    'Credentials: local',
  ]) {
    if (!diagnostics.stdout.includes(expected)) {
      throw new Error(`Packed felan --diagnostics output is missing ${JSON.stringify(expected)}`);
    }
  }
  const help = run(felan, ['--help'], cleanEnvironment);
  if (!help.stdout.includes('Usage: felan [options] [message]')) {
    throw new Error('Packed felan --help did not start the local TUI CLI');
  }
  const versionResult = run(felan, ['--version'], cleanEnvironment);
  if (versionResult.stdout.trim() !== felanVersion) {
    throw new Error(`Packed felan --version reported ${JSON.stringify(versionResult.stdout.trim())}`);
  }
  const authPath = join(agentDir, 'auth.json');
  if (existsSync(authPath) && Object.keys(JSON.parse(readFileSync(authPath, 'utf8'))).length > 0) {
    throw new Error('Credential-free packed smoke unexpectedly loaded model credentials');
  }

  if (audit) {
    run(npm, ['audit', '--audit-level=high', '--prefix', installDir], cleanEnvironment);
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

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: installDir,
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    throw new Error(`${command} exited with status ${result.status ?? 'unknown'}`);
  }
  return result;
}
