import { findPackageJSON } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createScenario } from './scenarios.mjs';

export async function loadComposition(coreEntry, felanEntry) {
  const core = await import(pathToFileURL(coreEntry).href);
  const felan = await import(pathToFileURL(felanEntry).href);
  const manifestPath = findPackageJSON('@earendil-works/pi-coding-agent', pathToFileURL(coreEntry));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  return { core, felan, piVersion: manifest.version };
}

export async function runScenario({ composition, modelRuntime, model, thinking, id, mode, cwd, agentDir }) {
  if (!['off', 'on', 'only'].includes(mode)) throw new Error('Unknown code-mode mode');
  const { core, felan } = composition;
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const scenario = await createScenario(id, cwd);
  await writeFile(join(agentDir, 'settings.json'), JSON.stringify({
    codemode: { mode },
    builtinExtensions: Object.fromEntries(Object.keys(felan.builtinExtensionPackages).map(name => [name, false])),
    compaction: { enabled: false }, retry: { enabled: false },
  }));
  const local = await felan.createLocalFelanRuntime({
    cwd, agentDir, modelRuntime, model, thinkingLevel: thinking, homeDir: agentDir, skillPaths: [],
    runtimeFactory: request => new core.HostAgentRuntime(request.cwd, request),
    sessionManager: core.SessionManager.inMemory(cwd),
    inlineExtensions: [{ name: 'codemode-scenario-tools', factory: pi => {
      for (const tool of scenario.tools) pi.registerTool(tool);
    } }],
  });
  const { session } = local;
  let unsubscribe = () => {};
  try {
    await session.bindExtensions({ mode: 'print' });
    const active = session.getActiveToolNames();
    if (active.includes('codemode') !== (mode !== 'off')) throw new Error('Felan config did not activate the expected code mode');
    const tools = scenario.tools.length ? scenario.tools.map(tool => tool.name) : ['read', 'write', 'edit', 'bash'];
    session.setActiveToolsByName([...tools, ...active.filter(name => name === 'codemode')]);
    unsubscribe = session.subscribe(event => {
      if (event.type === 'message_end' || event.type.startsWith('tool_execution_')) console.log(JSON.stringify(event));
    });
    let executionError = false;
    try {
      await session.prompt(scenario.prompt);
    } catch {
      executionError = true;
    }
    const messages = session.messages;
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
    try {
      await local.localSubagentHost.shutdown();
    } finally {
      await local.dispose();
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const [id, mode, provider, modelId, thinking = 'xhigh'] = process.argv.slice(2);
  const coreEntry = '/usr/local/lib/node_modules/@felan-ai/agent-core/dist/index.js';
  const composition = await loadComposition(coreEntry, '/usr/local/lib/node_modules/@felan-ai/felan/dist/index.js');
  const authDir = process.env.FELAN_AGENT_DIR;
  if (!authDir) throw new Error('An isolated authenticated agent directory is required');
  const modelRuntime = await composition.core.ModelRuntime.create({ authPath: join(authDir, 'auth.json'), modelsPath: join(authDir, 'models.json') });
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) throw new Error('Requested benchmark model is unavailable');
  const result = await runScenario({ composition, modelRuntime, model, thinking, id, mode,
    cwd: '/workspace/project', agentDir: '/workspace/.eval-agent' });
  await mkdir('/workspace/.eval-output', { recursive: true });
  await writeFile('/workspace/.eval-output/result.json', `${JSON.stringify(result, null, 2)}\n`);
}
