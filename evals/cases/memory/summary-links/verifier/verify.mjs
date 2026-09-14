import { constants } from 'node:fs';
import { copyFile, lstat, open, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const workspace = '/workspace';
const rewardPath = `${workspace}/.harness-evals-reward.txt`;
const hiddenMemoryTest = `${workspace}/packages/ext-memory/test/harness-summary-links.test.ts`;
const hiddenStoreTest = `${workspace}/apps/tui/test/harness-memory-store.test.ts`;
const allowedPrefixes = ['packages/ext-memory/src/', 'apps/tui/src/memory/'];
const failures = [];
let rewardPathPrepared = false;
let infrastructureExitCode;

try {
  const rewardPathSafe = await prepareRewardPath();
  rewardPathPrepared = true;
  if (!rewardPathSafe) failures.push('workspace boundary: unsafe verifier reward path');
  check('workspace boundary', verifyWorkspaceBoundary);
  await prepareHiddenTest('ext-memory hidden test', '/tests/summary-links.test.ts', hiddenMemoryTest);
  await prepareHiddenTest('TUI hidden test', '/tests/memory-store.test.ts', hiddenStoreTest);

  checkCommand('workspace build', 'pnpm', ['--filter', '@felan-ai/felan...', 'build']);
  checkCommand('ext-memory typecheck', 'pnpm', ['--filter', '@felan-ai/ext-memory', 'type-check']);
  checkCommand('ext-memory tests', 'pnpm', [
    '--filter',
    '@felan-ai/ext-memory',
    'exec',
    'vitest',
    'run',
    'test/package.test.ts',
    'test/manifest.test.ts',
    'test/harness-summary-links.test.ts',
  ]);
  checkCommand('TUI typecheck', 'pnpm', ['--filter', '@felan-ai/felan', 'type-check']);
  checkCommand('TUI tests', 'pnpm', [
    '--filter',
    '@felan-ai/felan',
    'exec',
    'vitest',
    'run',
    'test/memory-store.test.ts',
    'test/harness-memory-store.test.ts',
  ]);
} finally {
  await Promise.all([
    rm(hiddenMemoryTest, { force: true }),
    rm(hiddenStoreTest, { force: true }),
  ]);
  if (rewardPathPrepared) await writeReward(failures.length === 0 ? '1\n' : '0\n');
}

if (failures.length > 0) {
  console.error(`Verifier failed ${failures.length} check(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
}
console.log(failures.length === 0 ? '1' : '0');
if (failures.length > 0) process.exitCode = infrastructureExitCode ?? 1;

async function prepareHiddenTest(label, source, target) {
  try {
    let targetExisted = false;
    try {
      await lstat(target);
      targetExisted = true;
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    if (targetExisted) failures.push(`${label}: pre-existing verifier test target`);
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    recordFailure(label, error);
  }
}

async function prepareRewardPath() {
  let safe = true;
  try {
    const status = await lstat(rewardPath);
    safe = status.isFile() && !status.isSymbolicLink() && status.nlink === 1;
    await rm(rewardPath, { recursive: true, force: true });
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return safe;
}

async function writeReward(value) {
  const handle = await open(
    rewardPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(value);
  } finally {
    await handle.close();
  }
}

function isMissingPath(error) {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}

function check(label, operation) {
  try {
    operation();
  } catch (error) {
    recordFailure(label, error);
  }
}

function checkCommand(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 240_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    recordFailure(label, result.error);
  } else if (result.status !== 0) {
    const exitCode = result.status === 137 || result.signal === 'SIGKILL' ? 137 : result.status;
    if (exitCode === 137) infrastructureExitCode = 137;
    failures.push(`${label}: ${command} ${args.join(' ')} exited with ${exitCode}`);
  }
}

function recordFailure(label, error) {
  failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
}

function verifyWorkspaceBoundary() {
  const head = captureText('git', ['rev-parse', 'HEAD']).trim();
  if (head !== '0b461533f86c4d58521cdd7da7d9f298da03b123') {
    throw new Error('repository history changed');
  }
  if (captureText('git', ['remote']).trim() !== '') {
    throw new Error('benchmark workspace unexpectedly has a Git remote');
  }
  const changedPaths = [
    ...capturePaths('git', ['diff', '--name-only', '--no-renames', '-z', 'HEAD', '--']),
    ...capturePaths('git', ['ls-files', '--others', '--exclude-standard', '-z', '--']),
  ].filter((path) => path !== '.harness-evals-reward.txt');
  const disallowed = [...new Set(changedPaths)]
    .filter((path) => !allowedPrefixes.some((prefix) => path.startsWith(prefix)));
  if (disallowed.length > 0) throw new Error(`changes outside allowed memory sources: ${disallowed.join(', ')}`);
}

function captureText(command, args) {
  const result = capture(command, args, 'utf8');
  return result.stdout;
}

function capturePaths(command, args) {
  const result = capture(command, args, 'buffer');
  return result.stdout.toString('utf8').split('\0').filter(Boolean);
}

function capture(command, args, encoding) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() || result.stdout?.toString();
    throw new Error(`${command} ${args.join(' ')} failed:\n${stderr}`);
  }
  return result;
}
