import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'felan-memory-eval-verifier-'));
const output = join(root, '.eval-output');
await mkdir(output);
try {
  const result = { mode: 'enabled', runStatus: 'completed',
    triage: { counts: { inspect: 4, noise: 180, uncertain: 0 }, requests: 2 },
    splitEvidence: { sessions: 2, inspect: 4, noise: 180 } };
  const files = [
    { path: 'pages/decisions/release.md', content: '# Release\n\nCheck successful login and blocked-account login.\n\n## Sources\n- session:memory-processing-second' },
    { path: 'pages/workflows/incident.md', content: '# Incident\n\nThe provider reported success for a request it discarded.\n\n## Sources\n- session:memory-processing-first' },
  ];
  await writeFile(join(output, 'result.json'), JSON.stringify(result));
  await writeFile(join(output, 'wiki.json'), JSON.stringify(files));
  const verifier = new URL('./verify.mjs', import.meta.url).pathname;
  const run = () => spawnSync(process.execPath, [verifier], { env: { ...process.env, MEMORY_EVAL_WORKSPACE: root }, encoding: 'utf8' });
  if (run().status !== 0) throw new Error('Valid source-grounded wiki did not pass');
  files[0].content = 'Only successful login needs checking.\n\n## Sources\n- session:memory-processing-first';
  await writeFile(join(output, 'wiki.json'), JSON.stringify(files));
  if (run().status === 0) throw new Error('Missed later correction passed grading');
  files[0].content = '# Release\n\nCheck successful login and blocked-account login.\n\n## Sources\n- session:memory-processing-second';
  files[1].content = '# Incident\n\nThe provider reported success for a request it discarded.\n\n## Sources\n- session:memory-processing-second';
  await writeFile(join(output, 'wiki.json'), JSON.stringify(files));
  if (run().status === 0) throw new Error('False incident provenance passed grading');
  console.log('memory processing verifier quality gates passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
