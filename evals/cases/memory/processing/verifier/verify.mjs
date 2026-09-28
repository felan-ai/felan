import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.env.MEMORY_EVAL_WORKSPACE ?? '/workspace';
const result = JSON.parse(await readFile(join(root, '.eval-output/result.json'), 'utf8'));
const files = JSON.parse(await readFile(join(root, '.eval-output/wiki.json'), 'utf8'));
const byPath = new Map(files.map(({ path, content }) => [path, content]));
const text = files.map(({ content }) => content).join('\n');
const release = byPath.get('pages/decisions/release.md') ?? '';
const incident = files.filter(({ path }) => path.startsWith('pages/') && !path.endsWith('/index.md'))
  .find(({ content }) => /provider[^\n]{0,180}success[^\n]{0,120}discarded/iu.test(content))?.content ?? '';
const checks = {
  published: result.runStatus === 'completed',
  newRule: release.includes('successful login') && release.includes('blocked-account login'),
  corrected: !text.includes('Only successful login needs checking.') && !text.includes('Release checks only need a successful login.'),
  incident: Boolean(incident) && incident.includes('session:memory-processing-first'),
  releaseSource: release.includes('session:memory-processing-second'),
  staleRemoved: !byPath.has('pages/decisions/pause.md'),
  noiseAbsent: !text.includes('Routine build progress'),
  mode: result.mode === 'disabled' ? result.triage === null && result.splitEvidence === null
    : result.triage?.counts?.inspect > 0 && result.triage?.counts?.noise > 0
      && result.triage.counts.inspect + result.triage.counts.noise === 184
      && result.triage.counts.uncertain <= result.triage.counts.inspect
      && result.splitEvidence?.sessions === 2
      && result.splitEvidence.inspect >= result.triage.counts.inspect
      && result.splitEvidence.noise === result.triage.counts.noise
      && result.triage.requests > 1,
};
const reward = Object.values(checks).every(Boolean) ? 1 : 0;
await writeFile(join(root, '.harness-evals-reward.json'), `${JSON.stringify({ reward })}\n`);
console.log(JSON.stringify({ mode: result.mode, checks, workerUsage: result.workerUsage, triage: result.triage,
  elapsedMs: result.elapsedMs }));
if (!reward) process.exitCode = 1;
