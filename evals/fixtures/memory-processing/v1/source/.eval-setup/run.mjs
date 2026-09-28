import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { memoryProcessingScenario } from './scenario.mjs';
import { workerReadEvidence } from './worker-evidence.mjs';

const [mode, modelId] = process.argv.slice(2);
if (!['enabled', 'disabled'].includes(mode) || !modelId) throw new Error('Memory eval mode and worker model are required');
const base = '/usr/local/lib/node_modules/@felan-ai';
const { LocalMemoryCoordinator } = await import(`${base}/felan/dist/memory/coordinator.js`);
const { createDefaultLocalMemoryDreamRunner } = await import(`${base}/felan/dist/memory/dreamer.js`);
const { createLocalModelRuntime } = await import(`${base}/felan/dist/runtime.js`);
const { localMemoryProjectDirectory, resolveLocalMemoryProject } = await import(`${base}/felan/dist/memory/project.js`);
const { createJevClassifier } = await import(`${base}/agent-core/dist/index.js`);
const { digestActiveBranch, hydrateMemoryDirectory, readMemoryDirectory, renderMemoryInspectView } = await import(`${base}/ext-memory/dist/index.js`);

const workspace = '/workspace';
const cwd = join(workspace, 'project');
const authDirectory = process.env.FELAN_AGENT_DIR;
if (!authDirectory) throw new Error('Isolated Felan agent directory is required');
if (mode === 'enabled' && !process.env.TYPESAFE_API_KEY) throw new Error('TYPESAFE_API_KEY is required for the enabled arm');
await mkdir(cwd, { recursive: true });
const agentDir = await mkdtemp('/tmp/felan-memory-eval-');
await copyFile(join(authDirectory, 'auth.json'), join(agentDir, 'auth.json'));
await chmod(join(agentDir, 'auth.json'), 0o600);
const modelRuntime = await createLocalModelRuntime(agentDir);
const model = modelRuntime.getAvailableSnapshot().find((entry) => entry.provider === 'openai-codex' && entry.id === modelId);
if (!model) throw new Error('The pinned worker model is not available in the isolated authenticated scope');
const classifier = mode === 'enabled' ? createJevClassifier() : undefined;
if (mode === 'enabled' && !classifier) throw new Error('Jev credentials are unavailable');
const scenario = memoryProcessingScenario();
const project = await resolveLocalMemoryProject(cwd);
const projectDirectory = localMemoryProjectDirectory(agentDir, project);
await hydrateMemoryDirectory(scenario.priorWiki, join(projectDirectory, 'current'), { memoryPath: '.memory', mode: 'read' });
let splitEvidence = null;
const dream = createDefaultLocalMemoryDreamRunner();
const coordinator = new LocalMemoryCoordinator({ agentDir, modelRuntime, selectedModel: model,
  scopedModels: [model], classifier, recover: false, monitorIntervalMs: 60_000,
  dreamRunner: async (input) => {
    const artifact = await dream(input);
    if (mode !== 'enabled') return artifact;
    const split = JSON.parse(await readFile(join(input.inputDirectory, 'decisions.json'), 'utf8'));
    if (split.version !== 4 || split.baseMemoryFingerprint !== input.manifest.baseMemoryFingerprint
      || split.sessions.length !== input.manifest.sessions.length) throw new Error('Invalid split evidence map');
    let inspect = 0;
    let noise = 0;
    let inspectJsonlBytes = 0;
    let inspectViewBytes = 0;
    for (const [index, session] of input.manifest.sessions.entries()) {
      const sources = split.sessions[index];
      if (sources.sessionId !== session.checkpoint.sessionId) throw new Error('Split session does not match manifest');
      const lines = async (path) => (await readFile(join(input.inputDirectory, path), 'utf8'))
        .trim().split('\n').filter(Boolean);
      const original = await lines(session.transcriptPath);
      const retained = await lines(sources.inspectPath);
      const deferred = await lines(sources.noisePath);
      const inspectJsonl = await readFile(join(input.inputDirectory, sources.inspectPath), 'utf8');
      if (!sources.inspectViewPath) throw new Error('Missing readable view for text-only eval fixture');
      const inspectView = await readFile(join(input.inputDirectory, sources.inspectViewPath), 'utf8');
      if (inspectView !== renderMemoryInspectView(inspectJsonl, sources.sessionId)
        || createHash('sha256').update(inspectView).digest('hex') !== sources.inspectViewDigest) {
        throw new Error('Readable inspect view differs from original evidence');
      }
      inspectJsonlBytes += Buffer.byteLength(inspectJsonl);
      inspectViewBytes += Buffer.byteLength(inspectView);
      const byId = new Map(original.map((line) => { const value = JSON.parse(line); return [value.id, line]; }));
      if (retained.length + deferred.length !== original.length
        || new Set([...retained, ...deferred].map((line) => JSON.parse(line).id)).size !== original.length
        || [...retained, ...deferred].some((line) => byId.get(JSON.parse(line).id) !== line)) {
        throw new Error('Split evidence lost or changed a source record');
      }
      inspect += retained.length;
      noise += deferred.length;
    }
    splitEvidence = { sessions: split.sessions.length, inspect, noise, inspectJsonlBytes, inspectViewBytes };
    return artifact;
  } });
