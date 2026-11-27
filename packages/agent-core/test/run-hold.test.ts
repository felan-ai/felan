import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUN_HOLD_EVENT, createAgentCoreResourceLoader, runHoldRefusals, type RunHoldEvent } from '../src/index.js';

const temporaryPaths: string[] = [];
afterEach(async () => { await Promise.all(temporaryPaths.splice(0).map(path => rm(path, { force: true, recursive: true }))); });

async function loader(refuse: (event: RunHoldEvent) => void) {
  const root = await mkdtemp(join(tmpdir(), 'run-hold-'));
  temporaryPaths.push(root);
  return createAgentCoreResourceLoader({ cwd: root, agentDir: join(root, 'agent'), extensionFactories: [
    { name: '@felan-ai/quiet', factory: () => {} },
    { name: '@felan-ai/holder', factory: pi => { pi.events.on(RUN_HOLD_EVENT, event => refuse(event as RunHoldEvent)); } },
  ] });
}

describe('run hold refusals', () => {
  it('collects the reasons extensions give on the session bus', async () => {
    let active = true;
    const resourceLoader = await loader(event => { if (active) event.refuse('state is kept in memory'); });
    expect(runHoldRefusals({ resourceLoader })).toEqual(['state is kept in memory']);
    active = false;
    expect(runHoldRefusals({ resourceLoader })).toEqual([]);
  });

  it('asks only the session whose loader created the bus', async () => {
    const refusing = await loader(event => event.refuse('busy'));
    const other = await loader(() => {});
    expect(runHoldRefusals({ resourceLoader: other })).toEqual([]);
    expect(runHoldRefusals({ resourceLoader: refusing })).toEqual(['busy']);
  });

  it('allows a hold for a loader it did not create', () => {
    expect(runHoldRefusals({ resourceLoader: {} as never })).toEqual([]);
  });
});
