import { isFelanThinkingLevel, type AgentRuntime } from '@felan-ai/agent-core';
import type { SubagentDescriptor, SubagentThinking } from './contracts.js';

export interface SubagentDefinition {
  readonly descriptor: SubagentDescriptor;
  readonly prompt: string;
  readonly toolProfile?: 'inspection';
}

const bundledDefinitions: readonly SubagentDefinition[] = [
  {
    descriptor: {
      id: 'general',
      description: 'General-purpose agent for implementation and investigation',
      allowNesting: true,
    },
    prompt: 'You are a general-purpose Felan Code subagent. Complete the assigned task and report a concise result.',
  },
  {
    descriptor: {
      id: 'explore',
      description: 'Read-focused agent for codebase exploration and analysis',
      model: 'low',
      thinking: 'off',
      allowNesting: false,
    },
    prompt: 'You are a read-focused Felan Code subagent. Investigate the assigned task and report findings without modifying files.',
    toolProfile: 'inspection',
  },
  {
    descriptor: {
      id: 'reviewer',
      description: 'Code reviewer focused on correctness and regressions',
      model: 'high',
      allowNesting: false,
    },
    prompt: 'You are a code-review subagent for Felan Code. Inspect the assigned work for correctness, security, and regressions without modifying files.',
    toolProfile: 'inspection',
  },
];

export async function discoverSubagents(
  runtime: AgentRuntime,
  agentDir: string,
): Promise<readonly SubagentDefinition[]> {
  const definitions = new Map(bundledDefinitions.map((definition) => [definition.descriptor.id, definition]));
  const directories = new Set([
    ...(runtime.userHome ? [`${runtime.userHome}/.agents/agents`] : []),
    `${agentDir}/agents`,
    '.agents/agents',
    '.felan/agents',
  ]);
  for (const directory of directories) {
    for (const definition of await readDefinitions(runtime, directory)) {
      definitions.set(definition.descriptor.id, definition);
    }
  }
  return [...definitions.values()].map(freezeDefinition);
}

async function readDefinitions(runtime: AgentRuntime, directory: string): Promise<SubagentDefinition[]> {
  let files: string[];
  try { files = await runtime.listFiles(directory, { pattern: '*.md' }); }
  catch (error) { if (isMissing(error)) return []; throw error; }
  const definitions: SubagentDefinition[] = [];
  for (const file of files) {
    const source = await runtime.readFile(`${directory}/${file}`);
    definitions.push(parseDefinition(file, new TextDecoder().decode(source)));
  }
  return definitions;
}

function parseDefinition(file: string, source: string): SubagentDefinition {
  const { fields, body } = frontmatter(source);
  const id = fields.id ?? file.split('/').at(-1)!.slice(0, -3);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error(`Invalid Felan Code agent id in ${file}`);
  const description = fields.description?.trim();
  if (!description) throw new Error(`Felan Code agent ${file} requires a description`);
  if (!body.trim()) throw new Error(`Felan Code agent ${file} requires a prompt body`);

  const thinking = parseThinking(fields.thinking, file);
  const defaultMaxTurns = parsePositiveInteger(fields.max_turns, 'max_turns', file);
  const defaultTimeoutSeconds = parsePositiveInteger(fields.timeout_seconds, 'timeout_seconds', file);

  return {
    descriptor: {
      id,
      description,
      allowNesting: fields.allow_nesting === 'true',
      ...(fields.model === undefined ? {} : { model: fields.model }),
      ...(thinking === undefined ? {} : { thinking }),
      ...(defaultMaxTurns === undefined ? {} : { defaultMaxTurns }),
      ...(defaultTimeoutSeconds === undefined ? {} : { defaultTimeoutSeconds }),
    },
    prompt: body.trim(),
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
  if (!isFelanThinkingLevel(value)) {
    throw new Error(`Felan Code agent ${file} has invalid thinking`);
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
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Felan Code agent ${file} has invalid ${field}`);
  return parsed;
}

function freezeDefinition(definition: SubagentDefinition): SubagentDefinition {
  return Object.freeze({
    ...definition,
    descriptor: Object.freeze({ ...definition.descriptor }),
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
