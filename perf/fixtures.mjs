export const SEED = 0x5eed1234;
export const SESSION = 'perf-session';
export function generator(seed = SEED) {
  let state = seed >>> 0;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 0x100000000; };
}
export function catalog(tools = 60) {
  return {
    tools: Array.from({ length: tools }, (_, i) => ({ name: `tool_${i}`, label: `Tool ${i}`, description: `Tool ${i} reads synthetic data. `.repeat(20),
      parameters: { type: 'object', properties: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`param_${k}`, { type: 'string', description: `Parameter ${k} `.repeat(8) }])), required: ['param_0'] },
      provenance: 'builtin', source: 'builtin', active: true })),
    commands: Array.from({ length: 40 }, (_, i) => ({ name: `cmd_${i}`, description: `Command ${i}`, source: 'extension', kind: 'extension' })),
    models: Array.from({ length: 30 }, (_, i) => ({ provider: 'fake', id: `model-${i}`, label: `Model ${i}`, thinking: ['off', 'low', 'medium', 'high'] })),
  };
}
export function transcript(turns = 30, seed = SEED) {
  const random = generator(seed);
  const phrases = ['plain ASCII text ', '中文测试数据 ', 'emoji 🐈 🚀 ✨ ', 'combining e\u0301 and café ', 'line one\nline two\t'];
  const text = () => Array.from({ length: 20 }, () => phrases[Math.floor(random() * phrases.length)]).join('');
  const entries = [];
  const add = (role, content) => {
    const n = entries.length;
    entries.push({ id: `m-${n}`, entryId: `e-${n}`, ...(n ? { parentEntryId: `e-${n - 1}` } : {}), role, content, timestamp: 1700000000000 + n });
  };
  for (let i = 0; i < turns; i++) {
    add('user', [{ type: 'text', text: text() }]);
    add('assistant', [{ type: 'thinking', text: text() }, { type: 'tool_call', id: `call-${i}`, name: 'read', arguments: { path: `fixture-${i}.txt` } }]);
    add('tool', [{ type: 'tool_result', id: `call-${i}`, text: text(), isError: false }]);
    add('assistant', [{ type: 'text', text: text() }]);
  }
  return entries;
}
export function snapshot({ large = false, seed = SEED } = {}) {
  const entries = transcript(30, seed);
  const branch = entries.at(-1).entryId;
  const snap = { session: SESSION, root: SESSION, revision: 10, cwd: '/tmp/perf-project', title: 'Synthetic benchmark', state: 'open', residency: 'warm', branch,
    history: { revision: 10, branch, entries }, model: { provider: 'fake', id: 'fake-model' }, thinking: 'medium', queue: [], run: { state: 'running', id: 'perf-run' },
    catalog: catalog(), policy: { effective: 'host-default', generation: 0 }, interactions: [], children: [], processes: [],
    tools: Array.from({ length: 30 }, (_, i) => ({ id: `call-${i}`, name: 'read', message: `m-${i * 4 + 1}`, state: 'completed', output: 'synthetic output\n'.repeat(256), truncated: false })),
    presentation: [], activeStreams: [], completionOnlyStreams: [] };
  if (large) {
    const target = 5 * 1024 * 1024;
    const missing = target - Buffer.byteLength(JSON.stringify(snap));
    const contents = entries.filter(m => m.role === 'tool').map(m => m.content[0]);
    const perEntry = Math.floor(missing / contents.length);
    for (const content of contents) content.text += 'a'.repeat(perEntry);
    contents[0].text += 'a'.repeat(target - Buffer.byteLength(JSON.stringify(snap)));
  }
  return snap;
}
export const delta = (offset = 0, text = 'token!! ') => ({ v: 1, session: SESSION, stream: { message: 'm-live', id: 'm-live:0', kind: 'assistant', offset }, text });
