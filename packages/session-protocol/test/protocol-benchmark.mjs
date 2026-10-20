import { pathToFileURL } from 'node:url';

const protocol = await import(process.env.PROTOCOL_MODULE ?? '../dist/index.js');
const text = 'A representative transcript line: const result = await operation("value");\n'.repeat(710);
export const snapshot = {
  session: 'session', root: 'session', revision: 10, cwd: '/project', title: 'Benchmark', state: 'open', residency: 'warm', branch: 'branch',
  history: { revision: 10, branch: 'branch', entries: Array.from({ length: 98 }, (_, index) => ({
    id: `m${index}`, entryId: `e${index}`, role: 'assistant', timestamp: 1000,
    content: index % 3 === 0
      ? [{ type: 'tool_call', id: `c${index}`, name: 'write', arguments: { path: '/project/file.ts', content: text } }]
      : [{ type: 'text', text }],
  })) },
  model: { provider: 'provider', id: 'model' }, thinking: 'medium', queue: [], run: { state: 'running', id: 'run' },
  catalog: { tools: Array.from({ length: 60 }, (_, index) => ({ name: `tool${index}`, label: 'Tool', description: 'Tool description',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path' } } }, provenance: 'builtin', source: 'core', active: true })), commands: [], models: [] },
  policy: { effective: 'host-default', generation: 0 }, interactions: [], children: [], processes: [], tools: [], presentation: [],
  activeStreams: [], completionOnlyStreams: [],
};
export const envelope = { v: 1, re: 'request', outcome: 'accepted', result: { attachmentId: 'attachment', snapshot } };

function measure(action, milliseconds = 1000) {
  for (let index = 0; index < 5; index++) action();
  const batches = [];
  for (let batch = 0; batch < 5; batch++) {
    const start = performance.now();
    let count = 0;
    let elapsed = 0;
    do { action(); count++; elapsed = performance.now() - start; } while (elapsed < milliseconds / 5);
    batches.push(elapsed / count);
  }
  return batches.sort((a, b) => a - b)[2];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const json = JSON.stringify(envelope);
  const frame = new TextEncoder().encode(`${json}\n`);
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const decoder = new protocol.JsonLineDecoder();
  const times = {
    stringify: measure(() => JSON.stringify(envelope)),
    encodeFrame: measure(() => protocol.encodeFrame(envelope)),
    parseString: measure(() => JSON.parse(json)),
    parse: measure(() => JSON.parse(utf8.decode(frame))),
    decoder: measure(() => decoder.push(frame)),
    snapshot: measure(() => protocol.parseSessionSnapshot(snapshot)),
    attach: measure(() => protocol.parseServerEnvelope(envelope, 'attach')),
  };
  console.log(JSON.stringify({ node: process.version, bytes: frame.length, messages: snapshot.history.entries.length, milliseconds: times,
    encodeRatio: times.encodeFrame / times.stringify, decodeRatio: times.decoder / times.parse,
    parseStringRatio: times.decoder / times.parseString }, null, 2));
}
