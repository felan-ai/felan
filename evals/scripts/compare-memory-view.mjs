import { digestActiveBranch, materializeMemoryInputDelta, renderMemoryInspectView } from '../../packages/ext-memory/dist/index.js';
import { memoryProcessingScenario } from '../fixtures/memory-processing/v1/source/.eval-setup/scenario.mjs';

const scenario = memoryProcessingScenario();
let inspectEntries = 0;
let jsonlBytes = 0;
let viewBytes = 0;
for (const session of scenario.sessions) {
  const entries = session.entries.map((entry, index) => ({
    type: 'message', id: entry.id, parentId: session.entries[index - 1]?.id ?? null,
    message: { role: entry.role, content: entry.content, ...(entry.toolName ? { toolName: entry.toolName } : {}) },
    timestamp: new Date(index * 1_000).toISOString(),
  }));
  const header = { type: 'session', id: session.id, version: 3, cwd: '/workspace/project' };
  const sourceLines = [header, ...entries].map((entry) => JSON.stringify(entry));
  const checkpoint = { sessionId: session.id, sessionFile: '/synthetic/source.jsonl',
    leafId: entries.at(-1).id, transcriptDigest: digestActiveBranch(entries) };
  const result = await materializeMemoryInputDelta({
    lines: async function* () { yield* sourceLines; }, checkpoint,
  });
  if (!result.ok) throw new Error(`Could not materialize synthetic session: ${result.code}`);
  const inspect = result.text.split('\n').filter(Boolean).filter((line) => JSON.parse(line).message?.role === 'user');
  inspectEntries += inspect.length;
  const jsonl = inspect.length ? `${inspect.join('\n')}\n` : '';
  const view = renderMemoryInspectView(jsonl, session.id);
  if (view === undefined) throw new Error('Synthetic inspect evidence is not representable as text');
  jsonlBytes += Buffer.byteLength(jsonl);
  viewBytes += Buffer.byteLength(view);
}
if (inspectEntries !== 4) throw new Error(`Expected four user entries, received ${inspectEntries}`);
console.log(JSON.stringify({ fixture: 'memory-processing/v1', inspectEntries, jsonlUtf8Bytes: jsonlBytes,
  viewUtf8Bytes: viewBytes, byteDifference: viewBytes - jsonlBytes,
  note: 'UTF-8 byte counts only; not provider tokens, model cost, or quality evidence.' }, null, 2));
