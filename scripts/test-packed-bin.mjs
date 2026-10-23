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
import { userInfo } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { pnpmPackageVersions, pnpmPinnedVersions } from './felan-shrinkwrap.mjs';
import { packagePaths } from './package-paths.mjs';

const root = resolve(import.meta.dirname, '..');
const artifacts = resolve(root, '.artifacts');
// Provider configuration must not inherit a world-writable temporary ancestor.
const packedTemporaryRoot = realpathSync(userInfo().homedir);
const installDir = mkdtempSync(join(packedTemporaryRoot, 'felan-packed-bin-'));
const cleanHome = join(installDir, 'home');
const workspace = join(installDir, 'workspace');
const agentDir = join(cleanHome, '.felan');
const daemonRuntime = join(installDir, 'daemon');
const daemonAgentDir = join(daemonRuntime, 'agent');
const npm = process.platform === 'win32' ? process.execPath : 'npm';
const npmArguments = process.platform === 'win32'
  ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  : [];
const cacheDir = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE ?? configuredNpmCache();
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
const pnpmLockfile = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8');
const cleanEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => (
    !/(TOKEN|API_KEY|AUTH|PASSWORD|SECRET|CREDENTIAL|COOKIE|SESSION|(^|_)KEY$)/i.test(name)
  )),
);

function configuredNpmCache() {
  const result = spawnSync(npm, [...npmArguments, 'config', 'get', 'cache'], { encoding: 'utf8' });
  const cache = result.stdout?.trim();
  if (result.status !== 0 || !cache || !isAbsolute(cache) || cache.includes('\0')) {
    throw new Error('Cannot resolve the configured npm cache.');
  }
  return cache;
}
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

