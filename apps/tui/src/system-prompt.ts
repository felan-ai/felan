import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const LOCAL_APPEND_SYSTEM_PROMPT_FILENAME = 'APPEND_SYSTEM.md';

export async function loadLocalAppendSystemPrompt(agentDir: string): Promise<string | undefined> {
  try {
    const prompt = await readFile(join(agentDir, LOCAL_APPEND_SYSTEM_PROMPT_FILENAME), 'utf8');
    return prompt.trim().length === 0 ? undefined : prompt.trim();
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

export async function loadLocalChildSystemPromptAppends(
  agentDir: string,
  persona: string,
): Promise<readonly string[]> {
  const applicationAppend = await loadLocalAppendSystemPrompt(agentDir);
  return [...(applicationAppend === undefined ? [] : [applicationAppend]), persona];
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
