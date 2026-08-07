import { describe, expect, it } from 'vitest';
import { compactToolResult } from '../src/output-compactor.js';
import { OutputMetrics } from '../src/output-metrics.js';
import { DEFAULT_RTK_OPTIMIZER_CONFIG } from '../src/types.js';

const options = { cwd: '/workspace', agentDir: '/agent' };

describe('tool output compaction', () => {
  it('compacts ordinary command output and records metadata', () => {
    const config = structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG);
    const outcome = compactToolResult(
      {
        toolName: 'bash',
        input: { command: 'pnpm test' },
        content: [{ type: 'text', text: '\u001b[32m12 passed, 0 failed\u001b[0m' }],
      },
      config,
      { ...options, metrics: new OutputMetrics() },
    );

    expect(text(outcome.content)).toContain('Test Results:');
    expect(text(outcome.content)).toContain('PASS: 12 passed');
    expect(text(outcome.content)).not.toContain('\u001b');
    expect(outcome.metadata).toMatchObject({
      applied: true,
      techniques: ['ansi', 'test'],
      truncated: true,
    });
  });

  it('preserves the Codex envelope while compacting only its Output payload', () => {
    const config = structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG);
    const envelope = [
      'Chunk ID: abc123',
      'Wall time: 0.1000 seconds',
      'Process exited with code 0',
      'Output:',
      '8 passed, 1 failed',
      'FAIL src/example.test.ts',
      '  Expected true',
    ].join('\n');

    const outcome = compactToolResult(
      {
        toolName: 'exec_command',
        input: { cmd: 'pnpm test' },
        content: [{ type: 'text', text: envelope }],
      },
      config,
      options,
    );
    const compacted = text(outcome.content);

    expect(
      compacted.startsWith(
        ['Chunk ID: abc123', 'Wall time: 0.1000 seconds', 'Process exited with code 0', 'Output:'].join('\n'),
      ),
    ).toBe(true);
    expect(compacted).toContain('Test Results:');
    expect(compacted).toContain('PASS: 8 passed');
    expect(compacted).not.toContain('Chunk ID: abc123\nTest Results:');
  });

  it('uses an originating Codex command for write_stdin chunks', () => {
    const config = structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG);
    const outcome = compactToolResult(
      {
        toolName: 'write_stdin',
        input: { session_id: 1234 },
        content: [
          {
            type: 'text',
            text: 'Chunk ID: def456\nWall time: 1.0000 seconds\nProcess exited with code 0\nOutput:\n4 passed',
          },
        ],
      },
      config,
      { ...options, command: 'pytest' },
    );

    expect(text(outcome.content)).toContain('Chunk ID: def456');
    expect(text(outcome.content)).toContain('PASS: 4 passed');
  });

  it('keeps reads exact by default and when a range is explicit', () => {
    const content = Array.from({ length: 120 }, (_, index) => `line ${index}`).join('\n');
    const defaults = structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG);
    expect(
      compactToolResult(
        {
          toolName: 'read',
          input: { path: 'src/file.ts' },
          content: [{ type: 'text', text: content }],
        },
        defaults,
        options,
      ).changed,
    ).toBe(false);

    defaults.outputCompaction.readCompaction.enabled = true;
    defaults.outputCompaction.truncate.maxChars = 100;
    expect(
      compactToolResult(
        {
          toolName: 'read',
          input: { path: 'src/file.ts', offset: 1 },
          content: [{ type: 'text', text: content }],
        },
        defaults,
        options,
      ).changed,
    ).toBe(false);
  });

  it('preserves Windows-runtime skill reads on a non-Windows controller', () => {
    const config = structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG);
    config.outputCompaction.readCompaction.enabled = true;
    config.outputCompaction.preserveExactSkillReads = true;
    config.outputCompaction.truncate.maxChars = 100;
    const content = Array.from({ length: 120 }, (_, index) => `skill line ${index}`).join('\n');

    const outcome = compactToolResult(
      {
        toolName: 'read',
        input: { path: 'C:\\Workspace\\.agents\\skills\\demo\\SKILL.md' },
        content: [{ type: 'text', text: content }],
      },
      config,
      { cwd: 'C:\\Workspace', agentDir: 'C:\\Users\\agent\\.felan' },
    );

    expect(outcome.changed).toBe(false);
  });

  it('marks opt-in lossy read truncation with a banner', () => {
    const config = structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG);
    config.outputCompaction.readCompaction.enabled = true;
    config.outputCompaction.truncate.maxChars = 180;
    const content = Array.from({ length: 120 }, (_, index) => `export const value${index} = '${'x'.repeat(20)}';`).join(
      '\n',
    );

    const outcome = compactToolResult(
      {
        toolName: 'read',
        input: { path: 'src/file.ts' },
        content: [{ type: 'text', text: content }],
      },
      config,
      options,
    );

    expect(text(outcome.content).startsWith('[RTK compacted output: truncate]')).toBe(true);
    expect(outcome.metadata).toMatchObject({ truncated: true });
  });

  it('never cuts through anchored read lines', () => {
    const config = structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG);
    config.outputCompaction.readCompaction.enabled = true;
    config.outputCompaction.truncate.maxChars = 260;
    const content = Array.from(
      { length: 100 },
      (_, index) => `${index + 1}#AA:export const value${index} = '${'x'.repeat(20)}';`,
    ).join('\n');

    const outcome = compactToolResult(
      {
        toolName: 'read',
        input: { path: 'src/file.ts' },
        content: [{ type: 'text', text: content }],
      },
      config,
      options,
    );

    for (const line of text(outcome.content).split('\n').slice(1)) {
      expect(
        /^\d+#AA:/u.test(line) ||
          line === '[RTK anchor-safe truncate: remaining anchored read lines omitted to preserve complete anchors]',
      ).toBe(true);
    }
  });

  it('groups grep output by file', () => {
    const outcome = compactToolResult(
      {
        toolName: 'grep',
        input: { pattern: 'needle' },
        content: [{ type: 'text', text: 'src/a.ts:2:needle\nsrc/a.ts:5:needle\nsrc/b.ts:1:needle' }],
      },
      structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG),
      options,
    );

    expect(text(outcome.content)).toContain('3 matches in 2 files');
    expect(outcome.techniques).toEqual(['search']);
  });

  it('leaves unrelated tools untouched', () => {
    const outcome = compactToolResult(
      {
        toolName: 'apply_patch',
        input: {},
        content: [{ type: 'text', text: '\u001b[31munchanged\u001b[0m' }],
      },
      structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG),
      options,
    );

    expect(outcome).toEqual({ changed: false, techniques: [] });
  });

  it('preserves non-text blocks beside compacted Codex output', () => {
    const image = { type: 'image', data: 'abc', mimeType: 'image/png' };
    const outcome = compactToolResult(
      {
        toolName: 'exec_command',
        input: { cmd: 'pnpm test' },
        content: [{ type: 'text', text: 'Chunk ID: abc\nOutput:\n1 passed' }, image],
      },
      structuredClone(DEFAULT_RTK_OPTIMIZER_CONFIG),
      options,
    );

    expect(outcome.content?.[1]).toBe(image);
  });
});

function text(content: readonly unknown[] | undefined): string {
  const block = content?.[0] as { text?: unknown } | undefined;
  return typeof block?.text === 'string' ? block.text : '';
}
