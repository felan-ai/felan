// Summarizes a .cpuprofile: self time and inclusive time per function, focused on the window where streaming happened.
import { readFileSync } from 'node:fs';
const profile = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const windowMs = Number(process.argv[3] ?? Infinity);
const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const self = new Map(); const total = new Map();
let time = profile.startTime; let sampled = 0; let idle = 0;
const name = node => { const f = node.callFrame; const file = f.url.replace(/^.*\/(node_modules\/\.pnpm\/[^/]+\/node_modules\/|felan\/apps\/|felan\/packages\/)/, '').replace(/^file:\/\//, ''); return `${f.functionName || '(anon)'} ${file}:${f.lineNumber + 1}`; };
for (let i = 0; i < profile.samples.length; i++) {
  const delta = profile.timeDeltas[i] / 1000; time += profile.timeDeltas[i];
  if ((time - profile.startTime) / 1000 > windowMs) break;
  const node = nodes.get(profile.samples[i]);
  const n = name(node);
  if (node.callFrame.functionName === '(idle)') { idle += delta; continue; }
  sampled += delta;
  self.set(n, (self.get(n) ?? 0) + delta);
  const seen = new Set();
  for (let id = node.id; id !== undefined; id = parent.get(id)) {
    const key = name(nodes.get(id)); if (seen.has(key)) continue; seen.add(key);
    total.set(key, (total.get(key) ?? 0) + delta);
  }
}
console.log(`busy ${sampled.toFixed(0)} ms, idle ${idle.toFixed(0)} ms`);
const top = (map, n, filter = () => true) => [...map].filter(([k]) => filter(k)).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(7)} ms  ${k}`).join('\n');
console.log('\nTop self time:\n' + top(self, 30));
console.log('\nTop inclusive (Felan + pi-tui):\n' + top(total, 45, k => /felan\/dist|daemon\/dist|session-protocol|agent-core|pi-coding-agent|pi-agent-core|pi-ai|pi-tui/.test(k)));
