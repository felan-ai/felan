import { describe, expect, it } from 'vitest';
import { stripAnsi, stripAnsiFast } from '../src/techniques/ansi.js';
import { filterBuildOutput, isBuildCommand } from '../src/techniques/build.js';
import { normalizeCommandForDetection } from '../src/techniques/command-detection.js';
import { compactGitOutput, compactStatus } from '../src/techniques/git.js';
import { aggregateLinterOutput } from '../src/techniques/linter.js';
import { compactPath } from '../src/techniques/path-utils.js';
import { groupSearchResults } from '../src/techniques/search.js';
import { detectLanguage, filterAggressive, filterMinimal, smartTruncate } from '../src/techniques/source.js';
import { aggregateTestOutput, isTestCommand } from '../src/techniques/test-output.js';
import { truncate, truncateHeadTail } from '../src/techniques/truncate.js';

describe('output compaction techniques', () => {
  it('strips CSI and OSC ANSI sequences without copying plain text', () => {
    const plain = 'plain output';
    expect(stripAnsi('\u001b[31merror\u001b[0m \u001b]0;title\u0007done')).toBe('error done');
    expect(stripAnsiFast(plain)).toBe(plain);
  });

  it('normalizes environment-prefixed command chains for detection', () => {
    expect(normalizeCommandForDetection("CI=1 NODE_ENV='test mode' PNPM_HOME=/tmp pnpm test && echo done")).toBe(
      'pnpm test',
    );
    expect(normalizeCommandForDetection('\n  NPM RUN BUILD\nignored')).toBe('npm run build');
    expect(normalizeCommandForDetection(undefined)).toBeNull();
  });

  it('detects and compacts build output', () => {
    expect(isBuildCommand('CI=1 npm run build')).toBe(true);
    expect(filterBuildOutput('Compiling core\nChecking app\n', 'cargo build')).toBe(
      '[OK] Build successful (2 units compiled)',
    );
    expect(filterBuildOutput('error: failed\n  --> src/main.rs:1\n', 'cargo check')).toContain('[ERROR] 1 error(s):');
    expect(filterBuildOutput('unchanged', 'echo build')).toBeNull();
  });

  it('summarizes test runs and retains failure details', () => {
    const output = [
      '3 passed, 1 failed, 2 skipped',
      'FAIL src/example.test.ts',
      '  Expected: true',
      '  Received: false',
      '',
    ].join('\n');

    expect(isTestCommand('CI=1 npx vitest run')).toBe(true);
    expect(aggregateTestOutput(output, 'npx vitest run')).toContain('PASS: 3 passed');
    expect(aggregateTestOutput(output, 'npx vitest run')).toContain('FAIL src/example.test.ts');
    expect(aggregateTestOutput(output, 'node test.js')).toBeNull();
    expect(aggregateTestOutput('test result: ok. 9 passed; 1 failed; 2 ignored; 0 measured', 'cargo test')).toContain(
      'PASS: 9 passed',
    );
    expect(aggregateTestOutput('test result: ok. 9 passed; 1 failed; 2 ignored; 0 measured', 'cargo test')).toContain(
      'FAIL: 1 failed',
    );
  });

  it('compacts raw git diff, status, and log output only for matching commands', () => {
    const diff = 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
    expect(compactGitOutput(diff, 'git diff')).toContain('> src/a.ts');
    expect(compactGitOutput('already compacted', 'git diff')).toBeNull();
    expect(compactStatus('## main...origin/main\nM  staged.ts\n M modified.ts\n?? new.ts')).toContain(
      'Untracked: 1 files',
    );
    expect(compactGitOutput('first\nsecond', 'git log --oneline')).toBe('first\nsecond');
  });

  it('aggregates linter issues by rule and file', () => {
    const output = [
      'src/a.ts:1:2: Unexpected any [no-explicit-any]',
      'src/a.ts:4:2: warning unused value [unused]',
    ].join('\n');

    const compacted = aggregateLinterOutput(output, 'npx eslint .');
    expect(compacted).toContain('ESLint: 1 errors, 1 warnings in 1 files');
    expect(compacted).toContain('no-explicit-any (1x)');
    expect(aggregateLinterOutput('', 'npx eslint .')).toBe('[OK] ESLint: No issues found');
  });

  it('groups search results and shortens long paths', () => {
    const path = '/workspace/packages/feature/src/very-long-component-name.ts';
    expect(compactPath(path, 30).length).toBeLessThanOrEqual(30);
    expect(compactPath(path, 30)).toBe('…/very-long-component-name.ts');

    const compacted = groupSearchResults(`${path}:12:const match = true;\nsrc/b.ts:3:return match;`);
    expect(compacted).toContain('2 matches in 2 files');
    expect(compacted).toContain('12: const match = true;');
    expect(groupSearchResults('not a search result')).toBeNull();
  });

  it('detects languages and filters source at minimal and aggressive levels', () => {
    const source = [
      "import { value } from './value.js';",
      '// implementation note',
      'function example() {',
      "  const text = '// not a comment';",
      '  return value + text;',
      '}',
    ].join('\n');

    expect(detectLanguage('component.TSX')).toBe('typescript');
    expect(detectLanguage('README')).toBe('unknown');
    expect(filterMinimal(source, 'typescript')).not.toContain('implementation note');
    expect(filterMinimal(source, 'typescript')).toContain('// not a comment');
    expect(filterAggressive(source, 'typescript')).toContain('function example() {');
    expect(filterAggressive(source, 'typescript')).not.toContain('return value');
  });

  it('applies smart line truncation and hard head-tail character truncation', () => {
    const source = Array.from({ length: 20 }, (_, index) => `const value${index} = ${index};`).join('\n');
    const compacted = smartTruncate(source, 6, 'typescript');
    expect(compacted.split('\n').length).toBeLessThanOrEqual(6);
    expect(compacted).toContain('more lines (total: 20)');
    expect(truncate('abcdefghij', 7)).toBe('abc...j');
    expect(truncate('abc', 2)).toBe('..');
    const result = truncateHeadTail('head\nmiddle one\nmiddle two\ntail', 28, {
      marker: (omitted) => `\n[${omitted} omitted]\n`,
    });
    expect(result.text).toContain('head\n');
    expect(result.text).toContain('tail');
    expect(result.text.length).toBeLessThanOrEqual(28);
    expect(result.omittedCharacters).toBeGreaterThan(0);
  });
});
