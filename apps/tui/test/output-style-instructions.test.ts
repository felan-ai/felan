import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FelanExtensionAPI } from '@felan-ai/agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLocalOutputStyleExtension,
  loadOutputStyleInstructionsFile,
  resolveOutputStyleInstructionsPath,
} from '../src/output-style-instructions.js';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('local output-style instruction files', () => {
  it('resolves relative paths from the agent directory and expands home paths', () => {
    expect(resolveOutputStyleInstructionsPath('/tmp/agent', 'output-style.md')).toBe(
      resolve('/tmp/agent', 'output-style.md'),
    );
    expect(resolveOutputStyleInstructionsPath('/tmp/agent', '/abs/output-style.md')).toBe(
      '/abs/output-style.md',
    );
    expect(resolveOutputStyleInstructionsPath('/tmp/agent', '~/output-style.md')).toBe(
      resolve(homedir(), 'output-style.md'),
    );
    expect(() => resolveOutputStyleInstructionsPath('', 'output-style.md')).toThrow(
      'outputStyle.instructionsFile requires an agent directory',
    );
    expect(() => resolveOutputStyleInstructionsPath('/tmp/agent', 'a\0b')).toThrow(
      'outputStyle.instructionsFile must not contain NUL bytes',
    );
  });

  it('loads trimmed UTF-8 contents and reports missing or empty files', async () => {
    const agentDir = await temporaryDirectory();
    await writeFile(join(agentDir, 'output-style.md'), '\nWrite in Bulgarian.\nKeep blockers.\n');

    await expect(loadOutputStyleInstructionsFile(agentDir, 'output-style.md')).resolves.toBe(
      'Write in Bulgarian.\nKeep blockers.',
    );

    await expect(loadOutputStyleInstructionsFile(agentDir, 'missing.md')).rejects.toThrow(
      `outputStyle.instructionsFile not found: ${resolve(agentDir, 'missing.md')}`,
    );

    await writeFile(join(agentDir, 'empty.md'), '  \n');
    await expect(loadOutputStyleInstructionsFile(agentDir, 'empty.md')).rejects.toThrow(
      `outputStyle.instructionsFile is empty: ${resolve(agentDir, 'empty.md')}`,
    );

    await mkdir(join(agentDir, 'dir.md'));
    await expect(loadOutputStyleInstructionsFile(agentDir, 'dir.md')).rejects.toThrow(
      `outputStyle.instructionsFile could not be read: ${resolve(agentDir, 'dir.md')}`,
    );
  });

  it('keeps inline custom instructions synchronous and loads files at bind time', async () => {
    const extension = createLocalOutputStyleExtension('concise');
    const inlinePrompt = applyExtension(extension, {
      style: 'custom',
      instructions: 'Answer in one sentence.',
    });
    expect(inlinePrompt).toContain('<output_style>\nAnswer in one sentence.\n</output_style>');

    const agentDir = await temporaryDirectory();
    await writeFile(join(agentDir, 'style.md'), 'Use Simplified Technical English.');
    const filePrompt = await applyExtensionAsync(extension, {
      style: 'custom',
      instructionsFile: 'style.md',
    }, agentDir);
    expect(filePrompt).toContain('<output_style>\nUse Simplified Technical English.\n</output_style>');

    expect(() => applyExtension(extension, {
      style: 'custom',
      instructions: 'Inline.',
      instructionsFile: 'style.md',
    })).toThrow('outputStyle.instructions and outputStyle.instructionsFile cannot both be set');
  });
});

type BeforeAgentStartHandler = (
  event: { readonly systemPrompt: string },
) => { readonly systemPrompt: string } | undefined;

function applyExtension(
  extension: ReturnType<typeof createLocalOutputStyleExtension>,
  config: Readonly<Record<string, unknown>>,
  agentDir = '/tmp/agent',
): string {
  let handler: BeforeAgentStartHandler | undefined;
  const result = extension({
    agentDir,
    config,
    on: ((event: string, registered: BeforeAgentStartHandler) => {
      if (event === 'before_agent_start') handler = registered;
    }) as FelanExtensionAPI['on'],
  } as FelanExtensionAPI);
  if (result instanceof Promise) throw new Error('Expected synchronous output-style binding');
  return handler?.({ systemPrompt: 'Base prompt' })?.systemPrompt ?? 'Base prompt';
}

async function applyExtensionAsync(
  extension: ReturnType<typeof createLocalOutputStyleExtension>,
  config: Readonly<Record<string, unknown>>,
  agentDir: string,
): Promise<string> {
  let handler: BeforeAgentStartHandler | undefined;
  await extension({
    agentDir,
    config,
    on: ((event: string, registered: BeforeAgentStartHandler) => {
      if (event === 'before_agent_start') handler = registered;
    }) as FelanExtensionAPI['on'],
  } as FelanExtensionAPI);
  return handler?.({ systemPrompt: 'Base prompt' })?.systemPrompt ?? 'Base prompt';
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'felan-output-style-'));
  temporaryPaths.push(path);
  return path;
}
