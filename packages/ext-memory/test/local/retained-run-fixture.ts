import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryRunRetentionOptions } from '../../src/local/run-retention.js';

export interface RetainedRunFixture {
  readonly id: string;
  readonly directory: string;
  readonly workspace: string;
  readonly manifestPath: string;
  readonly sessionPath: string;
}

export async function createRetainedRunFixture(
  fixture: MemoryRunRetentionOptions,
  overrides: Record<string, unknown> = {},
): Promise<RetainedRunFixture> {
  const id = String(overrides.sessionId ?? randomUUID());
  const directory = join(fixture.projectDirectory, 'runs', id);
  const workspace = join(directory, 'workspace');
  const sessionFile = `${id}.jsonl`;
  const manifestPath = join(directory, 'manifest.json');
  const sessionPath = join(fixture.sessionDirectory, sessionFile);
  const metadata = {
    version: 1, kind: 'memory', sessionId: id, projectKey: fixture.projectKey, sessionFile,
    startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), status: 'completed', ...overrides,
  };
  await mkdir(join(workspace, '.memory'), { recursive: true });
  await Promise.all([
    writeFile(join(workspace, '.memory', 'summary.md'), 'output'),
    writeFile(manifestPath, `${JSON.stringify(metadata)}\n`),
    writeFile(sessionPath, `${JSON.stringify({ type: 'session', version: 3, id, timestamp: metadata.startedAt, cwd: '/workspace' })}\n${JSON.stringify({
      type: 'custom', id: 'marker', parentId: null, timestamp: metadata.startedAt,
      customType: 'felan-memory-run', data: metadata,
    })}\n`),
  ]);
  return { id, directory, workspace, manifestPath, sessionPath };
}
