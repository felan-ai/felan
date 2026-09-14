import { copyFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

// Behaviour verifier, rtk/project-instructions template: check the workspace
// boundary, drop hidden specs into the repo's own test trees, build the tui
// dependency graph, then run the existing extension-config / settings tests
// alongside the hidden specs. The hidden specs exercise observable behaviour
// through the package's public seams (`defineExtensionConfig`,
// `resolveExtensionConfigs`, `resolveExtensionConfigSettings`, the `*_CONFIG`
// exports) plus the one contract the prompt names
// (`getPersistableExtensionConfig`); they never assert on internal structure.

const workspace = process.cwd();
const BASE_COMMIT = '51a18d8f0c853a06867ddbd48046ad4a84307058';
const rewardPath = `${workspace}/.harness-evals-reward.txt`;

// Hidden specs, copied in for the verifier run and removed afterwards.
const hidden = [
  {
    from: '/tests/extension-config-scope.test.ts',
    to: `${workspace}/packages/agent-core/test/harness-extension-config-scope.test.ts`,
  },
  {
    from: '/tests/scope-classification.test.ts',
    to: `${workspace}/apps/tui/test/harness-scope-classification.test.ts`,
  },
  {
    from: '/tests/settings-scope.test.ts',
    to: `${workspace}/apps/tui/test/harness-settings-scope.test.ts`,
  },
];

// A changed path is in-bounds only if it lives in a package/app source or test
// tree. Config, lockfiles, build wiring, docs, and history are out of bounds.
const allowedPath = /^(packages\/[^/]+\/(src|test)\/|apps\/tui\/(src|test)\/)/u;

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

  for (const spec of hidden) await copyFile(spec.from, spec.to);

  // agent-core is consumed through dist/, so the whole tui dependency graph
  // (agent-core + every config-bearing extension + the app) must build.
  run('pnpm', ['--filter', '@felan-ai/felan...', 'build'], 360_000);

  run('pnpm', [
    '--filter', '@felan-ai/agent-core', 'exec',
    'vitest', 'run',
    'test/extension-config.test.ts',
    'test/harness-extension-config-scope.test.ts',
  ]);

  run('pnpm', [
    '--filter', '@felan-ai/felan', 'exec',
    'vitest', 'run',
    'test/settings.test.ts',
    'test/harness-scope-classification.test.ts',
    'test/harness-settings-scope.test.ts',
  ]);

  passed = true;
} catch (error) {
  if (error instanceof InfrastructureFailure) infrastructureExitCode = error.exitCode;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  for (const spec of hidden) await rm(spec.to, { force: true });
  await writeFile(rewardPath, passed ? '1\n' : '0\n');
}

console.log(passed ? '1' : '0');
if (!passed) process.exitCode = infrastructureExitCode ?? 1;

function verifyWorkspaceBoundary() {
  if (capture('git', ['rev-parse', 'HEAD']).trim() !== BASE_COMMIT) {
    throw new Error('repository history changed');
  }
  if (capture('git', ['remote']).trim() !== '') {
    throw new Error('benchmark workspace unexpectedly has a Git remote');
  }

  const changedPaths = capture('git', [
    'status', '--porcelain=v1', '--untracked-files=all',
  ])
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => line.slice(3).split(' -> '))
    .filter((path) => path !== '.harness-evals-reward.txt');

  if (changedPaths.length === 0) throw new Error('no implementation changes found');
  const disallowed = changedPaths.filter((path) => !allowedPath.test(path));
  if (disallowed.length > 0) {
    throw new Error(`changes outside package/app src and test trees: ${disallowed.join(', ')}`);
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

function run(command, args, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd: workspace,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status === 137 || result.signal === 'SIGKILL') {
    throw new InfrastructureFailure(`${command} ${args.join(' ')} exited with 137`);
  }
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}
