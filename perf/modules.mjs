import { readFileSync } from 'node:fs';
const [file, windowMs] = [process.argv[2], Number(process.argv[3] ?? Infinity)];
const profile = JSON.parse(readFileSync(file, 'utf8'));
const nodes = new Map(profile.nodes.map(n => [n.id, n])); const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
let t = profile.startTime; const buckets = new Map(); let total = 0;
profile.samples.forEach((id, i) => {
  t += profile.timeDeltas[i]; if ((t - profile.startTime) / 1000 > windowMs) return;
  const n = nodes.get(id); if (n.callFrame.functionName === '(idle)') return;
  let cat = 'other';
  for (let p = id; p !== undefined; p = parent.get(p)) {
    const f = nodes.get(p).callFrame;
    if (/esm\/(load|loader|translators|module_job)|modules\/cjs\/loader|compileSourceTextModule/.test(f.url + f.functionName)) { cat = 'module loading/compile'; break; }
    if (/pi-tui\/dist\/(tui|layout|tui-alt-screen)/.test(f.url)) { cat = 'TUI render'; break; }
    if (/felan\/dist\/client\//.test(f.url)) { cat = 'client protocol (parse/reduce)'; break; }
  }
  const d = profile.timeDeltas[i] / 1000; total += d; buckets.set(cat, (buckets.get(cat) ?? 0) + d);
});
for (const [k, v] of [...buckets].sort((a, b) => b[1] - a[1])) console.log(`${v.toFixed(0).padStart(6)} ms  ${k}`);
console.log(`${total.toFixed(0).padStart(6)} ms  total busy in first ${windowMs} ms`);
