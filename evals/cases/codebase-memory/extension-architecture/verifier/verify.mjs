import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Loose directional verifier for a generic "explain the extension system"
// prompt. There is no single correct explanation, so this is not a rubric - it
// only checks the report engaged with the core of the system. Report quality is
// validated by hand.
//
// reward = matched facts / total facts, or 0 below config.failBelow.
// Hard gates: report exists, only EXTENSION-ARCHITECTURE.md changed, HEAD is the
// pinned commit, word count >= config.minWords.

const workspace = process.cwd();
const rewardPath = `${workspace}/.harness-evals-reward.txt`;
const reportPath = `${workspace}/EXTENSION-ARCHITECTURE.md`;
const factsPath = '/tests/facts.json';
const pinnedCommit = 'e5867637569bd1c7ad08420b79ec4031a5733f57';

let reward = 0;
let reason = '';

try {
  verifyWorkspaceBoundary();

  const spec = JSON.parse(await readFile(factsPath, 'utf8'));
  const cfg = spec.config ?? {};
  const facts = spec.facts ?? [];

  const text = (await readFile(reportPath, 'utf8')).replace(/\r\n/gu, '\n');
  const wordCount = text.trim().split(/\s+/u).filter(Boolean).length;
  if (wordCount < (cfg.minWords ?? 150)) {
    throw new Error(`report too short: ${wordCount} words (minimum ${cfg.minWords ?? 150})`);
  }

  const windowChars = cfg.windowChars ?? 1200;
  const windowStep = cfg.windowStep ?? 300;
  const results = facts.map((fact) => ({
    id: fact.id,
    pass: factSatisfied(text, fact, windowChars, windowStep),
  }));

  const matched = results.filter((r) => r.pass).length;
  const coverage = facts.length ? matched / facts.length : 0;
  reward = coverage < (cfg.failBelow ?? 0) ? 0 : Math.round(coverage * 1000) / 1000;

  const missed = results.filter((r) => !r.pass).map((r) => r.id);
  reason = `coverage=${matched}/${facts.length}${missed.length ? ` missed:[${missed.join(', ')}]` : ''}`;
} catch (error) {
  reason = error instanceof Error ? error.message : String(error);
  reward = 0;
} finally {
  await writeFile(rewardPath, `${reward}\n`);
}

console.log(`${reward} (${reason})`);
if (reward <= 0) process.exitCode = 1;

// A fact passes if some sliding window matches every `all` pattern and no `none`
// pattern.
function factSatisfied(text, fact, windowChars, windowStep) {
  const all = (fact.all ?? []).map((p) => new RegExp(p, 'iu'));
  const none = (fact.none ?? []).map((p) => new RegExp(p, 'iu'));
  if (all.length === 0) return false;
  for (let start = 0; start < text.length; start += windowStep) {
    const windowText = text.slice(start, start + windowChars);
    if (all.every((re) => re.test(windowText)) && !none.some((re) => re.test(windowText))) {
      return true;
    }
    if (start + windowChars >= text.length) break;
  }
  return false;
}

function verifyWorkspaceBoundary() {
  const head = capture('git', ['rev-parse', 'HEAD']).trim();
  if (head !== pinnedCommit) {
    throw new Error('repository history changed');
  }
  if (capture('git', ['remote']).trim() !== '') {
    throw new Error('benchmark workspace unexpectedly has a Git remote');
  }

  const changedPaths = capture('git', [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ])
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => line.slice(3).split(' -> '))
    .filter((path) => path !== '.harness-evals-reward.txt');

  const disallowed = changedPaths.filter((changedPath) => changedPath !== 'EXTENSION-ARCHITECTURE.md');
  if (disallowed.length > 0) {
    throw new Error(`changes outside EXTENSION-ARCHITECTURE.md: ${disallowed.join(', ')}`);
  }
  if (!changedPaths.includes('EXTENSION-ARCHITECTURE.md')) {
    throw new Error('EXTENSION-ARCHITECTURE.md was not created');
  }
}

function capture(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}
