import { findPackageJSON } from 'node:module';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScenario } from './scenarios.mjs';
import { withBenchmarkRuntime } from './runtime.mjs';

export async function loadComposition(coreEntry, felanEntry) {
  const core = await import(pathToFileURL(coreEntry).href);
  const felan = await import(pathToFileURL(felanEntry).href);
  const anchor = pathToFileURL(felanEntry);
  const daemonManifest = pathToFileURL(findPackageJSON('@felan-ai/daemon', anchor));
  const { startDaemonService } = await import(new URL('./dist/daemon/service.js', daemonManifest).href);
  const sessionRuntime = await import(new URL('./providers/session-runtime.js', anchor).href);
  const daemonClient = await import(new URL('./acp/daemon-session.js', anchor).href);
  const manifestPath = findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(coreEntry));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const providers = new Map([
    ['@felan-ai/felan/providers/runtime', new URL('./providers/runtime.js', anchor).href],
    ['@felan-ai/felan/providers/models', new URL('./providers/models.js', anchor).href],
    ['@felan-ai/felan-extension-evals/codemode-runtime', new URL('./runtime.mjs', import.meta.url).href],
  ]);
  return { core, felan, sessionRuntime, daemonClient, startDaemonService, piVersion: manifest.version,
    manager: { packageName: '@felan-ai/felan', version: felan.FELAN_VERSION, resolveFrom: anchor.href,
      resolveProvider(specifier) {
        const url = providers.get(specifier);
        if (!url) throw new Error('Provider is outside the benchmark installation');
        return url;
      } },
  };
}

export async function runScenario({ composition, createModelRuntime, model, thinking, id, mode, cwd, agentDir }) {
  if (!['off', 'on', 'only'].includes(mode)) throw new Error('Unknown code-mode mode');
  if (!model?.provider || !model.id) throw new Error('An explicit benchmark model is required');
  if (typeof createModelRuntime !== 'function') throw new Error('An explicit benchmark model runtime factory is required');
  if (basename(agentDir) !== 'agent') throw new Error('The isolated daemon agent directory must be named agent');
  const { felan, daemonClient } = composition;
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true, mode: 0o700 });
  cwd = await realpath(cwd);
  agentDir = await realpath(agentDir);
  const scenario = await createScenario(id, cwd);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    codemode: { mode },
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  await writeFile(join(agentDir, 'host.json'), JSON.stringify({ version: 1, extensions: [], services: [
    { id: 'felan.runtime', major: 1, use: '@felan-ai/felan/providers/runtime' },
    { id: 'felan.session-runtime', major: 1, use: '@felan-ai/felan-extension-evals/codemode-runtime' },
    { id: 'felan.models', major: 1, use: '@felan-ai/felan/providers/models' },
  ] }), { mode: 0o600 });
  const activation = { ready: false };
  return withBenchmarkRuntime({ composition, scenario, mode, activation }, async () => {
    const target = { kind: 'isolated', directory: dirname(agentDir), namespaceId: 'codemode-eval' };
    const daemon = await composition.startDaemonService(target, { createModelRuntime, manager: composition.manager });
    let client;
    const messages = [];
    let unsubscribe = () => {};
    try {
      client = new felan.SessionClient({ target, clientVersion: felan.FELAN_VERSION, kind: 'headless',
        capabilities: ['native.events'], expected: daemon.owner.identity, reconnectAttempts: 0 });
      await client.connect();
      if (!client.capabilities.capabilities.includes('native.events')) throw new Error('Native benchmark events are unavailable');
      const { sessionId } = daemonClient.accepted(await client.request('sessions.create', {
        cwd, model: { provider: model.provider, id: model.id }, thinking,
      }));
      let sequence = 0;
      let eventError = false;
      unsubscribe = client.subscribePresentation(envelope => {
        if (envelope.session !== sessionId) return;
        if (envelope.presentationEvent.sequence !== sequence++) eventError = true;
        const event = envelope.presentationEvent.data;
        if (event.type === 'message_end') messages.push(event.message);
        if (event.type === 'message_end' || event.type.startsWith('tool_execution_')) console.log(JSON.stringify(event));
      });
      daemonClient.accepted(await client.attach(sessionId));
      if (activation.error) throw activation.error;
      if (!activation.ready) throw new Error('Benchmark tools were not activated');
      let executionError = false;
      try {
        const { runId } = daemonClient.accepted(await client.request('prompt', { text: scenario.prompt }, { session: sessionId }));
        const snapshot = await daemonClient.waitForDaemonRun(client, sessionId, runId);
        if (snapshot.run.state === 'interrupted') executionError = true;
        daemonClient.accepted(await client.request('host.status', {}));
        if (eventError) executionError = true;
      } catch {
        executionError = true;
      }
      const last = messages.findLast(message => message.role === 'assistant');
      const finalText = (last?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
      const grade = await scenario.grade(finalText);
      const providerError = messages.some(message => message.role === 'assistant' && message.stopReason === 'error');
      if (executionError || providerError) {
        grade.passed = false;
        grade.checks.push({ name: 'execution-completed', passed: false });
      }
      return { id, arm: mode === 'off' ? 'direct' : mode, mode, provider: model.provider, model: model.id, thinking, piVersion: composition.piVersion,
        executionError, providerError, grade, finalText, messages, state: scenario.state };
    } finally {
      unsubscribe();
      client?.close();
      const stopped = await daemon.requestStop('stop', 'force');
      if (stopped.outcome !== 'accepted') throw new Error('Benchmark daemon shutdown was not accepted');
      await daemon.stopped;
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [id, mode, provider, modelId, thinking = 'xhigh'] = process.argv.slice(2);
  const coreEntry = '/usr/local/lib/node_modules/@felan-ai/agent-core/dist/index.js';
  const composition = await loadComposition(coreEntry, '/usr/local/lib/node_modules/@felan-ai/felan/dist/index.js');
  const authDir = process.env.FELAN_AGENT_DIR;
  if (!authDir) throw new Error('An isolated authenticated agent directory is required');
  const createModelRuntime = () => composition.core.ModelRuntime.create({ authPath: join(authDir, 'auth.json'), modelsPath: join(authDir, 'models.json') });
  const modelRuntime = await createModelRuntime();
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error('Requested benchmark model is unavailable');
  const result = await runScenario({ composition, createModelRuntime, model, thinking, id, mode,
    cwd: '/workspace/project', agentDir: '/workspace/.eval-daemon/agent' });
  await mkdir('/workspace/.eval-output', { recursive: true });
  await writeFile('/workspace/.eval-output/result.json', `${JSON.stringify(result, null, 2)}\n`);
}
