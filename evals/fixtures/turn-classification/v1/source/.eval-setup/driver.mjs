import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { scenarios, policy } from './scenarios.mjs';
import { createTransport, digest, measureNativeRuntime, sumKnown } from './transport.mjs';

export async function treeIdentity(root) {
  const files = {};
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), name + '/');
      else if (entry.isFile()) files[name] = digest(await readFile(join(directory, entry.name), 'utf8'));
      else throw new Error('Fixture must contain ordinary files only');
    }
  }
  await walk(root);
  return { digest: digest(files), fileCount: Object.keys(files).length };
}

export async function drain(session, host) {
  // Completion delivery can schedule a parent turn after the original prompt resolves.
  do { await delay(20); } while (session.isStreaming || host.hasPendingWork());
}

export async function runScenario({ core, felan, modelRuntime, mode, modelId, id, workspace, source }) {
  if (!Object.hasOwn(scenarios, id) || !['shared','disabled','separated'].includes(mode) || !policy.models.includes(modelId)) throw new Error('Invalid benchmark configuration');
  const cwd = join(workspace, 'project');
  const projectIdentity = await treeIdentity(cwd);
  const driverIdentity = await treeIdentity(join(workspace, '.eval-setup'));
  const fixture = { digest: digest({ projectIdentity, driverIdentity }), fileCount: projectIdentity.fileCount + driverIdentity.fileCount };
  const models = policy.models.map(id => {
    const model = modelRuntime.getModel(policy.provider, id);
    if (!model) throw new Error('Pinned official Codex model is unavailable');
    return model;
  });
  const model = models.find(entry => entry.id === modelId);
  const classifierRequests = [], classifications = [], selections = [], phases = [], agentUsage = [];
  let native;
  if (mode !== 'disabled') {
    const classifierModel = (await modelRuntime.getAvailableOfType('classifier', 'typesafe')).find(model => model.id === policy.classifier.model);
    if (!classifierModel) throw new Error('Pinned typesafe/jev-latest is unavailable');
    native = core.createPiClassifier(measureNativeRuntime(modelRuntime, classifierRequests), classifierModel);
  }
  const classifier = createTransport(native, mode, core.validateClassifierAnswers, classifications);
  const agentDir = await mkdtemp('/tmp/felan-turn-classification-');
  let local, host, session, unsubscribe;
  const started = performance.now();
  let inputStarted, firstOutputMs = null, failed = false, manual = null;
  let stage;
  let stageStarted = started;
  const diagnostics = { schemaVersion: 1, id, mode, status: 'running', lifecycle: [], phases, selections,
    childOutcomes: [], failures: [] };
  const beginStage = name => {
    if (stage !== undefined) diagnostics.lifecycle.push({ stage, outcome: 'completed', elapsedMs: performance.now() - stageStarted });
    stage = name;
    stageStarted = performance.now();
    diagnostics.lifecycle.push({ stage, outcome: 'started', elapsedMs: stageStarted - started });
  };
  const finishStage = outcome => {
    if (stage === undefined) return;
    diagnostics.lifecycle.push({ stage, outcome, elapsedMs: performance.now() - stageStarted });
    stage = undefined;
  };
  const config = { ...policy, startingModel: modelId, mode, dynamicThinking: true, sessionMode: 'rpc' };
  beginStage('runtime-setup');
  try {
    const settings = { defaultProvider: policy.provider, defaultModel: modelId, defaultThinkingLevel: 'high',
      enabledModels: policy.models.map(id => `${policy.provider}/${id}`), felanThinking: { dynamic: true },
      builtinExtensions: Object.fromEntries(Object.entries(felan.builtinExtensionPackages).map(([name, pkg]) => [name, policy.extensions.includes(pkg)])),
      extensionConfig: { prewalk: policy.prewalk }, compaction: { enabled: false }, retry: { enabled: false } };
    await writeFile(join(agentDir, 'settings.json'), JSON.stringify(settings));
    const sessionManager = core.SessionManager.inMemory(cwd);
    const scope = ctx => ctx.sessionManager.getSessionId() === sessionManager.getSessionId() ? 'root' : 'child';
    local = await felan.createLocalFelanRuntime({ cwd, agentDir, homeDir: agentDir, modelRuntime, model,
      runtimeFactory: request => new core.HostAgentRuntime(request.cwd, { ...request, classifier }),
      sessionManager, skillPaths: [], themePaths: [],
      inlineExtensions: [{ name: 'turn-classification-observer', factory: pi => {
        pi.on('model_select', (event, ctx) => selections.push({ scope: scope(ctx), kind: 'model', model: event.model?.id ?? null, elapsedMs: performance.now() - started }));
        pi.on('thinking_level_select', (event, ctx) => selections.push({ scope: scope(ctx), kind: 'thinking', thinking: event.level, elapsedMs: performance.now() - started }));
        pi.on('context', (event, ctx) => {
          let phase = null;
          for (const message of event.messages) if (message.role === 'custom' && /^pi-prewalk:[a-z-]+$/.test(message.customType)) {
            phase = message.customType;
            phases.push({ scope: scope(ctx), kind: phase, elapsedMs: performance.now() - started });
          }
          phases.push({ scope: scope(ctx), kind: 'inference', phase, provider: ctx.model?.provider ?? null,
            model: ctx.model?.id ?? null, thinking: pi.getThinkingLevel(), elapsedMs: performance.now() - started });
        });
      } }],
    });
    beginStage('extension-binding');
    session = local.session;
    host = local.localSubagentHost;
    await session.bindExtensions({ mode: 'rpc' });
    unsubscribe = session.subscribe(event => {
      if (firstOutputMs === null && inputStarted !== undefined && event.type === 'message_update'
        && event.assistantMessageEvent?.type === 'text_delta' && event.assistantMessageEvent.delta?.length) firstOutputMs = performance.now() - inputStarted;
      if (event.type !== 'message_end') return;
      const message = event.message;
      if (message.role === 'toolResult' && message.isError === true) {
        diagnostics.failures.push({ stage: stage ?? 'session-prompt', category: 'tool-call-failed' });
      }
      if (message.role === 'custom' && /^pi-prewalk:[a-z-]+$/.test(message.customType)) phases.push({ scope: 'root', kind: message.customType, elapsedMs: performance.now() - started });
      if (message.role !== 'assistant') return;
      if (message.stopReason === 'error' || message.stopReason === 'aborted') failed = true;
      agentUsage.push({ inputTokens: sumKnown([message.usage?.input, message.usage?.cacheRead, message.usage?.cacheWrite]),
        outputTokens: message.usage?.output ?? null, costUsd: null });
    });
    finishStage('completed');
    beginStage('session-prompt');
    inputStarted = performance.now();
    try {
      if (id === 'recovery') {
        await session.prompt('/prewalk');
        await drain(session, host);
        session.setThinkingLevel('low');
        manual = { requestedThinking: 'low', afterOverride: session.thinkingLevel };
      }
      await session.prompt(scenarios[id]);
      await drain(session, host);
      if (manual) {
        manual.afterTask = session.thinkingLevel;
        await session.prompt('Recovery check: re-run node checks.mjs; keep the manual thinking selection and do not change more files.');
        await drain(session, host);
        manual.afterRecovery = session.thinkingLevel;
      }
    } catch { failed = true; await drain(session, host); }
    const children = host.getUsage();
    const childRecords = host.listLocalSubagents();
    if (childRecords.some(child => ['failed', 'timed_out', 'cancelled'].includes(child.status))) failed = true;
    diagnostics.childOutcomes = childRecords.map(child => ({ status: safeChildStatus(child.status) }));
    if (failed) diagnostics.failures.push({ stage, category: childRecords.some(child => ['failed', 'timed_out', 'cancelled'].includes(child.status))
      ? 'child-session-failed' : 'assistant-turn-failed' });
    finishStage(failed ? 'failed' : 'completed');
    const classifierUsage = { requests: classifierRequests.length,
      inputTokens: sumKnown(classifierRequests.map(row => row.inputTokens)), outputTokens: sumKnown(classifierRequests.map(row => row.outputTokens)),
      costUsd: sumKnown(classifierRequests.map(row => row.costUsd)) };
    const agent = { inputTokens: sumKnown([...agentUsage.map(row => row.inputTokens), sumKnown([children.input, children.cacheRead, children.cacheWrite])]),
      outputTokens: sumKnown([...agentUsage.map(row => row.outputTokens), children.output]), costUsd: null };
    const result = { schemaVersion: 1, id, mode, status: failed ? 'failed' : 'completed', source,
      fixture: { name: 'turn-classification', version: 'v1', ...fixture }, config, configDigest: digest(config), promptDigest: digest(scenarios[id]),
      classifications, classifierRequests, counts: { logicalClassifications: classifications.length,
        questions: classifications.reduce((n,r) => n+r.questionCount, 0), classifierProviderRequests: classifierRequests.length,
        rootAssistantMessages: agentUsage.length, directChildSessions: childRecords.length },
      usage: { classifier: classifierUsage, agent, combined: { inputTokens: sumKnown([classifierUsage.inputTokens, agent.inputTokens]),
        outputTokens: sumKnown([classifierUsage.outputTokens, agent.outputTokens]), costUsd: sumKnown([classifierUsage.costUsd, agent.costUsd]) } },
      timing: { elapsedMs: performance.now() - started, inputToFirstOutputMs: firstOutputMs }, selections, phases, manual,
      limitations: ['Codex subscription USD cost is unknown; zero catalog prices are not free usage.', 'Provider-backed driver and asynchronous delivery require authorized validation; no savings established.'] };
    diagnostics.status = failed ? 'failed' : 'completed';
    beginStage('result-writing');
    await mkdir(join(workspace, '.eval-output'), { recursive: true });
    await writeFile(join(workspace, '.eval-output/result.json'), JSON.stringify(result, null, 2) + '\n');
    finishStage('completed');
    return result;
  } catch {
    diagnostics.status = 'failed';
    diagnostics.failures.push({ stage, category: 'driver-operation-failed' });
    finishStage('failed');
    throw new Error('Turn-classification driver failed; see sanitized diagnostics.');
  } finally {
    unsubscribe?.();
    beginStage('runtime-disposal');
    try {
      await local?.dispose();
    } catch {
      diagnostics.status = 'failed';
      diagnostics.failures.push({ stage: 'runtime-disposal', category: 'runtime-dispose-failed' });
      finishStage('failed');
    }
    if (stage !== undefined) finishStage('completed');
    beginStage('diagnostic-retention');
    try {
      try {
        await mkdir(join(workspace, '.eval-output'), { recursive: true });
        await writeFile(join(workspace, '.eval-output/diagnostics.json'), JSON.stringify(diagnostics, null, 2) + '\n');
      } finally {
        finishStage('completed');
      }
    } finally {
      if (agentDir) await rm(agentDir, { recursive: true, force: true });
    }
  }
}

function safeChildStatus(status) {
  return ['completed', 'failed', 'timed_out', 'cancelled', 'running', 'pending'].includes(status)
    ? status : 'unknown';
}
