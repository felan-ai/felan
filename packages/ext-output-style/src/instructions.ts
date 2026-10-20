import { isAbsolute, resolve } from 'node:path';
import type { AgentRuntime } from '@felan-ai/agent-core';

export async function loadOutputStyleInstructions({ runtime, agentDir, path }: { runtime: AgentRuntime; agentDir: string; path: string }): Promise<string> {
  if (path.includes('\0')) throw new Error('outputStyle.instructionsFile must not contain NUL bytes');
  if (!isAbsolute(path) && !path.startsWith('~/') && !agentDir.trim()) {
    throw new Error('outputStyle.instructionsFile requires an agent directory');
  }
  const resolvedPath = path.startsWith('~/') ? path : resolve(agentDir, path);
  let content: Uint8Array;
  try {
    content = await runtime.readFile(resolvedPath);
  } catch (error) {
    if (typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT') {
      throw new Error(`outputStyle.instructionsFile not found: ${resolvedPath}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`outputStyle.instructionsFile could not be read: ${resolvedPath}: ${message}`);
  }
  const instructions = new TextDecoder().decode(content).trim();
  if (!instructions) throw new Error(`outputStyle.instructionsFile is empty: ${resolvedPath}`);
  return instructions;
}
