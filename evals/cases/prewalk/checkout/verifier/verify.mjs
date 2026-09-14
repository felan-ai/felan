import { constants, existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const workspace = process.cwd();
const tempDir = join(workspace, '.harness-verifier-tmp');
const hiddenFlowTest = join(workspace, 'harness-checkout-flow.test.tsx');
const hiddenApiTest = join(workspace, 'harness-api-contract.test.ts');
const rewardPath = join(workspace, '.harness-evals-reward.txt');
const expectedHead = '9cb213463222732cb955067953220d665b2f561b';
const allowedSourcePrefixes = ['app/', 'components/', 'hooks/', 'lib/', 'styles/'];

class InfrastructureFailure extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 137;
  }
}

let passed = false;
let rewardPathPrepared = false;
let infrastructureExitCode;
try {
  const rewardPathSafe = await prepareRewardPath();
  rewardPathPrepared = true;
  if (!rewardPathSafe) throw new Error('unsafe verifier reward path');
  verifyWorkspaceBoundary();
  if (!existsSync(join(workspace, 'package.json'))) throw new Error('workspace package.json is missing');

  await mkdir(tempDir, { recursive: true });
  run('pnpm', ['typecheck']);
  run('pnpm', ['build'], {
    NEXT_PUBLIC_IMPROVED_CHECKOUT: 'false',
    NEXT_PUBLIC_ADD_TO_CART_BUG: 'false',
  });
  await rm(join(workspace, '.next'), { recursive: true, force: true });
  run('pnpm', ['build'], {
    NEXT_PUBLIC_IMPROVED_CHECKOUT: 'true',
    NEXT_PUBLIC_ADD_TO_CART_BUG: 'false',
  });
  await copyFile('/tests/checkout-flow.test.tsx', hiddenFlowTest);
  await copyFile('/tests/api-contract.test.ts', hiddenApiTest);
  run('pnpm', [
    'exec',
    'vitest',
    'run',
    hiddenFlowTest,
    hiddenApiTest,
    '--config',
    '/tests/vitest.config.ts',
    '--reporter',
    'dot',
  ]);
  passed = true;
} catch (error) {
  if (error instanceof InfrastructureFailure) infrastructureExitCode = error.exitCode;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await Promise.all([
    rm(tempDir, { recursive: true, force: true }),
    rm(hiddenFlowTest, { force: true }),
    rm(hiddenApiTest, { force: true }),
    rm(join(workspace, '.next'), { recursive: true, force: true }),
    rm(join(workspace, 'tsconfig.tsbuildinfo'), { force: true }),
  ]);
  if (rewardPathPrepared) await writeReward(passed ? '1\n' : '0\n');
}

console.log(passed ? '1' : '0');
if (!passed) process.exitCode = infrastructureExitCode ?? 1;

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

function verifyWorkspaceBoundary() {
  if (capture('git', ['rev-parse', 'HEAD']).trim() !== expectedHead) {
    throw new Error('repository history changed');
  }
  if (capture('git', ['remote']).trim() !== '') {
    throw new Error('benchmark workspace unexpectedly has a Git remote');
  }

  const changedPaths = capture('git', ['status', '--porcelain=v1', '--untracked-files=all'])
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => line.slice(3).split(' -> '))
    .filter((path) => path !== '.harness-evals-reward.txt');
  const disallowed = changedPaths.filter((path) => {
    return !allowedSourcePrefixes.some((prefix) => path.startsWith(prefix));
  });
  if (disallowed.length > 0) {
    throw new Error(`changes outside allowed application sources: ${disallowed.join(', ')}`);
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

function run(command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    env: { ...process.env, TMPDIR: tempDir, TMP: tempDir, TEMP: tempDir, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status === 137 || result.signal === 'SIGKILL') {
    throw new InfrastructureFailure(`${command} ${args.join(' ')} exited with 137`);
  }
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}
