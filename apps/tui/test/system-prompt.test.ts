import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LOCAL_APPEND_SYSTEM_PROMPT_FILENAME,
  loadLocalAppendSystemPrompt,
  loadLocalChildSystemPromptAppends,
} from '../src/system-prompt.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('local system prompt append', () => {
  it('returns one trimmed agent append and ignores missing or blank files', async () => {
    const missingDir = await temporaryDirectory();
    await expect(loadLocalAppendSystemPrompt(missingDir)).resolves.toBeUndefined();

    const blankDir = await temporaryDirectory();
    await writeFile(join(blankDir, LOCAL_APPEND_SYSTEM_PROMPT_FILENAME), '  \n\t');
    await expect(loadLocalAppendSystemPrompt(blankDir)).resolves.toBeUndefined();

    const configuredDir = await temporaryDirectory();
    await writeFile(
      join(configuredDir, LOCAL_APPEND_SYSTEM_PROMPT_FILENAME),
      '\nLocal application instructions\n',
    );
    await expect(loadLocalAppendSystemPrompt(configuredDir)).resolves.toBe(
      'Local application instructions',
    );
  });

  it('surfaces real read errors', async () => {
    const agentDir = await temporaryDirectory();
    await mkdir(join(agentDir, LOCAL_APPEND_SYSTEM_PROMPT_FILENAME));

    await expect(loadLocalAppendSystemPrompt(agentDir)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('keeps child persona instructions after the application append', async () => {
    const agentDir = await temporaryDirectory();
    await writeFile(
      join(agentDir, LOCAL_APPEND_SYSTEM_PROMPT_FILENAME),
      'Local application instructions',
    );

    await expect(loadLocalChildSystemPromptAppends(agentDir, 'Child persona')).resolves.toEqual([
      'Local application instructions',
      'Child persona',
    ]);
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-local-prompt-'));
  temporaryPaths.push(path);
  return path;
}
