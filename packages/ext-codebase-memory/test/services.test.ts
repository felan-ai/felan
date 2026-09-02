import { describe, expect, it, vi } from 'vitest';
import { CbmClient } from '../src/client.js';
import { ProjectService } from '../src/services.js';
import { envelope, MemoryRuntime, result } from './test-runtime.js';

const invocation = { command: 'codebase-memory-mcp', version: '0.10.8', source: 'managed' } as const;

describe('ProjectService index coordination', () => {
  it('deduplicates indexing for services that share one frontend', async () => {
    const indexing = deferred<ReturnType<typeof result>>();
    let indexCalls = 0;
    const runtime = new MemoryRuntime('host', true, async (command) => {
      if (command.includes('index_repository')) {
        indexCalls += 1;
        return indexing.promise;
      }
      return result(envelope({ projects: [] }));
    });
    const client = new CbmClient(runtime, invocation);
    const first = new ProjectService(runtime, client, undefined, vi.fn());
    const second = new ProjectService(runtime, client, undefined, vi.fn());

    const firstIndex = first.index();
    await vi.waitFor(() => expect(indexCalls).toBe(1));
    const secondIndex = second.index();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(indexCalls).toBe(1);
    indexing.resolve(result(envelope({ status: 'indexed', project: 'fixture' })));
    await Promise.all([firstIndex, secondIndex]);
  });

  it('isolates in-flight indexing between root sessions', async () => {
    const firstIndexing = deferred<ReturnType<typeof result>>();
    let firstCalls = 0;
    let secondCalls = 0;
    const firstRuntime = new MemoryRuntime('host', true, async (command) => {
      if (command.includes('index_repository')) {
        firstCalls += 1;
        return firstIndexing.promise;
      }
      return result(envelope({ projects: [] }));
    });
    const secondRuntime = new MemoryRuntime('host', true, async (command) => {
      if (command.includes('index_repository')) secondCalls += 1;
      return result(envelope({ status: 'indexed', project: 'fixture' }));
    });
    const first = new ProjectService(firstRuntime, new CbmClient(firstRuntime, invocation), undefined, vi.fn());
    const second = new ProjectService(secondRuntime, new CbmClient(secondRuntime, invocation), undefined, vi.fn());

    const firstIndex = first.index();
    await vi.waitFor(() => expect(firstCalls).toBe(1));
    const secondIndex = second.index();
    await vi.waitFor(() => expect(secondCalls).toBe(1));
    firstIndexing.resolve(result(envelope({ status: 'indexed', project: 'fixture' })));
    await Promise.all([firstIndex, secondIndex]);
  });
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
