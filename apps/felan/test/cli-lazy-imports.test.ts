import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  configImports: 0,
  updateImports: 0,
  configOptions: vi.fn(async () => [{ name: 'test-fast', extensionId: 'codex', field: 'fast',
    configField: { type: 'boolean', description: 'Fast execution' } }]),
  parseValue: vi.fn((_option: unknown, value: string | boolean) => value),
  update: vi.fn(async () => 7),
}));

vi.mock('../src/cli-config.js', () => {
  state.configImports += 1;
  return { cliConfigOptions: state.configOptions, parseCliConfigValue: state.parseValue };
});
vi.mock('../src/update.js', () => {
  state.updateImports += 1;
  return { runFelanUpdate: state.update };
});

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  state.configImports = 0; state.updateImports = 0;
});

it('launches ordinary arguments without importing extension definitions or the updater', async () => {
  const { runCli } = await import('../src/cli-main.js');
  const launch = vi.fn(async () => {});
  expect(await runCli(['--session', 'existing', '--verbose', '--', '--test-fast'], { launch })).toBe(0);
  expect(launch).toHaveBeenCalledWith({ continueRecent: false, verbose: true, sessionId: 'existing',
    restartArgs: ['--verbose'], initialMessage: '--test-fast' });
  expect(state.configImports).toBe(0); expect(state.updateImports).toBe(0);
});

it('prints the version and rejects invalid built-in values without loading extension definitions', async () => {
  const { runCli } = await import('../src/cli-main.js');
  const writeOutput = vi.fn(); const writeError = vi.fn();
  expect(await runCli(['--version'], { writeOutput })).toBe(0);
  expect(writeOutput).toHaveBeenCalledOnce();
  expect(await runCli(['--mode', 'invalid'], { writeError })).toBe(1);
  expect(writeError).toHaveBeenCalledWith('--mode requires text or json');
  expect(state.configImports).toBe(0); expect(state.updateImports).toBe(0);
});

it('loads definitions once for extension flags and retains their restart arguments', async () => {
  const { runCli } = await import('../src/cli-main.js');
  const launch = vi.fn(async () => {});
  expect(await runCli(['--test-fast', '--no-test-fast'], { launch })).toBe(0);
  expect(state.configImports).toBe(1); expect(state.configOptions).toHaveBeenCalledOnce();
  expect(state.parseValue).toHaveBeenCalledOnce();
  expect(launch).toHaveBeenCalledWith({ continueRecent: false, verbose: false,
    restartArgs: ['--test-fast', '--no-test-fast'], config: { extensionConfig: { codex: { fast: false } } } });
});

it.each(['--unknown', '--no-unknown'])('loads extension definitions before rejecting %s', async argument => {
  const { runCli } = await import('../src/cli-main.js');
  const writeError = vi.fn();
  expect(await runCli([argument], { writeError })).toBe(1);
  expect(state.configOptions).toHaveBeenCalledOnce();
  expect(writeError).toHaveBeenCalledWith(`Unknown option: ${argument}`);
});

it('includes extension flags in help', async () => {
  const { runCli } = await import('../src/cli-main.js');
  const writeOutput = vi.fn();
  expect(await runCli(['--help'], { writeOutput })).toBe(0);
  expect(state.configOptions).toHaveBeenCalledOnce();
  expect(writeOutput).toHaveBeenCalledWith(expect.stringContaining('--test-fast  Fast execution'));
});

it('imports the updater only for an uninjected update command', async () => {
  const { runCli } = await import('../src/cli-main.js');
  expect(await runCli(['update'], { update: async () => 3 })).toBe(3);
  expect(state.updateImports).toBe(0);
  expect(await runCli(['update'], {})).toBe(7);
  expect(state.updateImports).toBe(1); expect(state.update).toHaveBeenCalledOnce();
  expect(state.configImports).toBe(0);
});