const started = performance.now();
try {
  const host = coordinator.createSessionHost({ cwd, sessionStorageRoot: join(agentDir, 'eval-session-projections') });
  for (const session of scenario.sessions) {
    const entries = session.entries.map((entry, index) => ({
      type: 'message', id: entry.id, parentId: session.entries[index - 1]?.id ?? null,
      message: { role: entry.role, content: entry.content, ...(entry.toolName ? { toolName: entry.toolName } : {}) },
      timestamp: new Date(index * 1_000).toISOString(),
    }));
    const sessionFile = join(cwd, `${session.id}.jsonl`);
    await writeFile(sessionFile, [JSON.stringify({ type: 'session', id: session.id, version: 3, cwd }),
      ...entries.map((entry) => JSON.stringify(entry)), ''].join('\n'));
    await host.recordCheckpoint({ sessionId: session.id, sessionFile, leafId: entries.at(-1).id,
      transcriptDigest: digestActiveBranch(entries) });
  }
  const status = await coordinator.runNow(cwd);
  if (status.pendingCheckpoints !== 0 || status.state !== 'idle') {
    throw new Error(`Memory processing did not publish both checkpoints: ${JSON.stringify({
      state: status.state, pendingCheckpoints: status.pendingCheckpoints, message: status.message,
    })}`);
  }
  const snapshot = await readMemoryDirectory(await coordinator.canonicalDirectory(cwd), {
    memoryPath: '.memory', sourceSessionIds: ['prior', ...scenario.expected.sourceIds],
  });
  const runDir = join(projectDirectory, 'runs');
  const runIds = await readdir(runDir);
  if (runIds.length !== 1) throw new Error(`Expected exactly one memory worker run, got ${runIds.length}`);
  const run = JSON.parse(await readFile(join(runDir, runIds[0], 'manifest.json'), 'utf8'));
  const tracePath = join(agentDir, 'sessions', 'memory', run.sessionFile);
  const trace = (await readFile(tracePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  const readResults = trace.filter((entry) => entry.message?.role === 'toolResult' && entry.message?.toolName === 'read')
    .flatMap((entry) => entry.message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  const workerEvidence = workerReadEvidence(readResults, ['remember-old', 'provider-incident', 'forget-old', 'remember-new']);
  const output = join(workspace, '.eval-output');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'wiki.json'), `${JSON.stringify(snapshot.files)}\n`);
  await writeFile(join(output, 'result.json'), `${JSON.stringify({ mode, modelId, elapsedMs: performance.now() - started,
    runStatus: run.status, fingerprint: snapshot.fingerprint, worker: run.model, workerUsage: run.usage ?? null,
    triage: run.triage ?? null, splitEvidence, workerEvidence,
    scenarioDigest: createHash('sha256').update(JSON.stringify(scenario)).digest('hex'),
  }, null, 2)}\n`);
  console.log(JSON.stringify({ mode, status: run.status, outputFingerprint: snapshot.fingerprint }));
} finally {
  await coordinator.dispose();
  await rm(agentDir, { recursive: true, force: true });
}
