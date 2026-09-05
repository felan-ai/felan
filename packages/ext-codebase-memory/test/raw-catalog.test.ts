import type { ToolDefinition } from '@felan-ai/agent-core';
import { describe, expect, it } from 'vitest';
import { RAW_COMMANDS, RAW_TOOL_CATALOG, validateRawArguments } from '../src/raw-catalog.js';

const minimalArguments: Record<string, Record<string, unknown>> = {
  query_graph: { query: 'MATCH (n) RETURN n LIMIT 1' },
  trace_path: { function_name: 'main' },
  get_code_snippet: { qualified_name: 'project.main' },
  search_code: { pattern: 'main' },
};

describe('raw command catalog', () => {
  it('exposes exactly the approved command allowlist with closed object schemas', () => {
    expect(RAW_COMMANDS).toEqual([
      'index_repository', 'search_graph', 'query_graph', 'trace_path',
      'get_graph_schema', 'get_architecture', 'index_status', 'check_index_coverage',
      'detect_changes', 'get_code_snippet', 'search_code', 'list_projects',
    ]);
    expect(RAW_TOOL_CATALOG.map((tool) => tool.name)).toEqual(RAW_COMMANDS);
    for (const tool of RAW_TOOL_CATALOG) {
      const parameters = tool.parameters satisfies ToolDefinition['parameters'];
      expect((parameters as unknown as { type: string }).type).toBe('object');
      expect((parameters as unknown as { additionalProperties: boolean }).additionalProperties).toBe(false);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.projectScoped).toBe(!['index_repository', 'list_projects'].includes(tool.name));
    }
  });

  it.each(RAW_COMMANDS)('accepts minimal %s arguments without mutation or defaults', (command) => {
    const args = Object.freeze({ ...minimalArguments[command] });
    expect(validateRawArguments(command, args)).toBe(args);
    expect(args).toEqual(minimalArguments[command] ?? {});
  });

  it.each(Object.entries(minimalArguments))('requires the %s command-specific field', (command, args) => {
    expect(() => validateRawArguments(command, {})).toThrow('required fields:');
    const field = Object.keys(args)[0]!;
    expect(() => validateRawArguments(command, { [field]: 42 })).toThrow('Invalid arguments');
  });

  it.each(RAW_COMMANDS)('rejects unknown %s fields', (command) => {
    expect(() => validateRawArguments(command, { ...minimalArguments[command], unexpected: true }))
      .toThrow('Unknown fields are not allowed');
  });

  it.each([null, undefined, [], 'value', 1, true])('rejects non-object arguments: %s', (args) => {
    expect(() => validateRawArguments('search_graph', args)).toThrow('expected an object');
  });

  it('allows optional project strings only on scoped commands', () => {
    for (const tool of RAW_TOOL_CATALOG.filter((entry) => entry.projectScoped)) {
      const args = { ...minimalArguments[tool.name], project: 'current-project' };
      expect(validateRawArguments(tool.name, args)).toBe(args);
      expect(() => validateRawArguments(tool.name, { ...args, project: 1 })).toThrow('Invalid arguments');
    }
    expect(() => validateRawArguments('list_projects', { project: 'other' })).toThrow('Invalid arguments');
  });

  it('limits indexing to an optional nonempty repo_path', () => {
    expect(validateRawArguments('index_repository', { repo_path: '/repo' })).toEqual({ repo_path: '/repo' });
    for (const args of [
      { repo_path: '' }, { repo_path: 1 }, { mode: 'full' }, { name: 'override' },
      { persistence: false }, { target_projects: ['*'] }, { project: 'other' },
    ]) {
      expect(() => validateRawArguments('index_repository', args)).toThrow('Invalid arguments');
    }
  });

  it.each([
    ['search_graph', { semantic_query: 'word' }],
    ['search_graph', { format: 'xml' }],
    ['query_graph', { query: 'RETURN 1', graph: 'other' }],
    ['trace_path', { function_name: 'main', limit: 5001 }],
    ['get_architecture', { aspects: ['unknown'] }],
    ['check_index_coverage', { paths: Array(129).fill('file.ts') }],
    ['check_index_coverage', { scopes: Array(33).fill('src') }],
    ['check_index_coverage', { scope_limit: 0 }],
    ['check_index_coverage', { scope_offset: -1 }],
    ['detect_changes', { direction: 'sideways' }],
    ['search_code', { pattern: 'main', limit: 0 }],
    ['list_projects', { limit: 101 }],
    ['list_projects', { offset: 0.5 }],
  ])('validates upstream field constraints for %s', (command, args) => {
    expect(() => validateRawArguments(command as string, args)).toThrow('Invalid arguments');
  });

  it('rejects unsupported commands with bounded errors without leaking argument values', () => {
    for (const command of ['delete_project', 'manage_projects', 'toString', 'x'.repeat(10000)]) {
      try {
        validateRawArguments(command, { secret: 'private-value' });
        expect.unreachable('Expected command rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('Unsupported Codebase Memory command');
        expect((error as Error).message.length).toBeLessThan(200);
        expect((error as Error).message).not.toContain('private-value');
      }
    }
  });
});
