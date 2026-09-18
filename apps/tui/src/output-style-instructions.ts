import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { FelanExtension, FelanExtensionAPI } from '@felan-ai/agent-core';
import {
  createOutputStyleExtension,
  parseOutputStyle,
  resolveCustomOutputStyleSource,
  type OutputStyle,
} from '@felan-ai/ext-output-style';

export function createLocalOutputStyleExtension(fallbackStyle: OutputStyle): FelanExtension {
  return (pi: FelanExtensionAPI) => {
    const style = parseOutputStyle(pi.config?.style ?? fallbackStyle);
    if (style !== 'custom') return createOutputStyleExtension(style)(pi);
    const source = resolveCustomOutputStyleSource(pi.config?.instructions, pi.config?.instructionsFile);
    if (source.kind === 'inline') return createOutputStyleExtension(style, source.instructions)(pi);
    return loadOutputStyleInstructionsFile(pi.agentDir, source.path).then((instructions) => {
      createOutputStyleExtension(style, instructions)(pi);
    });
  };
}

export function resolveOutputStyleInstructionsPath(agentDir: string, configuredPath: string): string {
  if (configuredPath.includes('\0')) {
    throw new Error('outputStyle.instructionsFile must not contain NUL bytes');
  }
  if (configuredPath.startsWith('~/')) return resolve(homedir(), configuredPath.slice(2));
  if (isAbsolute(configuredPath)) return configuredPath;
  if (agentDir.trim().length === 0) {
    throw new Error('outputStyle.instructionsFile requires an agent directory');
  }
  return resolve(agentDir, configuredPath);
}

export async function loadOutputStyleInstructionsFile(
  agentDir: string,
  configuredPath: string,
): Promise<string> {
  const resolvedPath = resolveOutputStyleInstructionsPath(agentDir, configuredPath);
  let content: string;
  try {
    content = await readFile(resolvedPath, 'utf8');
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`outputStyle.instructionsFile not found: ${resolvedPath}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`outputStyle.instructionsFile could not be read: ${resolvedPath}: ${message}`);
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error(`outputStyle.instructionsFile is empty: ${resolvedPath}`);
  }
  return trimmed;
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}
