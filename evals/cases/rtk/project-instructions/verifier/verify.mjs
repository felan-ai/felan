import { copyFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const workspace = '/workspace';
const rewardPath = `${workspace}/.harness-evals-reward.txt`;
const hiddenTest = `${workspace}/packages/agent-core/test/harness-project-instructions.test.ts`;
const allowedSourcePrefix = 'packages/agent-core/src/';

class InfrastructureFailure extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 137;
  }
}

let passed = false;
let infrastructureExitCode;
try {
  verifyWorkspaceBoundary();
  await copyFile('/tests/project-instructions.test.ts', hiddenTest);
  run('pnpm', ['--filter', '@felan-ai/agent-core', 'type-check']);
  run('pnpm', [
    '--filter',
    '@felan-ai/agent-core',
    'exec',
    'vitest',
    'run',
    'test/session.test.ts',
    'test/resource-loader.test.ts',
    'test/harness-project-instructions.test.ts',
  ]);
  run('pnpm', ['--filter', '@felan-ai/agent-core', 'build']);
  passed = true;
} catch (error) {
  if (error instanceof InfrastructureFailure) infrastructureExitCode = error.exitCode;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  await rm(hiddenTest, { force: true });
  await writeFile(rewardPath, passed ? '1\n' : '0\n');
}

console.log(passed ? '1' : '0');
if (!passed) process.exitCode = infrastructureExitCode ?? 1;

function verifyWorkspaceBoundary() {
  const head = capture('git', ['rev-parse', 'HEAD']).trim();
  if (head !== '104faa5559029c8be9e8a1eb504d87974a5864e9') {
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
    .flatMap((line) => line.slice(3).split(' -> '));

  const relevantPaths = changedPaths.filter((path) => path !== '.harness-evals-reward.txt');

  if (relevantPaths.length === 0) throw new Error('no implementation changes found');
  const disallowed = relevantPaths.filter((path) => !path.startsWith(allowedSourcePrefix));
  if (disallowed.length > 0) {
    throw new Error(`changes outside ${allowedSourcePrefix}: ${disallowed.join(', ')}`);
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

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: workspace,
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
