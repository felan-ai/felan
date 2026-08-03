import { dirname, resolve } from 'node:path';
import type { AgentRuntime, ExecResult } from './runtime.js';

export interface RuntimeCommandFixture {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}

export interface RuntimeConformanceFixtures {
  readonly argv: RuntimeCommandFixture;
  readonly failure: RuntimeCommandFixture;
  readonly longRunning: RuntimeCommandFixture;
  readonly cwd: RuntimeCommandFixture;
  readonly binary: Uint8Array;
}

export interface RuntimeConformanceHarness {
  createRuntime(): AgentRuntime | Promise<AgentRuntime>;
  disposeRuntime?(runtime: AgentRuntime): void | Promise<void>;
  createSymlinkEscape?(runtime: AgentRuntime, linkPath: string): void | Promise<void>;
}

export interface RuntimeConformanceCase {
  readonly name: string;
  run(runtime: AgentRuntime, harness: RuntimeConformanceHarness): Promise<void>;
}

const literalArguments = ['plain', 'two words', '"quoted"', "'single'", '$HOME', 'semi;colon', '', '--flag=value'];

export const testRuntimeConformanceFixtures: RuntimeConformanceFixtures = {
  argv: {
    command: 'fixture:argv',
    args: literalArguments,
    stdout: JSON.stringify(literalArguments),
  },
  failure: {
    command: 'fixture:failure',
    args: [],
    stderr: 'expected failure',
    code: 17,
  },
  longRunning: {
    command: 'fixture:wait',
    args: [],
  },
  cwd: {
    command: 'fixture:cwd',
    args: [],
  },
  binary: new Uint8Array([0, 255, 1, 128, 10, 13, 239, 191, 189]),
};

export function createNodeRuntimeConformanceFixtures(command = 'node'): RuntimeConformanceFixtures {
  return {
    argv: {
      command,
      args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--', ...literalArguments],
      stdout: JSON.stringify(literalArguments),
    },
    failure: {
      command,
      args: ['-e', "process.stderr.write('expected failure'); process.exit(17)"],
      stderr: 'expected failure',
      code: 17,
    },
    longRunning: {
      command,
      args: ['-e', 'setInterval(() => {}, 1000)'],
    },
    cwd: {
      command,
      args: ['-e', 'process.stdout.write(process.cwd())'],
    },
    binary: testRuntimeConformanceFixtures.binary.slice(),
  };
}

export function createRuntimeConformanceCases(
  fixtures: RuntimeConformanceFixtures,
): readonly RuntimeConformanceCase[] {
  return [
    {
      name: 'keeps cwd immutable and contains file paths',
      async run(runtime) {
        const originalCwd = runtime.cwd;
        Reflect.set(runtime, 'cwd', resolve(runtime.cwd, 'other'));
        equal(runtime.cwd, originalCwd, 'cwd changed');

        await runtime.mkdir('nested', { recursive: true });
        await runtime.writeFile('nested/relative.bin', fixtures.binary);
        bytesEqual(await runtime.readFile(resolve(runtime.cwd, 'nested/relative.bin')), fixtures.binary);

        await rejects(() => runtime.readFile('../outside'));
        await rejects(() => runtime.writeFile(`${runtime.cwd}\0bad`, fixtures.binary));
        await rejects(() => runtime.remove(runtime.cwd, { recursive: true }));
      },
    },
    {
      name: 'rejects escaping exec cwd before execution',
      async run(runtime) {
        await rejects(() => runtime.exec(fixtures.cwd.command, fixtures.cwd.args, {
          cwd: resolve(runtime.cwd, '..'),
        }));

        const childCwd = resolve(runtime.cwd, 'child');
        await runtime.mkdir(childCwd, { recursive: true });
        const result = await runtime.exec(fixtures.cwd.command, fixtures.cwd.args, { cwd: childCwd });
        equal(result.stdout, childCwd, 'exec cwd was not contained or normalized');
      },
    },
    {
      name: 'rejects symlink-resolved escapes when supported',
      async run(runtime, harness) {
        if (!harness.createSymlinkEscape) return;
        const linkPath = resolve(runtime.cwd, 'escape-link');
        await harness.createSymlinkEscape(runtime, linkPath);
        await rejects(() => runtime.readFile(resolve(linkPath, 'secret')));
      },
    },
    {
      name: 'preserves literal argv boundaries',
      async run(runtime) {
        const result = await runtime.exec(fixtures.argv.command, fixtures.argv.args);
        equal(result.stdout, fixtures.argv.stdout ?? '', 'argv output changed');
        equal(result.code, 0, 'argv command failed');
        equal(result.killed, false, 'argv command was killed');
      },
    },
    {
      name: 'returns nonzero execution results',
      async run(runtime) {
        const result = await runtime.exec(fixtures.failure.command, fixtures.failure.args);
        equal(result.code, fixtures.failure.code ?? 1, 'nonzero code changed');
        equal(result.stderr, fixtures.failure.stderr ?? '', 'stderr changed');
        equal(result.killed, false, 'failure command was killed');
      },
    },
    {
      name: 'round-trips binary file content',
      async run(runtime) {
        await runtime.mkdir(dirname('binary/payload.bin'), { recursive: true });
        await runtime.writeFile('binary/payload.bin', fixtures.binary);
        bytesEqual(await runtime.readFile('binary/payload.bin'), fixtures.binary);
      },
    },
    {
      name: 'kills execution on timeout',
      async run(runtime) {
        const result = await runtime.exec(fixtures.longRunning.command, fixtures.longRunning.args, { timeout: 10 });
        killed(result, 'timeout');
      },
    },
    {
      name: 'kills execution on AbortSignal cancellation',
      async run(runtime) {
        const controller = new AbortController();
        const execution = runtime.exec(fixtures.longRunning.command, fixtures.longRunning.args, {
          signal: controller.signal,
        });
        controller.abort();
        killed(await execution, 'AbortSignal');
      },
    },
  ];
}

export async function runRuntimeConformance(
  harness: RuntimeConformanceHarness,
  fixtures: RuntimeConformanceFixtures,
): Promise<void> {
  for (const testCase of createRuntimeConformanceCases(fixtures)) {
    const runtime = await harness.createRuntime();
    try {
      await testCase.run(runtime, harness);
    } catch (error) {
      throw new Error(`Runtime conformance failed: ${testCase.name}`, { cause: error });
    } finally {
      await harness.disposeRuntime?.(runtime);
    }
  }
}

function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function bytesEqual(actual: Uint8Array, expected: Uint8Array): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error('Binary content changed');
  }
}

async function rejects(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  throw new Error('Expected operation to reject');
}

function killed(result: ExecResult, source: string): void {
  equal(result.killed, true, `${source} did not kill execution`);
  if (result.code === 0) {
    throw new Error(`${source} returned a successful exit code`);
  }
}
