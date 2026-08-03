import { describe, expect, it } from 'vitest';
import {
  runRuntimeConformance,
  testRuntimeConformanceFixtures,
  TestAgentRuntime,
  type TestAgentRuntimeOptions,
} from '../src/runtime-test-kit.js';

const fixtureHandlers: TestAgentRuntimeOptions = {
  exec: (call) => {
    switch (call.command) {
      case 'fixture:argv':
        return { stdout: JSON.stringify(call.args), stderr: '', code: 0, killed: false };
      case 'fixture:failure':
        return { stdout: '', stderr: 'expected failure', code: 17, killed: false };
      case 'fixture:cwd':
        return { stdout: call.options?.cwd ?? '/workspace', stderr: '', code: 0, killed: false };
      case 'fixture:wait':
        return new Promise(() => {});
      default:
        return { stdout: '', stderr: '', code: 0, killed: false };
    }
  },
};

describe('TestAgentRuntime', () => {
  it('passes the shared runtime conformance suite', async () => {
    await runRuntimeConformance(
      {
        createRuntime: () => new TestAgentRuntime('/workspace', fixtureHandlers),
        createSymlinkEscape: (runtime, linkPath) => {
          expect(runtime).toBeInstanceOf(TestAgentRuntime);
          (runtime as TestAgentRuntime).addSymlink(linkPath, '/outside');
        },
      },
      testRuntimeConformanceFixtures,
    );
  });

  it('implements recursive listing and removal', async () => {
    const runtime = new TestAgentRuntime();
    await runtime.mkdir('one/two', { recursive: true });
    await runtime.writeFile('one/top.bin', new Uint8Array([1]));
    await runtime.writeFile('one/two/deep.bin', new Uint8Array([2]));

    await expect(runtime.listFiles('one')).resolves.toEqual(['top.bin']);
    await expect(runtime.listFiles('one', { recursive: true })).resolves.toEqual([
      'top.bin',
      'two/deep.bin',
    ]);
    await expect(runtime.remove('one')).rejects.toThrow('not empty');
    await runtime.remove('one', { recursive: true });
    await expect(runtime.readFile('one/top.bin')).rejects.toThrow('does not exist');
  });

  it('copies binary inputs and outputs', async () => {
    const runtime = new TestAgentRuntime();
    const input = new Uint8Array([0, 255]);
    await runtime.writeFile('payload.bin', input);
    input[0] = 9;
    const output = await runtime.readFile('payload.bin');
    output[1] = 9;

    await expect(runtime.readFile('payload.bin')).resolves.toEqual(new Uint8Array([0, 255]));
  });

  it('passes shell cwd and environment without mutation', async () => {
    const runtime = new TestAgentRuntime('/workspace', {
      shell: (call) => ({
        stdout: JSON.stringify(call.options),
        stderr: '',
        code: 0,
        killed: false,
      }),
    });
    await runtime.mkdir('child');
    const result = await runtime.shell('printf ok', {
      cwd: 'child',
      env: { LITERAL: '$HOME; echo no' },
    });

    expect(JSON.parse(result.stdout)).toEqual({
      cwd: '/workspace/child',
      env: { LITERAL: '$HOME; echo no' },
    });
  });
});
