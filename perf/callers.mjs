import { readFileSync } from 'node:fs';
const [file, target] = process.argv.slice(2);
const profile = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map(n => [n.id, n])); const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const name = n => `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber + 1}`;
const stacks = new Map();
profile.samples.forEach((id, i) => {
  const n = nodes.get(id); if (!name(n).startsWith(target)) return;
  const chain = []; for (let p = parent.get(id); p !== undefined && chain.length < 7; p = parent.get(p)) chain.push(name(nodes.get(p)));
  const key = chain.join(' <- '); stacks.set(key, (stacks.get(key) ?? 0) + profile.timeDeltas[i] / 1000);
});
for (const [k, v] of [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(v.toFixed(0).padStart(6), 'ms', k.slice(0, 600));
