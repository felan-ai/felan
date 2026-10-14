import { EventEmitter } from 'node:events';
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { legacySessionDirectoryName } from '../../daemon/src/daemon/legacy-sessions.js';
import { runLocalFelanHeadless } from '../src/headless.js';
import { TuiSessionController } from '../src/tui/controller.js';
import { acpDaemonFixture } from './acp-daemon-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// The registered root is stamped ten minutes ago, so a quiet pre-daemon file from one minute ago is the most recent.
// The clock returns to real time before any request, because request IDs must not be ahead of it.
async function fixture() {
  let skew = 10 * 60_000;
  const f = await acpDaemonFixture({ now: () => Date.now() - skew }); cleanups.push(() => f.dispose()); skew = 0;
  expect(f.store.session(f.root.sessionId).updatedAt).toBeLessThan(Date.now() - 5 * 60_000);
  const id = '019a0000-0000-7000-8000-0000000000c0'; const timestamp = '2026-01-01T00:00:00.000Z';
  const directory = join(f.owner.target.agentDir, 'sessions', legacySessionDirectoryName(f.cwd));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  await writeFile(path, [{ type: 'session', version: 3, id, timestamp, cwd: f.cwd },
    { type: 'model_change', id: 'aaaa0001', parentId: null, timestamp, provider: 'offline', modelId: 'fixture' },
    { type: 'message', id: 'aaaa0002', parentId: 'aaaa0001', timestamp, message: { role: 'user', content: 'from 0.28.3', timestamp: 1 } },
  ].map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
  const minuteAgo = new Date(Date.now() - 60_000); await utimes(path, minuteAgo, minuteAgo);
  return { ...f, id, path };
}

it('headless --continue picks a pre-daemon session newer than every registered session and appends to its file', async () => {
  const f = await fixture();
  const output: string[] = []; const errors: string[] = [];
  expect(await runLocalFelanHeadless({ cwd: f.cwd, createClient: f.createClient, signalSource: new EventEmitter(), mode: 'text',
    initialMessage: 'continue legacy', continueRecent: true, writeOutput: text => { output.push(text); }, writeError: line => { errors.push(line); } }), errors.join('\n')).toBe(0);
  expect(f.store.session(f.id).piPath).toBe(f.path);
  expect(await readFile(f.path, 'utf8')).toContain('continue legacy');
  expect(f.store.snapshot().sessions).toHaveLength(2);
});

it('TUI --continue attaches a pre-daemon session newer than every registered session', async () => {
  const f = await fixture();
  const client = f.createClient({ target: { kind: 'isolated', directory: f.directory, namespaceId: 'ignored' }, kind: 'tui', clientVersion: 'fixture' });
  const controller = new TuiSessionController(client); cleanups.push(() => controller.dispose());
  await controller.start({ cwd: f.cwd, continueRecent: true });
  expect(controller.sessionId).toBe(f.id);
  expect(f.store.session(f.id)).toMatchObject({ piPath: f.path, title: '' });
  expect(f.store.snapshot().sessions).toHaveLength(2);
});
