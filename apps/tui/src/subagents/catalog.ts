import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type {
  SubagentDescriptor,
  SubagentThinking,
} from '@felan-ai/ext-subagents';

export interface LocalSubagentDefinition {
  readonly descriptor: SubagentDescriptor;
  readonly prompt: string;
  readonly capability: 'coding' | 'read-only';
}

const bundledDefinitions: readonly LocalSubagentDefinition[] = [
  {
    descriptor: {
      id: 'general',
      description: 'General-purpose agent for implementation and investigation',
      allowNesting: true,
    },
    prompt: 'You are a general-purpose Felan subagent. Complete the assigned task and report a concise result.',
    capability: 'coding',
  },
  {
    descriptor: {
      id: 'explore',
      description: 'Read-focused agent for codebase exploration and analysis',
      allowNesting: false,
    },
    prompt: 'You are a read-focused Felan subagent. Investigate the assigned task and report findings without modifying files.',
    capability: 'read-only',
  },
  {
    descriptor: {
      id: 'reviewer',
      description: 'Code reviewer focused on correctness and regressions',
      allowNesting: false,
    },
    prompt: 'You are a Felan code-review subagent. Inspect the assigned work for correctness, security, and regressions.',
    capability: 'read-only',
  },
];

export async function discoverLocalSubagents(
  cwd: string,
  agentDir: string,
): Promise<readonly LocalSubagentDefinition[]> {
  const definitions = new Map(bundledDefinitions.map((definition) => [definition.descriptor.id, definition]));
  for (const definition of await readDefinitions(join(agentDir, 'agents'))) {
    definitions.set(definition.descriptor.id, definition);
  }
  for (const definition of await readDefinitions(join(cwd, '.felan', 'agents'))) {
    definitions.set(definition.descriptor.id, definition);
  }
  return [...definitions.values()].map(freezeDefinition);
}

async function readDefinitions(directory: string): Promise<LocalSubagentDefinition[]> {
  let files: string[];
  try {
    files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && extname(entry.name) === '.md')
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }

  const definitions: LocalSubagentDefinition[] = [];
  for (const file of files) {
    definitions.push(parseDefinition(file, await readFile(join(directory, file), 'utf8')));
  }
  return definitions;
}

function parseDefinition(file: string, source: string): LocalSubagentDefinition {
  const { fields, body } = frontmatter(source);
  const id = fields.id ?? basename(file, '.md');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`Invalid Felan agent id in ${file}`);
  const description = fields.description?.trim();
  if (!description) throw new Error(`Felan agent ${file} requires a description`);
  if (!body.trim()) throw new Error(`Felan agent ${file} requires a prompt body`);

  const thinking = parseThinking(fields.thinking, file);
  const defaultMaxTurns = parsePositiveInteger(fields.max_turns, 'max_turns', file);
  const defaultTimeoutSeconds = parsePositiveInteger(fields.timeout_seconds, 'timeout_seconds', file);
  const capability = fields.capability ?? 'coding';
  if (capability !== 'coding' && capability !== 'read-only') {
    throw new Error(`Felan agent ${file} has an unknown capability`);
  }

  return {
    descriptor: {
      id,
      description,
      allowNesting: capability === 'coding' && fields.allow_nesting === 'true',
      ...(fields.model === undefined ? {} : { defaultModel: fields.model }),
      ...(thinking === undefined ? {} : { defaultThinking: thinking }),
      ...(defaultMaxTurns === undefined ? {} : { defaultMaxTurns }),
      ...(defaultTimeoutSeconds === undefined ? {} : { defaultTimeoutSeconds }),
    },
    prompt: body.trim(),
    capability,
  };
}

function frontmatter(source: string): { fields: Record<string, string>; body: string } {
  if (!source.startsWith('---\n')) return { fields: {}, body: source };
  const end = source.indexOf('\n---\n', 4);
  if (end < 0) return { fields: {}, body: source };
  const fields: Record<string, string> = {};
  for (const line of source.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { fields, body: source.slice(end + 5) };
}

function parseThinking(value: string | undefined, file: string): SubagentThinking | undefined {
  if (!value) return undefined;
  if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value)) {
    throw new Error(`Felan agent ${file} has invalid thinking`);
  }
  return value as SubagentThinking;
}

function parsePositiveInteger(
  value: string | undefined,
  field: string,
  file: string,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Felan agent ${file} has invalid ${field}`);
  return parsed;
}

function freezeDefinition(definition: LocalSubagentDefinition): LocalSubagentDefinition {
  return Object.freeze({
    ...definition,
    descriptor: Object.freeze({ ...definition.descriptor }),
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
