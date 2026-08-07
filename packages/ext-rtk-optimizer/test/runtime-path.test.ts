import { describe, expect, it } from 'vitest';
import { isRuntimePathUnderRoot, joinRuntimePath, normalizeRuntimePath } from '../src/runtime-path.js';

describe('runtime-owned path handling', () => {
  it('joins POSIX and Windows runtime roots without controller-OS reinterpretation', () => {
    expect(joinRuntimePath('/agent/storage', 'rtk-optimizer/config.json')).toBe(
      '/agent/storage/rtk-optimizer/config.json',
    );
    expect(joinRuntimePath('C:\\Users\\agent\\storage', 'rtk-optimizer/config.json')).toBe(
      'C:\\Users\\agent\\storage\\rtk-optimizer\\config.json',
    );
    expect(joinRuntimePath('C:/Users/agent/storage', 'rtk-optimizer/config.json')).toBe(
      'C:\\Users\\agent\\storage\\rtk-optimizer\\config.json',
    );
  });

  it('normalizes and compares Windows paths case-insensitively', () => {
    const cwd = 'C:\\Workspace\\project';
    expect(normalizeRuntimePath('.\\src\\..\\.agents\\skills\\demo\\SKILL.md', cwd)).toBe(
      'c:/workspace/project/.agents/skills/demo/skill.md',
    );
    expect(
      isRuntimePathUnderRoot(
        'C:\\WORKSPACE\\project\\.agents\\skills\\demo\\SKILL.md',
        'c:\\workspace\\project\\.agents\\skills',
        cwd,
      ),
    ).toBe(true);
  });

  it('normalizes POSIX traversal without escaping the root', () => {
    expect(normalizeRuntimePath('../../skills/demo/SKILL.md', '/workspace/project')).toBe('/skills/demo/SKILL.md');
  });
});
