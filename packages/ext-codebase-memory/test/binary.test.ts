import { describe, expect, it } from 'vitest';
import { detectCbmBinary } from '../src/binary/detect.js';
import { managedCbmExecutable } from '../src/installer.js';
import { MemoryRuntime, result } from './test-runtime.js';

describe('Codebase Memory binary detection', () => {
  it('prefers managed, then PATH, then ~/.local/bin and reports unavailable', async () => {
    const managed = new MemoryRuntime(async (command) => (
      command === '/agent-storage/codebase-memory/bin/codebase-memory-mcp'
        ? result('codebase-memory-mcp 0.10.8')
        : result('', 127)
    ));
    await expect(detectCbmBinary(managed)).resolves.toMatchObject({
      available: true,
      source: 'managed',
      command: managedCbmExecutable(managed),
      version: '0.10.8',
    });

    const path = new MemoryRuntime(async (command) => (
      command === 'codebase-memory-mcp' ? result('codebase-memory-mcp 0.10.8') : result('', 127)
    ));
    await expect(detectCbmBinary(path)).resolves.toMatchObject({ available: true, source: 'path' });

    const local = new MemoryRuntime(async (command) => {
      if (command === '/bin/sh') return result('/home/felan');
      if (command === '/home/felan/.local/bin/codebase-memory-mcp') return result('codebase-memory-mcp 0.10.8');
      return result('', 127);
    });
    await expect(detectCbmBinary(local)).resolves.toMatchObject({
      available: true,
      source: 'local',
      command: '/home/felan/.local/bin/codebase-memory-mcp',
    });

    await expect(detectCbmBinary(new MemoryRuntime())).resolves.toMatchObject({ available: false });
  });
});
