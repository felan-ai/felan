import { afterEach, expect, it, vi } from 'vitest';
import { LIMITS, parseUiPresentation, type ClientEnvelope } from '@felan-ai/session-protocol';
import { SessionCommands } from '../src/daemon/commands.js';
import type { AdmittedCommand } from '../src/daemon/admission.js';
import type { HostConfiguration } from '../src/daemon/host-services.js';
import type { SessionRegistry } from '../src/daemon/registry.js';
import type { SessionProjection } from '../src/daemon/projection.js';
import { ControlStoreError } from '../src/daemon/control-state.js';
import { serverFixture } from './fixtures/server.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(command = 'echo hi', fail?: Error, projection?: SessionProjection) {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  let output!: (text: string) => void;
  let finish!: () => void;
  let work!: Promise<unknown>;
  const recordBashResult = vi.fn(); const refresh = vi.fn(() => projection?.refresh());
  const publish = vi.fn((value: Parameters<SessionProjection['setPresentation']>[0]) => {
    if (typeof value === 'object' && value && !('remove' in value)) parseUiPresentation(value);
    if (fail) throw fail;
    projection?.setPresentation(value);
  });
  const registry = {
    binding: () => ({ runtime: { session: { settingsManager: { getShellPath() {}, getShellCommandPrefix() {} } } } }),
    projection: () => ({ setPresentation: publish, refresh }),
    options: { store: { session: () => ({ run: { id: 'run' } }) } },
    processes: { prepareForeground() {}, startForeground: async () => ({ resourceId: 'resource' }),
      waitForeground: (_session: string, _resource: string, onOutput: (text: string) => void) => {
        output = onOutput;
        return new Promise(resolve => { finish = () => resolve({ output: 'final', exitCode: 0, cancelled: false, truncated: false }); });
      } },
    runAdmitted: (_id: string, _session: string, _origin: unknown, run: (session: unknown) => Promise<void>) => {
      work = run({ recordBashResult }); return work;
    },
  } as unknown as SessionRegistry;
  const dispatcher = new SessionCommands({ registry, configuration: {} as HostConfiguration, models: { getAvailable: async () => [] }, invalidated() {} });
  const request: ClientEnvelope = { v: 1, id: 'request', op: 'shell.execute', session: 'session', params: { command, includeInContext: true } };
  const result = await dispatcher.prepare({ request } as AdmittedCommand, { origin: { kind: 'tui', attachment: 'client' } });
  await expect(result.response).resolves.toMatchObject({ outcome: 'accepted' });
  return { publish, output, recordBashResult, refresh, finish: async () => { finish(); await work; } };
}

it('flushes the latest trailing chunk during silence and cancels the timer at completion', async () => {
  const f = await fixture();
  f.output('Building'); await vi.advanceTimersByTimeAsync(30); f.output('Building…');
  expect(f.publish).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(70);
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: '```\n$ echo hi\nBuilding…\n```' }));
  f.output('not yet published'); await f.finish();
  await vi.advanceTimersByTimeAsync(200);
  expect(f.publish).toHaveBeenLastCalledWith({ id: 'resource', remove: true });
  expect(f.recordBashResult).toHaveBeenCalledOnce();
});

it.each(['invalid_request', 'capacity', 'unavailable'])('does not abort foreground work on a %s presentation failure', async code => {
  const f = await fixture('echo hi', Object.assign(new Error(code), { code }));
  f.output('one'); await vi.advanceTimersByTimeAsync(100); f.output('two');
  await f.finish();
  expect(f.recordBashResult).toHaveBeenCalledWith('echo hi', expect.objectContaining({ output: 'final' }), { excludeFromContext: false });
  expect(f.refresh).toHaveBeenCalledOnce();
});

it('removes the completed shell document locally when removal publication fails', async () => {
  const server = await serverFixture(); cleanups.push(() => server.dispose());
  const projection = server.registry.projection(server.root.sessionId);
  const publish = projection.publish.bind(projection);
  vi.spyOn(projection, 'publish').mockImplementation((change, patch) => {
    if (change.type === 'presentation.removed') throw new ControlStoreError('request_capacity', 'Control capacity is reserved.');
    publish(change, patch);
  });
  const f = await fixture('echo hi', undefined, projection);
  expect(projection.snapshot().presentation).toContainEqual(expect.objectContaining({ id: 'resource', kind: 'document' }));
  await f.finish();
  expect(f.recordBashResult).toHaveBeenCalledOnce();
  expect(f.publish.mock.results.at(-1)).toMatchObject({ type: 'throw', value: { code: 'request_capacity' } });
  expect(projection.presentations().some(element => element.id === 'resource')).toBe(false);
  expect(projection.snapshot().presentation.some(element => element.id === 'resource')).toBe(false);
});

it('bounds encoded frames and does not duplicate command/output in data', async () => {
  const f = await fixture('"\\'.repeat(8192));
  f.output('\u0001"\\'.repeat(8192)); await vi.advanceTimersByTimeAsync(100);
  const frame = f.publish.mock.calls.at(-1)![0] as { data: object };
  expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(LIMITS.structuredBytes);
  expect(frame.data).toEqual({ commandLength: expect.any(Number), excludeFromContext: false });
  await f.finish();
});

it('fences literal multiline markdown with a fence longer than every backtick run', async () => {
  const command = 'echo "````"\n# literal command'; const output = '# title\n- list\n| cell & value |\n`````';
  const f = await fixture(command); f.output(output); await vi.advanceTimersByTimeAsync(100);
  expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: `\`\`\`\`\`\`\n$ ${command}\n${output}\n\`\`\`\`\`\`` }));
  await f.finish();
});
