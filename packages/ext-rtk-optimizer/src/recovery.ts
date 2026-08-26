import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '@felan-ai/agent-core';
import { joinRuntimePath } from './runtime-path.js';

const RECOVERY_DIRECTORY = 'rtk-optimizer/recovery';
const RECOVERY_FILE_PATTERN = /^\d{13}-[0-9a-f-]{36}\.txt$/u;
const MAX_RECOVERY_BYTES = 2 * 1024 * 1024;
const MAX_RECOVERY_FILES = 64;
const MAX_RECOVERY_TOTAL_BYTES = 16 * 1024 * 1024;
const encoder = new TextEncoder();

/**
 * Stores the exact pre-compaction text in session storage and returns a path
 * readable through the same runtime namespace. A failed or oversized write is
 * reported as undefined so callers can fail open instead of showing a lossy
 * result with no recovery path.
 */
export async function persistRecoveryArtifact(runtime: AgentRuntime, text: string): Promise<string | undefined> {
  const bytes = encoder.encode(text);
  if (bytes.byteLength > MAX_RECOVERY_BYTES) return undefined;

  const storage = runtime.storage('session');
  const directory = joinRuntimePath(storage.root, RECOVERY_DIRECTORY);
  const fileName = `${Date.now()}-${randomUUID()}.txt`;
  const relativePath = joinRuntimePath(RECOVERY_DIRECTORY, fileName);
  const absolutePath = joinRuntimePath(storage.root, relativePath);

  try {
    await storage.mkdir(RECOVERY_DIRECTORY, { recursive: true });
    await pruneRecoveryArtifacts(runtime, directory);
    await storage.writeFile(relativePath, bytes);
    return absolutePath;
  } catch {
    await storage.remove(relativePath).catch(() => {});
    return undefined;
  }
}

async function pruneRecoveryArtifacts(runtime: AgentRuntime, directory: string): Promise<void> {
  const storage = runtime.storage('session');
  const entries = await storage.listFiles(directory, { limit: MAX_RECOVERY_FILES + 1 });
  const candidates = entries
    .filter((entry) => RECOVERY_FILE_PATTERN.test(fileName(entry)))
    .sort();

  const sizes: Array<{ path: string; bytes: number }> = [];
  for (const entry of candidates) {
    const path = joinRuntimePath(RECOVERY_DIRECTORY, fileName(entry));
    try {
      sizes.push({ path, bytes: (await storage.readFile(path)).byteLength });
    } catch {
      await storage.remove(path).catch(() => {});
    }
  }

  let total = sizes.reduce((sum, entry) => sum + entry.bytes, 0);
  while (sizes.length >= MAX_RECOVERY_FILES || total > MAX_RECOVERY_TOTAL_BYTES) {
    const oldest = sizes.shift();
    if (!oldest) break;
    total -= oldest.bytes;
    await storage.remove(oldest.path).catch(() => {});
  }
}

function fileName(path: string): string {
  const normalized = path.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}