let failure;
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

  // Local tarball installs ignore the app's shrinkwrap, so pin the versions the workspace tested.
  writeFileSync(join(installDir, 'package.json'), `${JSON.stringify({
    private: true,
    overrides: pnpmPinnedVersions(pnpmLockfile),
  }, null, 2)}\n`);
  runNpm([
    'install',
    '--ignore-scripts',
    '--no-fund',
    '--prefix',
    installDir,
    ...tarballs,
  ], cleanEnvironment);

  for (const sourcePackage of sourcePackages) validateInstalledPackage(sourcePackage);
  writeFileSync(join(artifacts, 'packed-lock.json'), readFileSync(join(installDir, 'package-lock.json')), { mode: 0o600 });
  assertPackedFelanThemes();
  assertPackedFelanOutputStyleDependency();
  assertPackedFelanAcpPackage();
  assertPackedFelanShrinkwrap();
  assertPinnedPiInstallation();
  assertPackedDaemonBoundary();
  assertSingleAgentCoreInstallation();
  assertPackedToolBoundary();
  assertManagedClaudeSdkIsNotBundled();
  await assertPackedDaemonOnly(tarballs);

  run(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      import { readFile } from 'node:fs/promises';
      const packageNames = ${JSON.stringify(packageNames)};
      await Promise.all(packageNames.map((name) => import(name)));
      const agentCore = await import('@felan-ai/agent-core');
      if (typeof agentCore.createPiClassifier !== 'function' || typeof agentCore.createLogger !== 'function') throw new Error('agent-core is missing classifier or logger exports');
      for (const name of ['createJevClassifier', 'JEV_PROVIDERS', 'JevClientError', 'createJevClient', 'OPENROUTER_DECISIONS_URL', 'TYPESAFE_SYSTEMONE_URL', 'resolveJevTransport']) {
        if (name in agentCore) throw new Error('agent-core exposes low-level Jev API: ' + name);
      }
      const classifier = agentCore.createPiClassifier({ classify: async (model, context) => ({
        api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
        answers: Object.fromEntries(Object.keys(context.questions).map(id => [id, { type: 'bool', probability: 0.8 }])),
      }) }, { type: 'classifier', provider: 'test', api: 'typesafe-system-one', id: 'test-classifier', cost: { input: 0, output: 0 } });
      if (typeof classifier.classify !== 'function' || 'evaluate' in classifier || 'evaluateProbabilities' in classifier) throw new Error('agent-core has an invalid classifier contract');
      const classifierResult = await classifier.classify({}, { ready: { type: 'bool', instructions: 'Ready?', criteria: { true: 'Yes', false: 'No' } } });
      if (classifierResult.answers.ready?.probability !== 0.8) throw new Error('packed classifier did not delegate to the model runtime');
      {
        const fusion = await import('@felan-ai/ext-fusion');
        const calls = [];
        const runtime = {
          participants: ['test/one', 'test/two'].map(reference => ({ reference, label: reference })),
          fusionModel: { reference: 'test/one', label: 'test/one' },
          resolve: reference => reference === 'test/one' ? { reference, label: reference } : undefined,
          complete: async request => {
            calls.push(request);
            return { text: 'offline response ' + request.model.reference, model: request.model.reference,
              durationMs: 1, usage: { input: 1, output: 2, totalTokens: 3, estimatedCost: 0.01 } };
          },
        };
        const review = await fusion.runFusion({ prompt: 'Offline Fusion smoke', runtime,
          config: fusion.DEFAULT_FUSION_CONFIG, signal: new AbortController().signal });
        if (calls.length !== 3 || !review.comparison || review.fused) throw new Error('Packed Fusion did not stop at reviewed comparison');
        const fused = await fusion.synthesizeFusion(review, runtime, fusion.DEFAULT_FUSION_CONFIG, new AbortController().signal);
        if (calls.length !== 4 || !fused.text.includes('offline response')) throw new Error('Packed Fusion synthesis did not run explicitly');
      }
      {
        const claudeCode = await import('@felan-ai/ext-claude-code');
        for (const name of ['inspectClaudeCodeRuntime', 'installManagedClaudeAgentSdk', 'loadClaudeAgentSdk', 'managedClaudeAgentSdkDirectory']) {
          if (typeof claudeCode[name] !== 'function') throw new Error('Packed Claude Code is missing ' + name);
        }
        if (agentCore.getExtensionConfigDefinition(claudeCode.default)?.id !== 'claude-code') {
          throw new Error('Packed Claude Code is missing its configuration definition');
        }
        const commands = [];
        const runtime = {
          kind: 'host',
          storage: () => ({ root: process.env.FELAN_AGENT_DIR + '/storage', readFile: async () => { throw new Error('No managed SDK'); } }),
          logger: { warn: () => {}, error: () => { throw new Error('Packed Claude Code activation failed'); } },
          exec: async () => { throw new Error('Packed Claude Code must not install during activation'); },
        };
        if ((await claudeCode.inspectClaudeCodeRuntime(runtime)).available) throw new Error('Packed Claude Code bundled its managed SDK');
        await claudeCode.default({
          config: {}, runtime,
          services: agentCore.createExtensionServiceAccess(agentCore.createFelanServiceRegistry(), claudeCode.default.serviceRequirements),
          registerCommand: name => commands.push(name),
          registerProvider: () => { throw new Error('Packed Claude Code registered a provider without the SDK'); },
        });
        if (JSON.stringify(commands) !== JSON.stringify(['claude-code'])) throw new Error('Packed Claude Code command is unavailable');
      }
      {
        const { createModelToolsExtension } = await import('@felan-ai/ext-model-tools');
        const imageModel = { type: 'image', provider: 'test', api: 'openai-images', id: 'test-image', name: 'Offline image',
          input: ['text', 'image'], output: ['image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        const imageData = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=';
        const imageRuntime = {
          getAvailableOfType: async (type) => {
            if (type !== 'image') throw new Error('Unexpected model discovery type');
            return [imageModel];
          },
          generateImages: async (selected, context) => {
            if (selected.provider !== imageModel.provider || selected.id !== imageModel.id || Object.keys(selected).some(key => !['provider', 'id'].includes(key))
              || context.input[0]?.text !== 'Offline packed image') throw new Error('Invalid packed image dispatch');
            return { api: imageModel.api, provider: selected.provider, model: selected.id, stopReason: 'stop', timestamp: 0,
              output: [{ type: 'image', mimeType: 'image/png', data: imageData }] };
          },
        };
        for (const hasClassifier of [false, true]) {
          for (const hasImages of [false, true]) {
            const registered = [];
            await createModelToolsExtension(hasImages ? imageRuntime : undefined)({
              runtime: hasClassifier ? { classifier } : {}, registerTool: tool => registered.push(tool.name),
            });
            const expected = [...(hasClassifier ? ['classify'] : []), ...(hasImages ? ['generate_images'] : [])];
            if (JSON.stringify(registered) !== JSON.stringify(expected)) throw new Error('Packed model tool capability mismatch');
          }
        }
        const { mkdir, readFile } = await import('node:fs/promises');
        await mkdir(process.env.FELAN_AGENT_DIR + '/model-tool-smoke', { recursive: true });
        await mkdir(process.env.FELAN_AGENT_DIR + '/storage', { recursive: true });
        const artifactRuntime = new agentCore.HostAgentRuntime(process.env.PACKED_SMOKE_WORKSPACE, {
          sessionStorageRoot: process.env.FELAN_AGENT_DIR + '/model-tool-smoke',
          agentStorageRoot: process.env.FELAN_AGENT_DIR + '/storage', classifier,
        });
        const modelTools = new Map();
        await createModelToolsExtension(imageRuntime)({ runtime: artifactRuntime, registerTool: tool => modelTools.set(tool.name, tool) });
        const judged = await modelTools.get('classify').execute('packed-classify', {
          state: { evidence: 'Offline packed test' }, questions: { ready: { type: 'bool', instructions: 'Ready?', criteria: { true: 'Yes', false: 'No' } } },
        });
        if (judged.details.answers.ready?.probability !== 0.8) throw new Error('Packed classify tool failed');
        const listed = await modelTools.get('generate_images').execute('packed-list', { action: 'list' });
        if (listed.details.models[0]?.model !== imageModel.id) throw new Error('Packed image listing failed');
        const generated = await modelTools.get('generate_images').execute('packed-generate', {
          action: 'generate', provider: imageModel.provider, model: imageModel.id, prompt: 'Offline packed image',
        });
        const imagePath = generated.details.artifacts[0]?.path;
        if (!imagePath || (await readFile(imagePath)).toString('base64') !== imageData) throw new Error('Packed image artifact was not preserved');
        if ('usage' in generated) throw new Error('Packed image tool invented absent accounting usage');
      }
      const app = await import('@felan-ai/felan');
      for (const name of ['createLocalFelanRuntime', 'createLocalSessionRuntimeFactory', 'createLocalSettingsManager', 'LocalSubagentHost', 'LocalMemoryCoordinator', 'importLocalExtension']) {
        if (name in app) throw new Error('Client package still exposes host ownership: ' + name);
      }
      if (typeof app.SessionClient !== 'function' || typeof app.runDaemonFelan !== 'function') throw new Error('Packed client APIs are missing');
      const hostExtensions = await import(new URL('./providers/extensions.js', import.meta.resolve('@felan-ai/felan')).href);
      const configuredPackages = JSON.parse(await readFile(new URL('./host.json', import.meta.resolve('@felan-ai/felan')), 'utf8')).extensions.map(extension => extension.package);
      if (!configuredPackages.includes('@felan-ai/ext-model-tools')) throw new Error('Packed daemon omitted model tools');
      if (!configuredPackages.includes('@felan-ai/ext-fusion')) throw new Error('Packed daemon omitted Fusion');
      if (!configuredPackages.includes('@felan-ai/ext-claude-code')) throw new Error('Packed daemon omitted Claude Code');
      for (const packageName of configuredPackages) {
        const extension = await hostExtensions.importLocalExtension(packageName);
        if (packageName === '@felan-ai/ext-subagents') {
          if (typeof extension.createSubagentsExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-ask-user') {
          if (typeof extension.createAskUserExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-mcp') {
          if (typeof extension.createMcpExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-memory') {
          if (typeof extension.createMemoryExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-model-tools') {
          if (typeof extension.createModelToolsExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-session-title') {
          if (typeof extension.createSessionTitleExtension !== 'function') throw new Error(packageName + ' has no configured extension factory');
        } else if (packageName === '@felan-ai/ext-session-compaction') {
          if (typeof extension.registerSessionRecall !== 'function' || typeof extension.default !== 'function') throw new Error(packageName + ' has no session compaction extension factory');
          const { SESSION_COMPACTION_CONFIG } = extension;
          if (SESSION_COMPACTION_CONFIG?.fields?.model?.default !== 'inherit') throw new Error(packageName + ' has no inherit model configuration default');
          if (JSON.stringify(SESSION_COMPACTION_CONFIG.fields.model.values) !== JSON.stringify(['inherit', 'xhigh', 'high', 'medium', 'low'])) throw new Error(packageName + ' has unexpected model configuration values');
          if (SESSION_COMPACTION_CONFIG?.fields?.method?.default !== 'summary') throw new Error(packageName + ' must default to summary compaction');
        } else if (typeof extension.default !== 'function') {
          throw new Error(packageName + ' has no extension factory');
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
      const codebaseMemoryExtension = codebaseMemory.createCodebaseMemoryExtension({
        log: (level, message) => codebaseMemoryLogs.push({ level, message }),
      });
      await codebaseMemoryExtension({
        ui: agentCore.createUnavailableExtensionUi(),
        services: agentCore.createExtensionServiceAccess(agentCore.createFelanServiceRegistry(), codebaseMemoryExtension.serviceRequirements),
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
      subagents.createSubagentsExtension({}, [{
          descriptor: {
            id: 'general',
            description: 'General agent',
            allowNesting: true,
          },
          prompt: 'Complete the assigned task.',
        }])({
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
      const askUserTools = [];
      const askUserCapabilities = [];
      askUser.default({
        ui: agentCore.createUnavailableExtensionUi(),
        registerCapability: (capability) => askUserCapabilities.push(capability.id),
        registerTool: (tool) => askUserTools.push(tool.name),
      });
      if (JSON.stringify(askUserTools) !== JSON.stringify(['ask_user'])) {
        throw new Error('Packed ask-user extension tool is unavailable');
      }
      if (JSON.stringify(askUserCapabilities) !== JSON.stringify(['ask-user'])) {
        throw new Error('Packed ask-user extension capability is unavailable');
      }
      if ('DEFAULT_ASK_USER_CONFIG' in askUser || 'ASK_USER_CONFIG' in askUser) {
        throw new Error('Packed ask-user extension still exports client-owned presentation settings');
      }
      const { defaultPresentationPreferences } = await import(${JSON.stringify(pathToFileURL(join(installDir, 'node_modules/@felan-ai/felan/dist/tui/preferences-schema.js')).href)});
      const askUserPreferences = defaultPresentationPreferences.askUser;
      if (askUserPreferences.displayMode !== 'inline'
        || askUserPreferences.singleSelectLayout !== 'auto'
        || askUserPreferences.overlayToggleKey !== 'alt+o'
        || askUserPreferences.commentToggleKey !== 'ctrl+g') {
        throw new Error('Packed client ask-user presentation defaults are unavailable');
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
      const taskCommands = [];
      tasks.default({
        ui: agentCore.createUnavailableExtensionUi(),
        runtime: {
          kind: 'packed-test',
          storage: () => ({ root: '/tmp/felan-packed-tasks' }),
        },
        registerCapability: (capability) => taskCapabilities.push(capability.id),
        registerTool: (tool) => taskTools.push(tool.name),
        registerCommand: (name) => taskCommands.push(name),
        on: () => {},
      });
      if (JSON.stringify(taskTools) !== JSON.stringify(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])) {
        throw new Error('Packed task extension tools differ from the canonical four: ' + taskTools.join(', '));
      }
      if (JSON.stringify(taskCapabilities) !== JSON.stringify(['tasks'])) {
        throw new Error('Packed task extension capability is unavailable');
      }
      if (JSON.stringify(taskCommands) !== JSON.stringify(['tasks'])) {
        throw new Error('Packed task command is unavailable');
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
        ui: agentCore.createUnavailableExtensionUi(),
        services: agentCore.createExtensionServiceAccess(agentCore.createFelanServiceRegistry(), browser.default.serviceRequirements),
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
        ui: agentCore.createUnavailableExtensionUi(),
        services: agentCore.createExtensionServiceAccess(agentCore.createFelanServiceRegistry(), markitdown.default.serviceRequirements),
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
      const explicitExtensionPath = process.env.PACKED_SMOKE_WORKSPACE + '/packed-extension.mjs';
      await fs.writeFile(explicitExtensionPath, 'export default (pi) => pi.registerCommand("packed-extension", { description: "packed extension", handler: async () => {} });');
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
      const { fileURLToPath } = await import('node:url');
      const llamaPath = fileURLToPath(import.meta.resolve('@felan-ai/felan/internal/llama/extension'));
      const { startDaemonService } = await import(new URL('./daemon/service.js', import.meta.resolve('@felan-ai/daemon')).href);
      const managerEntry = import.meta.resolve('@felan-ai/felan/daemon-host');
      const service = await startDaemonService(app.clientDaemonTarget({ daemonRuntime: process.env.PACKED_SMOKE_WORKSPACE + '/host-smoke' }), {
        manager: { packageName: '@felan-ai/felan', version: app.FELAN_VERSION, resolveFrom: managerEntry,
          resolveProvider: specifier => import.meta.resolve(specifier),
          packagedDefaultPath: fileURLToPath(new URL('./host.json', managerEntry)) },
      });
      let hostFailure;
      try {
        const binding = await service.registry.create({ cwd: process.env.PACKED_SMOKE_WORKSPACE, source: 'tui', interactiveExtensions: true,
          target: { kind: 'new' }, extensionPaths: [explicitExtensionPath, llamaPath] });
        const runtime = binding.runtime;
        if (!runtime.services.resourceLoader.getExtensions().extensions.some((extension) => (
          extension.path === explicitExtensionPath && extension.commands.has('packed-extension')
        ))) {
          throw new Error('Packed runtime did not load an explicit local Pi extension');
        }
        if (!runtime.services.resourceLoader.getExtensions().extensions.some((extension) => (
          extension.path === llamaPath && extension.commands.has('llama')
        ))) {
          throw new Error('Packed runtime did not load the bundled Pi llama.cpp integration');
        }
        if (!runtime.services.modelRuntime.getProviders().some(({ id }) => id === 'llama.cpp')) {
          throw new Error('Packed llama.cpp extension did not register its provider');
        }
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
        const capabilityPositions = ['### ask-user', '### subagents', '### tasks', '### prewalk', '### browser', '### markitdown', '### progressive-context']
          .map((heading) => prompt.indexOf(heading));
        if (capabilityPositions.some((position) => position < 0)
          || capabilityPositions.some((position, index) => index > 0 && position <= capabilityPositions[index - 1])) {
          throw new Error('Packed runtime capability order is incorrect: ' + capabilityPositions.join(', '));
        }
        const { testBackgroundBashTools } = await import(${JSON.stringify(new URL('./test-background-bash-tools.mjs', import.meta.url).href)});
        const toolClient = new app.SessionClient({ target: app.clientDaemonTarget({ daemonRuntime: process.env.PACKED_SMOKE_WORKSPACE + '/host-smoke' }),
          clientVersion: app.FELAN_VERSION, kind: 'tui' });
        try {
          await toolClient.connect();
          await toolClient.attach(binding.sessionId);
          await testBackgroundBashTools(runtime, process.env.PACKED_SMOKE_WORKSPACE,
            async () => {
              const response = await toolClient.request('session.reload', {}, { session: binding.sessionId });
              return { ...response, runtime: service.registry.binding(binding.sessionId)?.runtime };
            });
        } finally { await toolClient.close(); }
      } catch (error) {
        hostFailure = error;
        throw error;
      } finally {
        try {
          const stopped = await service.requestStop('stop', 'force');
          if (stopped.outcome !== 'accepted') throw new Error('Packed host service refused shutdown');
          await service.stopped;
        } catch (cleanup) {
          throw new AggregateError([...(hostFailure ? [hostFailure] : []), cleanup], 'Packed host service cleanup failed');
        }
      }
      process.exit(0);
    `,
  ], cleanEnvironment);

  const piVersion = JSON.parse(readFileSync(
    join(installDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'),
    'utf8',
  )).version;
  const diagnostics = runFelan(['--diagnostics'], cleanEnvironment);
  for (const expected of [
    `Felan Code version: ${felanVersion}`,
    `Agent Core version: ${agentCoreVersion}`,
    `Pi version: ${piVersion}`,
    'Runtime: local daemon client',
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
    || !help.stdout.includes('-e, --extension <path>')
    || !help.stdout.includes('update')
  ) {
    throw new Error('Packed felan --help did not start the local TUI CLI');
  }
  const headless = runFelanAllowFailure([
    '--daemon-runtime', daemonRuntime, '--mode', 'text', '--provider', 'missing-provider', '--model', 'missing-model', 'packed smoke prompt',
  ], cleanEnvironment);
  if (headless.status !== 1 || headless.stdout.trim() !== '' || !/No model is available|is not available|Unknown provider/.test(headless.stderr)) {
    throw new Error(`Packed headless Felan invocation did not fail cleanly without credentials: ${JSON.stringify({
      status: headless.status, signal: headless.signal, stdout: headless.stdout.slice(0, 4096), stderr: headless.stderr.slice(0, 4096),
    })}`);
  }
  const unconfiguredDaemon = runFelan(['daemon', 'status', '--daemon-runtime', daemonRuntime], cleanEnvironment);
  if (!unconfiguredDaemon.stdout.includes('Sessions: 0; runs: 0;')
    || !unconfiguredDaemon.stdout.includes('Configure a local model provider. A Felan account is not required.')) {
    throw new Error(`Packed credential-free daemon state is invalid: ${unconfiguredDaemon.stdout}`);
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
  for (const root of [agentDir, daemonAgentDir]) {
    const authPath = join(root, 'auth.json');
    if (existsSync(authPath) && Object.keys(JSON.parse(readFileSync(authPath, 'utf8'))).length > 0) {
      throw new Error('Credential-free packed smoke unexpectedly loaded model credentials');
    }
  }

  if (audit) {
    runNpm(['audit', '--audit-level=high', '--prefix', installDir], cleanEnvironment);
  }
} catch (error) {
  failure = error;
  throw error;
} finally {
  try {
    if (existsSync(felan) && existsSync(daemonRuntime)) stopPackedDaemon();
    rmSync(installDir, { recursive: true, force: true });
  } catch (cleanup) {
    throw new AggregateError([...(failure ? [failure] : []), cleanup], `Packed smoke cleanup failed; retained ${installDir}`);
  }
}

function stopPackedDaemon() {
  runFelan(['daemon', 'stop', '--daemon-runtime', daemonRuntime, '--force'], cleanEnvironment);
  const status = runFelan(['daemon', 'status', '--daemon-runtime', daemonRuntime], cleanEnvironment);
  if (!status.stdout.includes('Daemon is not running.')) throw new Error('Packed smoke daemon remained running');
}

async function assertPackedDaemonOnly(tarballs) {
  const { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = await import('node:fs');
  const { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } = await import('node:path');
  const { spawn, spawnSync } = await import('node:child_process');
  const prefix = realpathSync(mkdtempSync(join(packedTemporaryRoot, 'dpk-')));
  const records = [];
  let probe;
  let environment;
  let failure;
  let report;
  let runtimeDirectory;
  const deadline = (promise, label, milliseconds) => {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Daemon-only ${label} deadline`)), milliseconds);
    })]).finally(() => clearTimeout(timer));
  };
  const runHere = (command, args, timeout = 20_000) => {
    const result = spawnSync(command, args, { cwd: prefix, env: environment, encoding: 'utf8',
      timeout, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, shell: false });
    if (result.error || result.status !== 0 || result.signal) {
      throw new Error(`Daemon-only subprocess failed: ${result.error?.message ?? result.status ?? result.signal}\n${(result.stdout ?? '').slice(-4096)}\n${(result.stderr ?? '').slice(-4096)}`);
    }
    return result.stdout;
  };
  const start = (entrypoint, target) => {
    const child = spawn(process.execPath, [entrypoint, JSON.stringify(target), '--foreground'], {
      cwd: prefix, env: environment, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    const record = { child, stdout: '', stderr: '', bytes: { stdout: 0, stderr: 0 }, listeners: new Set(), result: undefined, fault: undefined };
    records.push(record);
    const notify = () => { for (const listener of record.listeners) listener(); };
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      record.bytes[name] += chunk.byteLength;
      record[name] = (record[name] + chunk.toString('utf8')).slice(-65_536);
      if (record.bytes[name] > 65_536) record.fault ??= new Error(`Daemon-only ${name} exceeded 64 KiB`);
      notify();
    });
    child.on('error', error => { record.fault ??= error; notify(); });
    record.closed = new Promise(resolveClose => child.once('close', (code, signal) => {
      record.result = { code, signal }; notify(); resolveClose(record.result);
    }));
    return record;
  };
  const ready = async (record, version) => {
    let check;
    const work = new Promise((resolveReady, reject) => {
      check = () => {
        if (record.fault) reject(record.fault);
        else if (record.result) reject(new Error(`Daemon-only exited before readiness: ${JSON.stringify(record.result)}\n${record.stderr}`));
        else if (record.stdout.split(/\r?\n/u).includes(`Felan daemon ${version}: ready`)) resolveReady();
      };
      record.listeners.add(check); check();
    });
    try { await deadline(work, 'readiness', 15_000); }
    catch (error) {
      const diagnostics = runtimeDirectory ? ['stderr.log', 'stdout.log'].flatMap(name => {
        const path = join(runtimeDirectory, name);
        if (!existsSync(path)) return [];
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) return [];
        return [`${name}: ${readFileSync(path).subarray(-4096).toString('utf8')}`];
      }).join('\n') : '';
      throw new Error(`${error.message}\n${record.stdout.slice(-4096)}\n${record.stderr.slice(-4096)}\n${diagnostics}`, { cause: error });
    }
    finally { record.listeners.delete(check); }
  };
  try {
    const combined = realpathSync(installDir);
    const rel = relative(combined, prefix);
    if (!rel || !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel)) throw new Error('Daemon-only prefix must be independent of the combined install');
    const names = new Map([...sourcePackagesByName].map(([name, manifest]) => [
      `${name.replace(/^@/u, '').replaceAll('/', '-')}-${manifest.version}.tgz`, name,
    ]));
    const seen = new Set(); const selected = [];
    const selectedNames = new Set(['@felan-ai/daemon', '@felan-ai/agent-core', '@felan-ai/session-protocol']);
    for (const tarball of tarballs) {
      const name = names.get(basename(tarball));
      if (!name || seen.has(name)) throw new Error(`Unexpected or duplicate packed artifact: ${basename(tarball)}`);
      seen.add(name); if (selectedNames.has(name)) selected.push(realpathSync(tarball));
    }
    if (seen.size !== sourcePackagesByName.size || !seen.has('@felan-ai/felan')) throw new Error('Daemon-only check requires the complete packed artifact set');
    const home = join(prefix, 'h'); const temporary = join(prefix, 't');
    const target = { kind: 'isolated', directory: join(prefix, 'd'), namespaceId: basename(prefix) };
    const agent = join(target.directory, 'agent');
    for (const directory of [home, temporary, target.directory, join(home, 'config'), join(home, 'cache'), join(home, 'data')]) mkdirSync(directory, { mode: 0o700 });
    const cache = cleanEnvironment.NPM_CONFIG_CACHE ?? cleanEnvironment.npm_config_cache;
    if (!cache || !isAbsolute(cache)) throw new Error('An explicit prepared npm cache is required');
    const searchPath = (cleanEnvironment.PATH ?? '').split(delimiter).filter(entry => {
      const path = resolve(entry || '.'); return path !== combined && !path.startsWith(`${combined}${sep}`);
    }).join(delimiter);
    environment = {
      PATH: `${join(prefix, 'node_modules', '.bin')}${delimiter}${searchPath}`,
      ...(cleanEnvironment.SystemRoot ? { SystemRoot: cleanEnvironment.SystemRoot } : {}),
      ...(cleanEnvironment.LANG ? { LANG: cleanEnvironment.LANG } : {}),
      HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_CACHE_HOME: join(home, 'cache'), XDG_DATA_HOME: join(home, 'data'),
      TMPDIR: temporary, TMP: temporary, TEMP: temporary, FELAN_AGENT_DIR: agent,
      NPM_CONFIG_CACHE: cache, npm_config_cache: cache, NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org/',
      NPM_CONFIG_USERCONFIG: join(home, '.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc'),
      PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0',
    };
    // Offline installs only see the cache primed by the pinned combined install.
    writeFileSync(join(prefix, 'package.json'), JSON.stringify({
      private: true, type: 'module', overrides: pnpmPinnedVersions(pnpmLockfile),
    }), { mode: 0o600 });
    writeFileSync(environment.NPM_CONFIG_USERCONFIG, 'registry=https://registry.npmjs.org/\n', { mode: 0o600 });
    writeFileSync(environment.NPM_CONFIG_GLOBALCONFIG, '', { mode: 0o600 });
    const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
    const npmPrefix = process.platform === 'win32' ? [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')] : [];
    runHere(npmCommand, [...npmPrefix, 'install', '--offline', '--ignore-scripts', '--no-fund', '--no-audit', '--prefix', prefix, ...selected], 180_000);
    for (const [name, expected] of sourcePackagesByName) {
      if (!selectedNames.has(name)) continue;
      const installed = JSON.parse(readFileSync(join(prefix, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'));
      if (installed.name !== name || installed.version !== expected.version) throw new Error(`Wrong daemon-only package: ${name}`);
    }
    if (existsSync(join(prefix, 'node_modules', '@felan-ai', 'felan'))) throw new Error('Client package was installed in the daemon-only prefix');
    for (const name of sourcePackagesByName.keys()) {
      if (name.startsWith('@felan-ai/ext-') && existsSync(join(prefix, 'node_modules', ...name.split('/')))) {
        throw new Error('An extension was installed in the generic daemon-only prefix: ' + name);
      }
    }
    const lock = JSON.parse(readFileSync(join(prefix, 'package-lock.json'), 'utf8'));
    if (Object.keys(lock.packages ?? {}).some(path => /(?:^|\/)node_modules\/@felan-ai\/felan$/u.test(path))) throw new Error('Client package was installed transitively');
    const providerDirectory = join(prefix, 'node_modules', '@fixture', 'host');
    mkdirSync(providerDirectory, { recursive: true });
    writeFileSync(join(providerDirectory, 'package.json'), JSON.stringify({ name: '@fixture/host', version: '0.0.0', type: 'module', exports: { './providers': './providers.mjs' } }));
    writeFileSync(join(providerDirectory, 'providers.mjs'), `
      import { HOST_RUNTIME_SERVICE, HostAgentRuntime, ModelRuntime } from '@felan-ai/agent-core';
      import { join } from 'node:path';
      import { SESSION_RUNTIME_SERVICE } from '@felan-ai/daemon/session-runtime';
      import { defineServiceProvider } from '@felan-ai/daemon/provider';
      const unavailable = () => { throw new Error('Session execution and setup are outside this lifecycle-only probe'); };
      export default defineServiceProvider({ provides: [HOST_RUNTIME_SERVICE, SESSION_RUNTIME_SERVICE], async create() {
        return { implementations: [
          { contract: HOST_RUNTIME_SERVICE, value: { create: (cwd, options) => new HostAgentRuntime(cwd, options) } },
          { contract: SESSION_RUNTIME_SERVICE, value: { configuration: async () => [],
            createModelRuntime: agentDir => ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') }),
            secretStorage: { read: unavailable, write: unavailable, remove: unavailable },
            createHostServices: async () => ({
              configuration: { get: unavailable, set: unavailable, prepare: unavailable, sessionOverrides: unavailable, sessionValues: unavailable },
              setup: { dependency: unavailable, installApprovedDependency: unavailable, catalog: unavailable,
                validateStart: unavailable, start: unavailable, read: unavailable, answer: unavailable,
                cancel: unavailable, prepareOpenLink: unavailable, disconnected() {}, beginDrain() {}, async drain() {} },
            }),
            validateConfiguration: async () => {},
            resolveEnvironment: async () => { throw new Error('Session execution is outside this lifecycle-only probe'); },
            prepare: async () => { throw new Error('Session execution is outside this lifecycle-only probe'); } } },
        ], async dispose() {} };
      } });
    `);
    probe = join(prefix, 'probe.mjs');
    writeFileSync(probe, `
      import { existsSync, realpathSync, writeFileSync } from 'node:fs';
      import { createRequire } from 'node:module';
      import { fileURLToPath } from 'node:url';
      import { join, sep } from 'node:path';
      const prefix = ${JSON.stringify(prefix)};
      const target = ${JSON.stringify(target)};
      if (realpathSync(fileURLToPath(new URL('.', import.meta.url))) !== prefix) throw new Error('Wrong probe resolution base');
      if (existsSync(join(prefix, 'node_modules', '@felan-ai', 'felan'))) throw new Error('Client unexpectedly exists');
      for (const name of ['@felan-ai/felan', '@felan-ai/felan/package.json']) {
        try { import.meta.resolve(name); throw new Error('Client unexpectedly resolves: ' + name); }
        catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
      }
      const paths = {};
      for (const name of ['@felan-ai/daemon', '@felan-ai/session-protocol']) {
        const path = realpathSync(fileURLToPath(import.meta.resolve(name)));
        if (!path.startsWith(join(prefix, 'node_modules') + sep)) throw new Error('Escaped daemon-only package resolution: ' + name);
        paths[name] = path;
      }
      const daemon = await import('@felan-ai/daemon');
      const protocol = await import('@felan-ai/session-protocol');
      if (daemon.DAEMON_VERSION !== ${JSON.stringify(sourcePackagesByName.get('@felan-ai/daemon').version)} || protocol.PROTOCOL_VERSION !== 1 || typeof protocol.encodeFrame !== 'function') throw new Error('Packed daemon/protocol imports are incomplete');
      if (process.argv[2] === 'inspect') {
        const { acquireDaemonOwnership } = await import(new URL('./daemon/ownership.js', import.meta.resolve('@felan-ai/daemon')));
        const owner = await acquireDaemonOwnership(target);
        const runtimeDirectory = owner.target.runtimeDirectory;
        try {
          writeFileSync(join(owner.target.agentDir, 'host.json'), JSON.stringify({ version: 1, services: [
            { id: 'felan.runtime', major: 1, use: '@fixture/host/providers' },
            { id: 'felan.session-runtime', major: 1, use: '@fixture/host/providers' },
          ], extensions: [], policy: { projectTrust: 'ask', dependencyInstalls: 'ask' } }), { mode: 0o600 });
        } finally { await owner.release(); }
        const piTui = realpathSync(createRequire(paths['@felan-ai/daemon']).resolve('@earendil-works/pi-tui'));
        if (!piTui.startsWith(join(prefix, 'node_modules') + sep)) throw new Error('Escaped Pi TUI dependency resolution');
        console.log(JSON.stringify({ entrypoint: paths['@felan-ai/daemon'], version: daemon.DAEMON_VERSION, piTui: true, runtimeDirectory }));
      } else {
        const { acquireDaemonOwnership } = await import(new URL('./daemon/ownership.js', import.meta.resolve('@felan-ai/daemon')));
        let owner;
        try { owner = await acquireDaemonOwnership(target); }
        catch (error) { if (process.argv[2] !== 'busy' || error.code !== 'owner_running') throw error; console.log('busy'); }
        if (owner) {
          try { owner.assertCurrent(); }
          finally { await owner.release(); }
          if (process.argv[2] !== 'released') throw new Error('Foreground daemon no longer holds its ownership locks');
          console.log('released');
        }
      }
    `, { mode: 0o600 });
    const installed = JSON.parse(runHere(process.execPath, [probe, 'inspect']));
    if (typeof installed.runtimeDirectory !== 'string' || !installed.runtimeDirectory.startsWith(`${prefix}${sep}`)) throw new Error('Daemon diagnostic directory escaped the isolated prefix');
    runtimeDirectory = installed.runtimeDirectory;
    for (let cycle = 0; cycle < 2; cycle++) {
      const record = start(installed.entrypoint, target);
      await ready(record, installed.version);
      if (runHere(process.execPath, [probe, 'busy']).trim() !== 'busy') throw new Error('Missing live ownership proof');
      if (record.child.exitCode !== null || record.child.signalCode !== null || !record.child.kill('SIGTERM')) throw new Error('Foreground daemon did not remain alive until SIGTERM');
      const result = await deadline(record.closed, 'SIGTERM join', 15_000);
      if (record.fault || result.code !== 0 || result.signal !== null) throw record.fault ?? new Error(`Daemon-only stop failed: ${JSON.stringify(result)}\n${record.stderr}`);
      if (runHere(process.execPath, [probe, 'released']).trim() !== 'released') throw new Error('Daemon ownership was not released');
    }
    report = `Daemon-only packed install: ${selected.length} packages; client absent; two foreground cycles passed; transitive pi-tui remains.`;
  } catch (error) { failure = error; }
  const cleanupErrors = [];
  for (const record of records) {
    if (record.result) continue;
    try {
      if (record.child.pid) record.child.kill('SIGTERM');
      try { await deadline(record.closed, 'cleanup SIGTERM join', 5_000); }
      catch {
        if (record.child.pid) record.child.kill('SIGKILL');
        await deadline(record.closed, 'cleanup SIGKILL join', 5_000);
      }
    } catch (error) { cleanupErrors.push(error); }
  }
  if (records.length && !cleanupErrors.length) {
    try { if (runHere(process.execPath, [probe, 'released']).trim() !== 'released') throw new Error('Cleanup ownership release was not verified'); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (!cleanupErrors.length) {
    try { rmSync(prefix, { recursive: true, force: true }); }
    catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors], `Daemon-only cleanup failed; retained ${prefix}`);
  if (failure) throw failure;
  console.log(report);
}

// npm installs the published app from its shrinkwrap, so every pinned package must come from the
// registry at a version the workspace resolved and tested.
function assertPackedFelanShrinkwrap() {
  const shrinkwrapPath = join(installDir, 'node_modules', '@felan-ai', 'felan', 'npm-shrinkwrap.json');
  const { packages } = JSON.parse(readFileSync(shrinkwrapPath, 'utf8'));
  const testedVersions = pnpmPackageVersions(pnpmLockfile);
  for (const [path, entry] of Object.entries(packages)) {
    if (path === '') continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!entry.resolved?.startsWith('https://registry.npmjs.org/')) {
      throw new Error(`Packed Felan shrinkwrap resolves ${path} outside the public registry`);
    }
    const expected = sourcePackagesByName.get(name)?.version;
    if (expected ? entry.version !== expected : !testedVersions.get(name)?.has(entry.version)) {
      throw new Error(`Packed Felan shrinkwrap pins untested ${name}@${entry.version}`);
    }
  }
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
  if (existsSync(join(installDir, 'node_modules', '@felan-ai', 'daemon', 'dist', 'themes'))) {
    throw new Error('Packed daemon must not include client themes');
  }
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

function assertPinnedPiInstallation() {
  const core = JSON.parse(readFileSync(join(installDir, 'node_modules', '@felan-ai', 'agent-core', 'package.json'), 'utf8'));
  const expected = core.dependencies['@earendil-works/pi-coding-agent'];
  const packages = ['pi-agent-core', 'pi-ai', 'pi-codemode', 'pi-coding-agent', 'pi-mcp', 'pi-telemetry', 'pi-tui'];
  for (const name of packages) {
    if (core.dependencies[`@earendil-works/${name}`] !== expected) {
      throw new Error(`Agent Core must pin ${name} to ${expected}`);
    }
  }
  const lock = JSON.parse(readFileSync(join(installDir, 'package-lock.json'), 'utf8'));
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (/(?:^|\/)node_modules\/@earendil-works\/pi-[^/]+$/.test(path) && metadata.version !== expected) {
      throw new Error(`Packed Pi dependency ${path} is ${metadata.version}, expected ${expected}`);
    }
  }
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : entry.isFile() ? [path] : [];
  });
}

function assertManagedClaudeSdkIsNotBundled() {
  for (const path of [
    join(installDir, 'package-lock.json'),
    join(installDir, 'node_modules', '@felan-ai', 'felan', 'npm-shrinkwrap.json'),
  ]) {
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    if (Object.keys(lock.packages).some(name => name.endsWith('node_modules/@anthropic-ai/claude-agent-sdk'))) {
      throw new Error('Packed production closure contains the managed-only Claude Agent SDK');
    }
  }
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
  if (JSON.stringify(manifest.exports) !== JSON.stringify(sourcePackage.exports)) {
    throw new Error(`${manifest.name} packed exports differ from its source manifest`);
  }
  for (const [subpath, entry] of Object.entries(manifest.exports ?? {})) {
    for (const file of [entry.types, entry.import]) {
      if (!file || !existsSync(join(packageRoot, file))) {
        throw new Error(`${manifest.name} packed export ${subpath} is missing ${file}`);
      }
    }
  }
  const allowedEntries = ['dist', 'LICENSE', 'NOTICE', 'README.md', 'node_modules', 'package.json'];
  if (manifest.name === '@felan-ai/felan') {
    if (!existsSync(join(packageRoot, 'npm-shrinkwrap.json'))) {
      throw new Error(`${manifest.name} packed artifact is missing npm-shrinkwrap.json`);
    }
    allowedEntries.push('npm-shrinkwrap.json');
  }
  for (const entry of readdirSync(packageRoot)) {
    if (!allowedEntries.includes(entry)) {
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
    if (manifest.exports?.['./tui']) throw new Error(`${manifest.name} still exports client-owned TUI rendering`);
    const dataOnlyPackages = ['ext-memory', 'ext-subagents', 'ext-tasks', 'ext-context-view', 'ext-insights', 'ext-prompt-history', 'ext-background-bash', 'ext-powerline'];
    if (dataOnlyPackages.includes(manifest.name.slice('@felan-ai/'.length)) && manifest.exports?.['./view']) {
      throw new Error(`${manifest.name} still exports the removed view contract`);
    }
    if (manifest.dependencies?.['@felan-ai/agent-core'] !== undefined) {
      throw new Error(`${manifest.name} packed Agent Core as a direct dependency`);
    }
    const peerRange = manifest.peerDependencies?.['@felan-ai/agent-core'];
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

}

function assertPackedDaemonBoundary() {
  const packageRoot = join(installDir, 'node_modules', '@felan-ai', 'daemon');
  const daemon = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const client = JSON.parse(readFileSync(join(installDir, 'node_modules', '@felan-ai', 'felan', 'package.json'), 'utf8'));
  if (client.dependencies?.['@felan-ai/daemon'] !== daemon.version) {
    throw new Error('Packed client must depend on the exact daemon version');
  }
  if (daemon.dependencies?.['@felan-ai/felan'] || client.exports?.['./daemon-profile'] || daemon.exports?.['./daemon-profile']) {
    throw new Error('Packed daemon/client ownership is reversed');
  }
  if (Object.keys(daemon.dependencies ?? {}).some(name => name.startsWith('@felan-ai/ext-'))) {
    throw new Error('Packed daemon depends on an extension implementation');
  }
  if (Object.keys(daemon.exports ?? {}).some(path => path.startsWith('./internal/'))) {
    throw new Error('Packed daemon exposes private implementation modules');
  }
  const runtime = daemon.exports?.['./session-runtime'];
  if (runtime?.types !== './dist/daemon/session-runtime.d.ts' || runtime?.import !== './dist/daemon/session-runtime.js') {
    throw new Error('Packed daemon session runtime contract is missing');
  }
  for (const path of filesBelow(join(packageRoot, 'dist')).filter(path => path.endsWith('.js'))) {
    if (/(?:from\s*|import\s*\()\s*['"][^'"]*(?:@felan-ai\/(?:felan|ext-[a-z-]+)(?:\/|['"])|felan\/src\/)/.test(readFileSync(path, 'utf8'))) {
      throw new Error('Packed daemon imports a client or extension implementation');
    }
  }
  run(process.execPath, ['--input-type=module', '--eval', `
    import { resolveInstalledDaemonEntrypoint } from '@felan-ai/felan';
    import { fileURLToPath } from 'node:url';
    import { SESSION_RUNTIME_SERVICE } from '@felan-ai/daemon/session-runtime';
    process.chdir(${JSON.stringify(workspace)});
    if (resolveInstalledDaemonEntrypoint() !== fileURLToPath(import.meta.resolve('@felan-ai/felan/daemon-host'))) throw new Error('Managing daemon entrypoint resolution depends on cwd');
    if (SESSION_RUNTIME_SERVICE.key !== 'felan.session-runtime@1') throw new Error('Daemon session runtime contract changed');
  `], cleanEnvironment);
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
    'dist/acp/daemon-session.js',
    'dist/acp/login.js',
    'dist/acp/protocol-interactions.js',
    'dist/acp/protocol-updates.js',
    'dist/acp/server.js',
    'dist/acp/session-registry.js',
    'dist/acp/session-updates.js',
    'dist/acp/stdio.js',
  ]) {
    if (!existsSync(join(packageRoot, file))) {
      throw new Error(`Packed TUI is missing compiled ACP module ${file}`);
    }
  }
  for (const file of ['dist/acp/interactions.js', 'dist/acp/session-mcp.js', 'dist/safe-tools.js']) {
    if (existsSync(join(packageRoot, file))) {
      throw new Error(`Packed TUI contains removed module ${file}`);
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
  stopPackedDaemon();

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
    mkdirSync(daemonAgentDir, { recursive: true });
    writeFileSync(join(daemonAgentDir, 'auth.json'), JSON.stringify({
      anthropic: { type: 'api_key', key: 'packed-placeholder-key' },
    }), { mode: 0o600 });
    writeFileSync(join(daemonAgentDir, 'models.json'), JSON.stringify({
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
      if (existsSync(daemonAgentDir)) writeFileSync(join(daemonAgentDir, 'auth.json'), '{}\n', { mode: 0o600 });
    }
  }
  console.log('Validated packed Felan ACP wire framing, cancellation, close, and process cleanup');
}

function createPackedAcpClient() {
  const child = spawn(felan, [...felanArguments, 'acp', '--daemon-runtime', daemonRuntime], {
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
