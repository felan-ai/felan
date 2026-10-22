import { describe, expect, it, vi } from 'vitest';
import { DAEMON_COMMANDS, suggestCommand, suggestTopLevelCommand } from '../src/cli-command-suggestions.js';
import { runCli } from '../src/cli-main.js';
import { runDaemonCommand } from '../src/daemon-command.js';

describe('command suggestions', () => {
  it.each(['daemoon', 'daemn', 'daemom', 'deamon'])('suggests daemon for the one-edit typo %s', input => {
    expect(suggestTopLevelCommand([input, 'stop'])).toBe('daemon');
  });

  it.each(['udpate', 'savigns', 'deamon'])('recognizes a bare transposition in %s', input => {
    expect(suggestTopLevelCommand([input])).toBe(input === 'udpate' ? 'update' : input === 'savigns' ? 'savings' : 'daemon');
  });

  it.each([
    ['savngs', '--monthly'],
    ['savngs', '--session', 'example', '--format', 'json'],
  ])('recognizes savings options in %j', (...args) => {
    expect(suggestTopLevelCommand(args)).toBe('savings');
  });

  it('does not guess between equally close candidates or suggest short commands', () => {
    expect(suggestCommand('estart', DAEMON_COMMANDS)).toBeUndefined();
    expect(suggestCommand('apc', ['acp'])).toBeUndefined();
    expect(suggestCommand('start', DAEMON_COMMANDS)).toBeUndefined();
    expect(suggestCommand('unrelated', DAEMON_COMMANDS)).toBeUndefined();
    expect(suggestCommand('dxxmon', ['daemon'])).toBeUndefined();
    expect(suggestCommand('x'.repeat(100_000), DAEMON_COMMANDS)).toBeUndefined();
  });

  it.each([
    ['saving'], ['sayings'], ['updates'], ['updated'], ['date'], ['demon'], ['apc'],
    ['deamon', 'stop', 'the', 'worker'], ['udpate', 'the', 'docs'],
    ['saving', 'time'], ['daemonize'],
    ['--', 'deamon', 'stop'], ['--', 'udpate'], ['--', 'daemon', 'stop'],
    ['--mode', 'text', 'deamon', 'stop'],
  ])('preserves prompt arguments %j', async (...args) => {
    const launch = vi.fn(async () => {});
    const launchHeadless = vi.fn(async () => 0);
    const launchDaemon = vi.fn(async () => 0);
    const update = vi.fn(async () => 0);
    const writeError = vi.fn();
    expect(await runCli(args, { launch, launchHeadless, launchDaemon, update, writeError })).toBe(0);
    const prompt = args.slice(args[0] === '--' ? 1 : args[0] === '--mode' ? 2 : 0).join(' ');
    expect(args[0] === '--mode' ? launchHeadless : launch).toHaveBeenCalledWith(expect.objectContaining({ initialMessage: prompt }));
    expect(launchDaemon).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(writeError).not.toHaveBeenCalled();
  });

  it.each([
    ['deamon', 'stop'], ['daemoon', 'stop'], ['daemn', 'stop'], ['daemom', 'stop'],
    ['deamon', 'stop', '--force'], ['deamon', '--daemon-runtime', '/tmp/isolated'],
    ['savngs', '--daily'], ['udpate'],
  ])('rejects %j without any launch or autocorrection', async (...args) => {
    const launch = vi.fn(async () => {});
    const launchHeadless = vi.fn(async () => 0);
    const launchDaemon = vi.fn(async () => 0);
    const launchAcp = vi.fn(async () => 0);
    const launchAcpLogin = vi.fn(async () => 0);
    const update = vi.fn(async () => 0);
    const writeError = vi.fn();
    expect(await runCli(args, { launch, launchHeadless, launchDaemon, launchAcp, launchAcpLogin, update, writeError })).toBe(1);
    const command = args[0] === 'udpate' ? 'update' : args[0] === 'savngs' ? 'savings' : 'daemon';
    expect(writeError).toHaveBeenCalledWith(`Unknown command: ${args[0]}. Did you mean: felan ${[command, ...args.slice(1)].join(' ')}?`);
    expect(writeError).toHaveBeenCalledWith('Use felan -- <message> to send this as a prompt.');
    for (const operation of [launch, launchHeadless, launchDaemon, launchAcp, launchAcpLogin, update]) expect(operation).not.toHaveBeenCalled();
  });

  it.each([
    ['staart', 'start'], ['stat', 'start'], ['starp', 'start'], ['strat', 'start'],
    ['stpo', 'stop'], ['statu', 'status'], ['foregound', 'foreground'],
  ])('suggests an invalid daemon action %s without constructing a client', async (input, expected) => {
    const io = { writeOutput: vi.fn(), writeError: vi.fn() };
    const createClient = vi.fn();
    const foreground = vi.fn(async () => 0);
    expect(await runDaemonCommand([input], io, { createClient, foreground })).toBe(1);
    expect(io.writeError).toHaveBeenCalledWith(expect.stringContaining(`Did you mean: felan daemon ${expected}?`));
    expect(createClient).not.toHaveBeenCalled();
    expect(foreground).not.toHaveBeenCalled();
  });

  it.each(['estart', 'unrelated', 's'])('rejects ambiguous or unmatched daemon action %s without a guess', async input => {
    const io = { writeOutput: vi.fn(), writeError: vi.fn() };
    const createClient = vi.fn();
    expect(await runDaemonCommand([input], io, { createClient })).toBe(1);
    expect(io.writeError).toHaveBeenCalledWith(expect.stringContaining(`Unknown daemon command: ${input}.`));
    expect(io.writeError).toHaveBeenCalledWith(expect.stringContaining('Usage: felan daemon'));
    expect(io.writeError.mock.calls.flat().join('\n')).not.toContain('Did you mean');
    expect(createClient).not.toHaveBeenCalled();
  });

  it('keeps invalid daemon actions nonzero even with help and preserves valid help', async () => {
    const io = { writeOutput: vi.fn(), writeError: vi.fn() };
    const createClient = vi.fn();
    expect(await runDaemonCommand(['strat', '--help'], io, { createClient })).toBe(1);
    expect(io.writeError).toHaveBeenCalledWith(expect.stringContaining('Did you mean: felan daemon start?'));
    expect(await runDaemonCommand(['--help'], io, { createClient })).toBe(0);
    expect(await runDaemonCommand(['start', '--help'], io, { createClient })).toBe(0);
    expect(createClient).not.toHaveBeenCalled();
  });
});
