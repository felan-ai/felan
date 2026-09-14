import { describe, expect, it } from 'vitest';
import { validateMemoryArtifact } from '../src/index.js';

const validArtifact = [
  { path: 'summary.md', content: 'Release workflow orientation.' },
  {
    path: 'index.md',
    content: '# Memory index\n\n## How to use this memory\n\n## Memory map\n- [Workflow](pages/workflows/index.md)\n',
  },
  { path: 'pages/workflows/index.md', content: '# Workflows\n\n- [Release](release.md)\n' },
  { path: 'pages/workflows/release.md', content: '# Release\n\n## Sources\n- session:session-1\n' },
] as const;

describe('strict memory publication validation', () => {
  it('accepts a complete artifact with allowed provenance', () => {
    expect(validateMemoryArtifact(validArtifact, {
      memoryPath: '.memory',
      sourceSessionIds: ['session-1'],
    })).toMatchObject({ ok: true });
  });

  it('requires publication files and page provenance', () => {
    const incomplete = validateMemoryArtifact([
      { path: 'summary.md', content: 'Incomplete memory.' },
      { path: 'pages/workflows/release.md', content: '# Release without provenance' },
    ]);
    expect(incomplete.ok).toBe(false);
    expect(errorCodes(incomplete)).toEqual(expect.arrayContaining([
      'missing_required_file',
      'missing_sources',
      'unreachable_page',
    ]));
  });

  it('requires publication navigation', () => {
    const withoutNavigation = validateMemoryArtifact(validArtifact.map((file) => file.path === 'index.md'
      ? { ...file, content: '# Memory index\n\n## How to use this memory\n\n## Memory map\n' }
      : file));
    expect(withoutNavigation.ok).toBe(false);
    expect(errorCodes(withoutNavigation)).toContain('invalid_markdown');
  });

  it('rejects publication provenance outside the source allowlist', () => {
    const unknownSource = validateMemoryArtifact(validArtifact.map((file) => ({
      ...file,
      content: file.content.replace('session:session-1', 'session:session-2'),
    })), { sourceSessionIds: ['session-1'] });
    expect(unknownSource.ok).toBe(false);
    expect(errorCodes(unknownSource)).toContain('unknown_source');
  });

  it.each([
    '../outside.md',
    '/outside.md',
    '..\\outside.md',
    'pages/../../outside.md',
    'C:\\outside.md',
  ])('rejects unsafe publication path %s', (path) => {
    const unsafePath = validateMemoryArtifact([
      ...validArtifact,
      { path, content: 'unsafe' },
    ]);
    expect(unsafePath.ok).toBe(false);
    expect(errorCodes(unsafePath)).toContain('invalid_path');
  });
});

function errorCodes(result: ReturnType<typeof validateMemoryArtifact>): string[] {
  return result.errors.map(({ code }) => code);
}
