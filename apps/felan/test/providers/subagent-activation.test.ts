import { afterEach, expect, it } from 'vitest';
import { serverFixture } from '../../../daemon/test/fixtures/server.js';
import { fixtures } from '../../../daemon/test/fixtures/registry.js';
import { executionPort } from './fixtures/execution-port.js';
afterEach(async () => { for (const dispose of fixtures.splice(0)) await dispose(); });

it('requires canonical registration before accessing execution controls', async () => {
  const f = await serverFixture(); fixtures.push(() => f.dispose());
  const port = await executionPort(f.registry, f.root.sessionId);
  expect(port.executions().listExecutions()).toEqual([]);
  expect(() => f.registry.executionHost('unregistered')).toThrow();
});
